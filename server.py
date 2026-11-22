"""Local Windows launcher and HTTP API for the certificate editor."""

import argparse
import base64
import binascii
import hashlib
import hmac
import io
import json
import logging
import os
import secrets
import sys
import tempfile
import threading
import time
import webbrowser
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import ProxyHandler, build_opener

import pypdfium2 as pdfium
from PIL import Image, UnidentifiedImageError

from badge_art import ROLE_COLORS
from badge_sheets import badges_pdf, layout_info
from events import EVENTS, EVENT_NAMES_RU
from pdf_engine import pdf_bytes
from registrations import inspect_registration_csv


APP_DIR = Path(__file__).resolve().parent
STUDIO_VERSION = "2.1"
BADGE_DIMENSIONS = {"badgeWidth": 75, "badgeHeight": 100, "badgeMargin": 5, "badgeGap": 0}
DEFAULTS = {
    "title": "Haileybury Astana Open 2026",
    "date": "April 26",
    "organizers": [
        {"name": "Damir Zhanataev", "role": "wca"},
        {"name": "Damir Issakov", "role": "wca"},
        {"name": "Yerassyl Baigozha", "role": "organizer"},
    ],
}
LIMIT = 40 * 1024 * 1024
RENDER_LOCK = threading.Lock()


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def atomic_json(path, value):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
        temp_path = Path(handle.name)
        try:
            handle.write(json_bytes(value))
        except BaseException:
            handle.close()
            temp_path.unlink(missing_ok=True)
            raise
    try:
        temp_path.replace(path)
    finally:
        temp_path.unlink(missing_ok=True)


def read_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, UnicodeError, json.JSONDecodeError):
        return None


def short_text(value, limit=500):
    if not isinstance(value, str) or len(value) > limit:
        raise ValueError(f"Введите текст длиной до {limit} символов.")
    return " ".join(value.split())


def file_bytes(value, limit):
    if not isinstance(value, str) or len(value) > (limit + 2) // 3 * 4 + 100:
        raise ValueError("Размер файла превышает допустимый.")
    if value.startswith("data:"):
        value = value.partition(",")[2]
    try:
        raw = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise ValueError("Не удалось прочитать файл. Выберите его ещё раз.") from exc
    if len(raw) > limit:
        raise ValueError("Размер файла превышает допустимый.")
    return raw


def signature_bytes(value):
    raw = file_bytes(value, 5 * 1024 * 1024)
    try:
        with Image.open(io.BytesIO(raw)) as img:
            if img.format not in {"PNG", "JPEG"}:
                raise ValueError("Выберите подпись в формате PNG или JPEG.")
            if img.width * img.height > 24000000:
                raise ValueError("Уменьшите изображение подписи до 24 мегапикселей.")
            img.verify()
    except (OSError, SyntaxError, Image.DecompressionBombError, UnidentifiedImageError) as exc:
        raise ValueError("Не удалось открыть изображение подписи.") from exc
    return raw


def tier_entries(values, event):
    if not isinstance(values, dict):
        raise ValueError("Проверьте данные призёров.")
    items = values.get(event, [])
    if not isinstance(items, list) or len(items) > 3:
        raise ValueError("В дисциплине должно быть три призовых места.")
    return [short_text(item) for item in items] + [""] * (3 - len(items))


def competition_details(data, preview):
    title = short_text(data.get("title", ""))
    date = short_text(data.get("date", ""))
    if not preview and (not title or not date):
        raise ValueError("Укажите название и дату соревнований.")
    return {"title": title or "Competition", "date": date or "—"}


