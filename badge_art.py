"""Badge artwork, typesetting and vector QR for any physical badge dimensions."""

import hashlib
from functools import lru_cache

from reportlab.graphics.barcode import qrencoder
from reportlab.lib.colors import HexColor

from pdf_engine import ASSET_DIR, _line, _measure, _runs


ROLE_COLORS = {
    "COMPETITOR": "#00863D",
    "DELEGATE": "#B53136",
    "ORGANIZER": "#204E9E",
    "GUEST": "#704888",
    "VOLUNTEER": "#A35312",
}


@lru_cache(maxsize=24)
def _qr_rows(url):
    """Select byte-mode capacity including the UTF-8 ECI designator where needed."""
    payload = url.encode("utf-8")
    utf8 = not url.isascii()
    level = qrencoder.QRErrorCorrectLevel.M
    for version in range(1, 41):
        available = sum(block.dataCount for block in qrencoder.QRRSBlock.getRSBlocks(version, level)) * 8
        needed = 4 + (8 if version < 10 else 16) + 8 * len(payload) + (12 if utf8 else 0)
        if needed <= available:
            break
    else:
        raise ValueError("Ссылка слишком длинная для QR-кода. Вставьте более короткую ссылку.")
    qr = qrencoder.QRCode(version, level)
    if utf8:
        qr.addData(qrencoder.QRECI(26))
    qr.addData(qrencoder.QR8bitByte(payload))
    qr.make()
    return qr.modules


def _qr(c, url, x, y, target_side, max_side):
    rows = _qr_rows(url)
    modules = len(rows)
    total = modules + 8  # Four unmarked modules on each side inside a white panel.
    # Expand dense codes into available space before reducing the printed module size.
    side = min(max_side, max(target_side, total * 0.35 * 72 / 25.4))
    form = "BadgeQR" + hashlib.sha256(url.encode("utf-8")).hexdigest()
    if not c.hasForm(form):
        c.beginForm(form, 0, 0, total, total)
        c.setFillColorRGB(1, 1, 1)
        c.rect(0, 0, total, total, stroke=0, fill=1)
        c.setFillColorRGB(0, 0, 0)
        path = c.beginPath()
        for row_index, row in enumerate(rows):
            start = None
            for column, dark in enumerate(row + [False]):
                if dark and start is None:
                    start = column
                elif not dark and start is not None:
                    path.rect(4 + start, 4 + modules - 1 - row_index, column - start, 1)
                    start = None
        c.drawPath(path, stroke=0, fill=1)
        c.endForm()
    c.saveState()
    c.translate(x, y)
    c.scale(side / total, side / total)
    c.doForm(form)
    c.restoreState()


def _ribbon(c, x, y, width, height, slant, color):
    ribbon = c.beginPath()
    ribbon.moveTo(x, y)
    ribbon.lineTo(x + width - slant, y)
    ribbon.lineTo(x + width, y + height)
    ribbon.lineTo(x, y + height)
    ribbon.close()
    c.setFillColor(HexColor(color))
    c.drawPath(ribbon, stroke=0, fill=1)


def _name_block(c, name, x, bottom, width, height, max_size):
    if not name.strip():
        return
    # Keep a parenthetical spelling on its own line when possible.
    groups = name.replace(" (", "\n(").splitlines()
    groups = [[(word, _measure(_runs(word, "BadgeName"), 1)) for word in group.split()] for group in groups]
    space = _measure(_runs(" ", "BadgeName"), 1)

    def wrap(size):
        lines = []
        for words in groups:
            line = []
            length = 0
            for word, advance in words:
                if advance * size > width:
                    return []
                if line and (length + space + advance) * size > width:
                    lines.append(" ".join(line))
                    line = []
                    length = 0
                length += (space if line else 0) + advance
                line.append(word)
            if line:
                lines.append(" ".join(line))
        return lines

    def used_height(lines, size):
        return (1.04 + 0.99 * (len(lines) - 1)) * size

    lo, hi = 0, max_size
    for _ in range(16):
        mid = (lo + hi) / 2
        lines = wrap(mid)
        if lines and used_height(lines, mid) <= height:
            lo = mid
        else:
            hi = mid
    lines = wrap(lo)
    baseline = bottom + (height + used_height(lines, lo)) / 2 - 0.82 * lo
    for value in lines:
        _line(c, value, x, baseline, width, lo, style="BadgeName", color="#0D429A")
        baseline -= 0.99 * lo


