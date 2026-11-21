"""Build A4 certificates on the supplied vector artwork, with shared PDF resources."""

import base64
import binascii
import os
import tempfile
import threading
import unicodedata
from functools import lru_cache
from io import BytesIO
from pathlib import Path
from xml.sax.saxutils import escape

from PIL import Image, ImageChops, ImageOps
from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, DecodedStreamObject, DictionaryObject, NameObject, NumberObject
from reportlab.lib.colors import HexColor
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph


ASSET_DIR = Path(__file__).resolve().parent / "assets"
PAGE_SIZES = {"participation": (841.89, 595.276), "podium": (841.92, 595.32)}
INK = "#231F20"
GREENS = ("#009B53", "#3EA94F", "#00A258")
PLACE_STYLES = {1: ("1st", "#8A6511"), 2: ("2nd", "#526474"), 3: ("3rd", "#93532C")}
# ReportLab's dynamically subset fonts track state per document. Serialize builds
# so that a preview and an export cannot mutate font registration concurrently.
_BUILD_LOCK = threading.Lock()
_FONT_FILES = {
    "Title": ("impact.ttf", "arialbd.ttf"),
    "Body": ("calibrib.ttf", "segoeuib.ttf", "arialbd.ttf"),
    "Sans": ("arialbd.ttf", "tahomabd.ttf"),
    "BadgeName": ("seguibl.ttf", "ariblk.ttf", "arialbd.ttf"),
    "Chinese": ("msyhbd.ttc", "msyh.ttc", "simsun.ttc"),
    "Japanese": ("msgothic.ttc", "meiryo.ttc"),
    "Korean": ("malgunbd.ttf", "malgun.ttf"),
    "Symbols": ("seguisym.ttf", "segoeui.ttf"),
}


@lru_cache(maxsize=None)
def _font(style):
    folder = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts"
    for filename in _FONT_FILES[style]:
        path = folder / filename
        if path.is_file():
            font = TTFont("Diploma" + style, str(path))
            pdfmetrics.registerFont(font)
            return font
    if style == "Body":
        # Also makes the source version usable with ReportLab on non-Windows hosts.
        import reportlab
        font = TTFont("DiplomaBody", str(Path(reportlab.__file__).parent / "fonts" / "VeraBd.ttf"))
        pdfmetrics.registerFont(font)
        return font
    return None


def _clean(value):
    if value is None:
        return ""
    return unicodedata.normalize("NFC", " ".join(str(value).split()))


@lru_cache(maxsize=8192)
def _glyph_face(style, char):
    for face_style in dict.fromkeys((style, "Body", "Sans", "Chinese", "Japanese", "Korean", "Symbols")):
        face = _font(face_style)
        if face and face.face.charToGlyph.get(ord(char)):
            return face.fontName
    raise ValueError(f"В установленных шрифтах нет символа {char!r} (U+{ord(char):04X}).")


def _runs(value, style="Body"):
    result = []
    for char in value:
        face = _glyph_face(style, char)
        if result and result[-1][0] == face:
            result[-1][1] += char
        else:
            result.append([face, char])
    return result


def _measure(parts, size):
    return sum(pdfmetrics.stringWidth(text, face, size) for face, text in parts)


def _line(c, value, x, y, max_width, size, *, style="Body", color=INK, center=False):
    if not value:
        return
    parts = _runs(value, style)
    width = _measure(parts, size)
    size *= min(1.0, max_width / max(width, 0.01))
    if center:
        x -= _measure(parts, size) / 2
    text = c.beginText(x, y)
    text.setFillColor(HexColor(color))
    for face, piece in parts:
        text.setFont(face, size)
        text.textOut(piece)
    c.drawText(text)


def _rich(value, color=INK):
    return "".join(
        f'<font name="{face}" color="{color}">{escape(piece)}</font>'
        for face, piece in _runs(value)
    )


def _name_list(entries):
    values = [_rich(person["name"], GREENS[i % len(GREENS)]) for i, person in entries]
    if len(values) < 2:
        return "".join(values)
    return _rich(", ").join(values[:-1]) + _rich(" and ") + values[-1]


