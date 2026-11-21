"""Read a WCA registration export or a CSV with a selectable name column."""

import codecs
import csv
import io
import unicodedata
from pathlib import Path


_NAME_HEADERS = (
    "name", "full name", "competitor name", "competitor", "participant name",
    "participant", "фио", "ф.и.о.", "фамилия имя отчество", "имя фамилия",
    "фамилия имя", "полное имя", "имя участника", "участник", "имя", "аты-жөні",
)


def _decode(data: bytes) -> str:
    if data.startswith((codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)):
        encodings = ("utf-16",)
    else:
        encodings = ("utf-8-sig", "cp1251")
    for encoding in encodings:
        try:
            text = data.decode(encoding)
        except UnicodeDecodeError:
            continue
        if "\x00" not in text:
            return text
    raise ValueError("Не удалось прочитать текст. Сохраните файл как CSV в кодировке UTF-8.")


def _column_labels(header: list[str]) -> list[str]:
    labels = []
    seen = set()
    for index, cell in enumerate(header, start=1):
        base = cell.strip() or f"Столбец {index}"
        label = base
        suffix = 2
        while label in seen:
            label = f"{base} ({suffix})"
            suffix += 1
        labels.append(label)
        seen.add(label)
    return labels


def inspect_registration_csv(data: bytes, column: str | None = None) -> dict:
    """Return header labels, the chosen column, names in source order and blank count."""
    text = _decode(data).lstrip("\r\n")
    if not text.strip():
        raise ValueError("CSV-файл пуст.")
    # Some Excel exports specify their separator on a separate first line.
    first_line = text.splitlines()[0]
    if first_line.casefold() in ("sep=,", "sep=;", "sep=\t"):
        delimiter = first_line[-1]
        stream = io.StringIO(text, newline="")
        stream.readline()
    else:
        stream = io.StringIO(text, newline="")
        try:
            delimiter = csv.Sniffer().sniff(first_line, delimiters=",;\t").delimiter
        except csv.Error:
            delimiter = ","

    reader = csv.reader(stream, delimiter=delimiter, strict=True)
    try:
        header = next(reader, [])
        if not header:
            raise ValueError("В CSV-файле отсутствуют заголовки столбцов.")
        columns = _column_labels(header)
        if column:
            if column not in columns:
                raise ValueError("Выбранного столбца нет в CSV-файле.")
        else:
            normalized = {k.casefold(): k for k in columns}
            column = next((normalized[k] for k in _NAME_HEADERS if k in normalized), "")
            if len(columns) == 1:
                column = columns[0]

        result = {"columns": columns, "column": column, "names": [], "skipped": 0}
        if not column:
            return result
        index = columns.index(column)
        for row in reader:
            if not any(field.strip() for field in row):
                continue
            if len(row) != len(columns):
                raise ValueError(f"В строке {reader.line_num} число полей отличается от заголовка. Проверьте разделители и кавычки.")
            # A cell may span lines in a valid CSV. The certificate has one name line.
            name = unicodedata.normalize("NFC", " ".join(row[index].split()))
            if name:
                result["names"].append(name)
            else:
                result["skipped"] += 1
        return result
    except csv.Error as exc:
        raise ValueError(f"Ошибка CSV около строки {reader.line_num}. Проверьте разделители и кавычки.") from exc


def parse_registration_csv(data: bytes) -> list[str]:
    result = inspect_registration_csv(data)
    if not result["column"]:
        raise ValueError("Укажите столбец с именами участников.")
    if not result["names"]:
        raise ValueError("В столбце с именами нет заполненных строк.")
    return result["names"]


def read_registration_csv(path: str | Path) -> list[str]:
    return parse_registration_csv(Path(path).read_bytes())