def prepare_document(data, preview):
    settings = competition_details(data, preview)
    people = data.get("organizers", [])
    if not isinstance(people, list) or len(people) > 5:
        raise ValueError("В шаблоне помещается до пяти организаторов.")
    organizers = []
    for person in people:
        if not isinstance(person, dict) or person.get("role") not in {"wca", "organizer"}:
            raise ValueError("Выберите роль организатора.")
        name = short_text(person.get("name", ""))
        if not name:
            if person.get("signature") and not preview:
                raise ValueError("Укажите имя организатора для загруженной подписи.")
            continue
        signature = signature_bytes(person["signature"]) if person.get("signature") else None
        organizers.append({"name": name, "role": person["role"], "signature": signature})
    settings["organizers"] = organizers
    mode = data.get("mode")
    if mode in ("participation", "volunteers"):
        kind = "volunteer" if mode == "volunteers" else "participation"
        roster = "волонтёров" if mode == "volunteers" else "участников"
        names = data.get("names", [])
        if not isinstance(names, list):
            raise ValueError(f"Проверьте список {roster}.")
        pages = [{"kind": kind, "name": short_text(name)} for name in names]
        if any(not page["name"] for page in pages):
            raise ValueError(f"В списке {roster} есть пустое имя.")
        if not pages:
            if not preview:
                raise ValueError(f"Добавьте имена {roster} вручную или загрузите CSV.")
            pages = [{"kind": kind, "name": ""}]
    elif mode == "awards":
        ids = data.get("events", [])
        if not isinstance(ids, list) or any(not isinstance(key, str) or key not in EVENTS for key in ids):
            raise ValueError("Проверьте выбранные дисциплины.")
        if not ids and not preview:
            raise ValueError("Выберите хотя бы одну дисциплину.")
        pages = []
        for key in dict.fromkeys(ids or ["333"]):
            winners = tier_entries(data.get("winners", {}), key)
            results = tier_entries(data.get("results", {}), key)
            for i, (name, result) in enumerate(zip(winners, results), 1):
                pages.append({"kind": "podium", "name": name, "result": result,
                              "event": EVENTS[key], "place": i})
    else:
        raise ValueError("Выберите тип документа.")
    if preview:
        index = data.get("page", 0)
        if type(index) is not int or not (0 <= index < len(pages)):
            raise ValueError("Страница отсутствует.")
        pages = [pages[index]]
    return settings, pages


def badge_dimensions(data):
    return tuple(data.get(key, default) for key, default in BADGE_DIMENSIONS.items())


def badge_link(value):
    if not isinstance(value, str):
        raise ValueError("Введите ссылку для QR-кода.")
    url = value.strip()
    if not url:
        return ""
    if any(char.isspace() or ord(char) < 32 for char in url):
        raise ValueError("Уберите пробелы и переносы строк из ссылки.")
    try:
        if "://" not in url:
            # Accept a hostname, optionally followed by a numeric port and path.
            authority = url.removeprefix("//").split("/", 1)[0].split("?", 1)[0].split("#", 1)[0]
            if "@" in authority:
                raise ValueError
            url = "https://" + url.removeprefix("//")
        parsed = urlsplit(url)
        valid = parsed.scheme in {"http", "https"} and bool(parsed.hostname)
        parsed.port  # Validate an explicitly specified port, if present.
    except ValueError:
        valid = False
    if not valid:
        raise ValueError("Укажите веб-ссылку, например https://example.org.")
    return url


def make_badges(data, preview):
    settings = competition_details(data, preview)
    source = data.get("badgePeople", [])
    if not isinstance(source, list):
        raise ValueError("Проверьте список людей для бейджей.")
    people = []
    for entry in source:
        if not isinstance(entry, dict):
            raise ValueError("Проверьте строку в списке людей.")
        name = short_text(entry.get("name", ""))
        role = entry.get("role", "COMPETITOR")
        if not isinstance(role, str) or role not in ROLE_COLORS:
            raise ValueError("Выберите один из пяти статусов для каждого человека.")
        if not name and not preview:
            raise ValueError("В списке бейджей есть пустое имя. Заполните или удалите строку.")
        people.append({"name": name or "Имя Фамилия", "role": role})
    if not people:
        if not preview:
            raise ValueError("Добавьте человека вручную или загрузите CSV для бейджей.")
        people.append({"name": "Имя Фамилия", "role": "COMPETITOR"})
    page = data.get("page", 0) if preview else None
    if preview and (type(page) is not int or page < 0):
        raise ValueError("Выберите существующий лист.")
    url = badge_link(data.get("badgeUrl", ""))
    return badges_pdf(settings, people, *badge_dimensions(data), url=url, page=page)