def draw_badge(c, x, y, width, height, title, date, name, role, url):
    """Draw inside the PDF rectangle (x, y, width, height), in points, bottom-left origin."""
    if role not in ROLE_COLORS:
        raise ValueError("Выберите статус для бейджа.")
    if width <= 0 or height <= 0:
        raise ValueError("Укажите положительные ширину и высоту бейджа.")
    landscape = width > height
    c.saveState()
    try:
        c.translate(x, y)
        clip = c.beginPath()
        clip.rect(0, 0, width, height)
        c.clipPath(clip, stroke=0, fill=0)
        c.linearGradient(0, 0, width, height, [HexColor("#E5F4F6"), HexColor("#FCFCFC")], extend=True)

        cubes_width = min(width, height * 0.83)
        c.drawImage(str(ASSET_DIR / "badge-cubes.png"), width - cubes_width, 0,
                    cubes_width, cubes_width * 546 / 1086, mask="auto")

        left = width * (0.06 if landscape else 0.09)
        logo_width = min(width * 0.146, height * (0.177 if landscape else 0.135))
        logo_x = left if landscape else left + width * 0.012
        logo_y = height * 0.952 - logo_width
        c.drawImage(str(ASSET_DIR / "badge-logo.png"), logo_x, logo_y,
                    logo_width, logo_width, mask="auto")
        separator_x = logo_x + logo_width * 1.17
        c.setStrokeColor(HexColor("#282935"))
        c.setLineWidth(logo_width * 0.018)
        c.line(separator_x, logo_y, separator_x, logo_y + logo_width * 0.94)

        title_x = separator_x + logo_width * 0.20
        title_width = width - title_x - left * 0.7
        _line(c, title, title_x, logo_y + logo_width * 0.45, title_width,
              logo_width * 0.49, style="Title", color="#24232A")
        date_h = logo_width * 0.32
        date_w = min(title_width, max(logo_width * 2.32, _measure(_runs(date), date_h * 0.87) + date_h))
        _ribbon(c, title_x, logo_y, date_w, date_h, min(date_w * 0.11, date_h * 0.68), "#E52522")
        _line(c, date, title_x + date_w * 0.47, logo_y + date_h * 0.22,
              date_w * 0.82, date_h * 0.86, color="#FFFFFF", center=True)

        band_h = min(height * (0.102 if landscape else 0.077), width * 0.12)
        band_bottom = height * (0.315 if landscape else 0.464)
        upper = min(logo_y - height * 0.02, height * (0.75 if landscape else 0.80))
        lower = band_bottom + band_h + height * (0.02 if landscape else 0.025)
        _name_block(c, name, left, lower, width - left * 1.8, upper - lower,
                    min(height * (0.169 if landscape else 0.12), width * 0.175))
        label_size = band_h * 0.70
        band_w = min(width - 1.6 * left, max(width * (0.34 if landscape else 0.596),
                     _measure(_runs(role, "BadgeName"), label_size) + band_h * 1.28))
        slant = min(band_h * 0.61, band_w * 0.15)
        _ribbon(c, left, band_bottom, band_w, band_h, slant, ROLE_COLORS[role])
        _line(c, role, left + (band_w - slant * 0.55) / 2, band_bottom + band_h * 0.25,
              band_w - slant - band_h * 0.33, label_size, style="BadgeName", color="#FFFFFF", center=True)
        if url:
            qr_x = width * (0.059 if landscape else 0.078)
            qr_y = height * (0.035 if landscape else 0.253)
            side = min(width * 0.228, height * (0.247 if landscape else 0.182))
            max_side = min(width * 0.39, band_bottom - qr_y - height * 0.012)
            _qr(c, url, qr_x, qr_y, side, max_side)
    finally:
        c.restoreState()
