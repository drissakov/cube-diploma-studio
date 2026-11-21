"""WCA Regulation 9b, current on 2026-11-21. Keys are WCA event IDs."""

import json
from pathlib import Path

WCA_REGULATIONS = "https://www.worldcubeassociation.org/regulations/#9b"
# FTO becomes eligible on 2027-01-02.
# https://www.worldcubeassociation.org/posts/changes-to-the-wca-s-list-of-official-events-june-2026
_catalog = json.loads((Path(__file__).parent / "assets" / "events.json").read_text(encoding="utf-8"))
EVENTS = {item["id"]: item["name"] for item in _catalog}
EVENT_NAMES_RU = {item["id"]: item["label"] for item in _catalog}