def make_document(data, preview):
    # ReportLab's registered fonts and PDFium share process-global state.
    with RENDER_LOCK:
        if data.get("mode") == "badges":
            document = make_badges(data, preview)
        else:
            settings, pages = prepare_document(data, preview)
            document = pdf_bytes(settings, pages)
        if not preview:
            return document
        with pdfium.PdfDocument(document) as pdf:
            page = pdf[0]
            bitmap = page.render(scale=1.65)
            try:
                buffer = io.BytesIO()
                bitmap.to_pil().save(buffer, format="PNG")
                return buffer.getvalue()
            finally:
                bitmap.close()
                page.close()


class EditorServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port, state_dir):
        super().__init__(("127.0.0.1", port), EditorHandler)
        self.address = f"127.0.0.1:{self.server_port}"
        self.origin = f"http://{self.address}"
        self.token = secrets.token_urlsafe(32)
        self.cookie_name = f"awardstudio_{self.server_port}"
        self.session_lock = threading.Lock()
        self.state_dir = state_dir
        self.tabs = {}
        self.last_activity = time.monotonic()
        self.close_at = None

    def pulse(self, data):
        tab = short_text(data.get("tab", ""), 80)
        with self.session_lock:
            now = time.monotonic()
            self.last_activity = now
            if data.get("closed"):
                self.tabs.pop(tab, None)
                if not self.tabs:
                    self.close_at = now + 18
            else:
                self.tabs[tab] = now
                self.close_at = None

    def service_actions(self):
        now = time.monotonic()
        with self.session_lock:
            expired = self.close_at is not None and now > self.close_at
            abandoned = now - self.last_activity > (86400 if self.tabs else 900)
        if (expired or abandoned) and not RENDER_LOCK.locked():
            self.close_at = None
            self.last_activity = now
            threading.Thread(target=self.shutdown, daemon=True).start()


class EditorHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # Do not log launch tokens, names, or form contents.
        pass

    def reply(self, status, content=b"", mime="application/json; charset=utf-8", headers=()):
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'")
        for key, value in headers:
            self.send_header(key, value)
        self.end_headers()
        if content:
            self.wfile.write(content)

    def json_reply(self, obj, status=200):
        self.reply(status, json_bytes(obj))

    def host_ok(self):
        return self.headers.get("Host") == self.server.address

    def permitted(self):
        if not self.host_ok():
            return False
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
            supplied = cookie[self.server.cookie_name].value
        except (CookieError, KeyError, ValueError):
            return False
        return secrets.compare_digest(supplied, self.server.token)

    def do_GET(self):
        path = urlsplit(self.path).path
        if not self.host_ok():
            self.json_reply({"error": "Неизвестный адрес приложения."}, 403)
            return
        if path == "/api/identity":
            self.json_reply({"proof": hashlib.sha256(self.server.token.encode()).hexdigest(),
                             "version": STUDIO_VERSION})
            return
        if path.startswith("/open/") and hmac.compare_digest(path[6:], self.server.token):
            self.server.last_activity = time.monotonic()
            self.server.close_at = None
            cookie = f"{self.server.cookie_name}={self.server.token}; Path=/; HttpOnly; SameSite=Strict"
            self.reply(303, headers=(("Set-Cookie", cookie), ("Location", "/")))
            return
        if not self.permitted():
            self.json_reply({"error": "Откройте редактор через приложение «Студия дипломов»."}, 403)
            return
        if path == "/api/bootstrap":
            with self.server.session_lock:
                # The original release can still be open and writes its older schema.
                # Seed the updated editor from that draft until it saves its own.
                draft_path = self.server.state_dir / "draft-v2.json"
                if not draft_path.exists():
                    draft_path = self.server.state_dir / "draft.json"
                draft = read_json(draft_path)
            self.json_reply({"defaults": {**DEFAULTS, **BADGE_DIMENSIONS}, "draft": draft,
                             "events": [{"id": key, "name": name, "label": EVENT_NAMES_RU[key]}
                                        for key, name in EVENTS.items()]})
            return
        # Serve files only from the bundled web directory.
        root = (APP_DIR / "web").resolve()
        parts = (path[1:] or "index.html").split("/")
        if any(not p or p in {".", ".."} or "\\" in p or ":" in p for p in parts):
            self.json_reply({"error": "Файл отсутствует."}, 404)
            return
        asset = root.joinpath(*parts).resolve()
        mime = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
                ".js": "text/javascript; charset=utf-8", ".png": "image/png",
                ".ico": "image/x-icon", ".woff2": "font/woff2", ".svg": "image/svg+xml"}
        if asset.is_relative_to(root) and asset.suffix in mime and asset.is_file():
            self.reply(200, asset.read_bytes(), mime[asset.suffix])
        else:
            self.json_reply({"error": "Файл отсутствует."}, 404)

    def do_POST(self):
        try:
            self.process_post()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            return
        except (ValueError, TypeError) as exc:
            self.json_reply({"error": str(exc)}, 400)
        except Exception:
            logging.exception("Local request failed")
            self.json_reply({"error": "Не удалось завершить операцию. Подробности записаны в журнал приложения."}, 500)

    def process_post(self):
        origin = self.headers.get("Origin")
        if not self.permitted() or (origin and origin != self.server.origin):
            self.json_reply({"error": "Откройте редактор через приложение «Студия дипломов»."}, 403)
            return
        if self.headers.get_content_type() != "application/json":
            self.json_reply({"error": "Неизвестный формат запроса."}, 415)
            return
        size = int(self.headers.get("Content-Length", 0))
        if not 0 < size <= LIMIT:
            self.json_reply({"error": "Превышен допустимый размер загрузки."}, 413)
            return
        payload = json.loads(self.rfile.read(size).decode("utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("Неизвестный формат данных.")
        self.server.last_activity = time.monotonic()
        if self.path == "/api/session":
            self.server.pulse(payload)
            self.json_reply({"ok": True})
        elif self.path == "/api/import":
            result = inspect_registration_csv(file_bytes(payload.get("file"), 15 * 1024 * 1024),
                                              payload.get("column"))
            self.json_reply(result)
        elif self.path == "/api/draft":
            with self.server.session_lock:
                atomic_json(self.server.state_dir / "draft-v2.json", payload)
            self.json_reply({"ok": True})
        elif self.path == "/api/badge-layout":
            self.json_reply(layout_info(*badge_dimensions(payload)))
        elif self.path == "/api/preview":
            self.reply(200, make_document(payload, True), "image/png")
        elif self.path == "/api/export":
            document = make_document(payload, False)
            filename = {"badges": "badges.pdf", "volunteers": "volunteers.pdf"}.get(payload.get("mode"), "certificates.pdf")
            self.reply(200, document, "application/pdf",
                       (("Content-Disposition", f'attachment; filename="{filename}"'),))
        else:
            self.json_reply({"error": "Неизвестная операция."}, 404)


def previous_session(path):
    saved = read_json(path)
    if not isinstance(saved, dict):
        return None
    port, token = saved.get("port"), saved.get("token")
    if type(port) is not int or not isinstance(token, str):
        return None
    address = f"http://127.0.0.1:{port}"
    try:
        with build_opener(ProxyHandler({})).open(address + "/api/identity", timeout=.5) as response:
            identity = json.loads(response.read(500))
        proof = identity.get("proof", "")
        if identity.get("version") == STUDIO_VERSION and hmac.compare_digest(proof, hashlib.sha256(token.encode()).hexdigest()):
            return f"{address}/open/{token}"
    except (OSError, ValueError):
        pass
    return None


def main():
    parser = argparse.ArgumentParser(description="CubeDiploma — редактор сертификатов")
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--state-dir", type=Path)
    args = parser.parse_args()
    state_dir = args.state_dir or Path(os.environ.get("LOCALAPPDATA", Path.home())) / "CubeDiploma"
    state_dir.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(filename=state_dir / "application.log", encoding="utf-8", level=logging.WARNING)
    connection_file = state_dir / "session.json"
    if not args.no_browser:
        url = previous_session(connection_file)
        if url and webbrowser.open(url):
            return
    with EditorServer(args.port, state_dir) as server:
        atomic_json(connection_file, {"port": server.server_port, "token": server.token})
        try:
            if not args.no_browser and not webbrowser.open(f"{server.origin}/open/{server.token}"):
                raise RuntimeError("Windows не смогла открыть браузер по умолчанию.")
            server.serve_forever()
        finally:
            saved = read_json(connection_file) or {}
            if saved.get("token") == server.token:
                connection_file.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        logging.exception("Startup failed")
        if getattr(sys, "frozen", False) and os.name == "nt":
            import ctypes
            ctypes.windll.user32.MessageBoxW(0, str(exc), "CubeDiploma", 0x10)
        else:
            raise