def _intro(title, organizers):
    delegates = [(i, p) for i, p in enumerate(organizers) if p["role"] == "wca"]
    team = [(i, p) for i, p in enumerate(organizers) if p["role"] != "wca"]
    verb = "certifies that:" if len(organizers) < 2 else "certify that:"
    if not organizers:
        return _rich(f"The organizing team of {title} {verb}")
    if delegates and team:
        return (
            _name_list(delegates) + _rich(" on behalf of WCA, and ") + _name_list(team)
            + _rich(",") + "<br/>" + _rich(f"on behalf of the organizing team of {title},")
            + "<br/>" + _rich(verb)
        )
    if delegates:
        return _name_list(delegates) + _rich(f", on behalf of WCA at {title}, {verb}")
    return _name_list(team) + _rich(f", on behalf of the organizing team of {title}, {verb}")


def _paragraph(markup, width, max_height, size, leading):
    while size >= 7:
        style = ParagraphStyle("certificate", fontName=_font("Body").fontName,
                               fontSize=size, leading=size * leading, textColor=HexColor(INK),
                               spaceBefore=0, spaceAfter=0, splitLongWords=1)
        paragraph = Paragraph(markup, style)
        _, height = paragraph.wrap(width, max_height)
        if height <= max_height:
            return paragraph, height
        size -= 0.5
    raise ValueError("Текст слишком длинный для шаблона. Сократите название или имена организаторов.")


def _signature(value):
    if not value:
        return None
    if isinstance(value, str) and value.startswith("data:"):
        try:
            header, content = value.split(",", 1)
            if not header.startswith("data:image/") or not header.endswith(";base64"):
                raise ValueError
            value = base64.b64decode(content, validate=True)
        except (ValueError, binascii.Error) as exc:
            raise ValueError("Некорректные данные изображения подписи.") from exc
    source = BytesIO(value) if isinstance(value, (bytes, bytearray)) else value
    with Image.open(source) as original:
        if original.width * original.height > 50_000_000:
            raise ValueError("Размер изображения подписи превышает 50 мегапикселей.")
        img = ImageOps.exif_transpose(original).convert("RGBA")
    img.thumbnail((1000, 1000), Image.Resampling.LANCZOS)
    # Paper or a white JPEG surround should not cover the original gradient.
    r, g, b, alpha = img.split()
    darkest = ImageChops.darker(ImageChops.darker(r, g), b)
    ink = darkest.point(lambda v: 0 if v >= 248 else 255)
    alpha = ImageChops.multiply(alpha, ink)
    crop = alpha.getbbox()
    if crop is None:
        raise ValueError("Изображение подписи пустое. Выберите подпись с видимыми штрихами.")
    img.putalpha(alpha)
    return ImageReader(img.crop(crop))


def _organizers(settings):
    result = []
    for entry in settings.get("organizers", []):
        name = _clean(entry.get("name"))
        if name:
            result.append({"name": name, "role": entry.get("role", "organizer"),
                           "signature": _signature(entry.get("signature"))})
    if len(result) > 5:
        raise ValueError("Шаблон вмещает до пяти организаторов.")
    return result


def _draw_shared(c, height, title, date, organizers, intro, kind):
    _line(c, title, 111.5, height - 47.6, 672, 24.5, style="Title")
    left, top = 111.9, height - 57.8
    date_width = min(335, max(95, _measure(_runs(date), 10.5) + 19))
    tag = c.beginPath()
    tag.moveTo(left, top)
    tag.lineTo(left + date_width, top)
    tag.lineTo(left + date_width, top - 10.5)
    tag.lineTo(left + date_width - 3.0, top - 13.6)
    tag.lineTo(left, top - 13.6)
    tag.close()
    c.setFillColor(HexColor("#EB3B37" if kind == "podium" else "#EF2925"))
    c.drawPath(tag, fill=1, stroke=0)
    _line(c, date, left + date_width / 2, top - 9.8, date_width - 9, 10.5,
          color="#FFFFFF", center=True)
    para, para_height = intro
    para.drawOn(c, 48.7, height - 185.1 - para_height)
    for i, org in enumerate(organizers):
        baseline = 451.0 + i * 40.8 if len(organizers) <= 3 else 435 + 105 * i / (len(organizers) - 1)
        _line(c, org["name"], 158, height - baseline, 158, 17, color=GREENS[i % len(GREENS)])
        if org["signature"]:
            max_height = 32 if len(organizers) <= 3 else 22
            c.drawImage(org["signature"], 48, height - baseline + 5 - max_height / 2,
                        width=96, height=max_height, preserveAspectRatio=True,
                        mask="auto", anchor="c")


def _draw_podium(c, page, height):
    try:
        ordinal, color = PLACE_STYLES[int(page.get("place", 0))]
    except (ValueError, KeyError, TypeError) as exc:
        raise ValueError("Для призового диплома нужно место 1, 2 или 3.") from exc
    event = _clean(page.get("event"))
    if not event:
        raise ValueError("Выберите дисциплину для призового диплома.")
    sentence = (_rich("has placed ") + _rich(ordinal, color) + _rich(" in ")
                + _rich(event) + _rich(" with the result of"))
    para, h = _paragraph(sentence, 718, 44, 21, 1.11)
    para.drawOn(c, 48.6, height - 318 - h)
    _line(c, _clean(page.get("result")), 292, height - 389.5, 467, 27, center=True)


def _background(writer, kind):
    source = PdfReader(ASSET_DIR / (kind + ".pdf")).pages[0]
    form = DecodedStreamObject()
    form.set_data(source.get_contents().get_data())
    form = form.flate_encode()
    form.update({
        NameObject("/Type"): NameObject("/XObject"),
        NameObject("/Subtype"): NameObject("/Form"),
        NameObject("/FormType"): NumberObject(1),
        NameObject("/BBox"): source.mediabox,
        NameObject("/Resources"): source["/Resources"].clone(writer),
    })
    return writer._add_object(form)


def pdf_bytes(settings, pages):
    """Return one multi-page PDF. Pages are rendered in the caller's order."""
    pages = list(pages)
    if not pages:
        raise ValueError("Для экспорта нужна хотя бы одна страница.")
    with _BUILD_LOCK:
        return _build_pdf(settings, pages)


def _build_pdf(settings, pages):
    title, date = _clean(settings.get("title")), _clean(settings.get("date"))
    if not title or not date:
        raise ValueError("Укажите название и дату соревнования.")
    organizers = _organizers(settings)
    intro = _paragraph(_intro(title, organizers), 732, 82, 23.0, 1.18)
    overlay = BytesIO()
    c = canvas.Canvas(overlay, pagesize=PAGE_SIZES["participation"], pageCompression=1,
                      initialFontName=_font("Body").fontName)
    c.setTitle(title)
    for page in pages:
        kind = page.get("kind")
        if kind not in PAGE_SIZES:
            raise ValueError("Неизвестный тип диплома.")
        size = PAGE_SIZES[kind]
        c.setPageSize(size)
        height = size[1]
        _draw_shared(c, height, title, date, organizers, intro, kind)
        name = _clean(page.get("name"))
        baseline = 315 if kind == "participation" else 302
        _line(c, name, 410, height - baseline, 700, 31, center=True)
        if kind == "podium":
            _draw_podium(c, page, height)
        c.showPage()
    c.save()

    writer = PdfWriter()
    writer.add_metadata({"/Title": title, "/Producer": "Diploma Studio"})
    backgrounds = {kind: _background(writer, kind) for kind in {p["kind"] for p in pages}}
    prelude = DecodedStreamObject()
    prelude.set_data(b"q /CertificateTemplate Do Q\n")
    prelude_ref = writer._add_object(prelude)
    text_pages = PdfReader(overlay)
    for recipe, source in zip(pages, text_pages.pages):
        page = writer.add_page(source)
        resources = page["/Resources"]
        objects = resources.get("/XObject")
        if objects is None:
            objects = DictionaryObject()
            resources[NameObject("/XObject")] = objects
        objects.get_object()[NameObject("/CertificateTemplate")] = backgrounds[recipe["kind"]]
        page[NameObject("/Contents")] = ArrayObject([prelude_ref, page.raw_get("/Contents")])
    out = BytesIO()
    writer.write(out)
    return out.getvalue()


def render_pdf(path, settings, pages):
    """Write atomically, also when updating an existing PDF."""
    data = pdf_bytes(settings, pages)
    path = Path(path)
    staging = tempfile.NamedTemporaryFile(dir=path.parent, prefix=".diploma-", suffix=".tmp", delete=False)
    try:
        with staging:
            staging.write(data)
        os.replace(staging.name, path)
    finally:
        Path(staging.name).unlink(missing_ok=True)
