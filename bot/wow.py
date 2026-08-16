"""Canonical WotLK class, spec, role, and realm data."""

from __future__ import annotations

import json
from pathlib import Path

_DATA_PATH = Path(__file__).resolve().parents[1] / "shared" / "wow.json"
WOW_DATA: dict = json.loads(_DATA_PATH.read_text(encoding="utf-8"))
WOW_CLASSES: dict[str, dict] = WOW_DATA["classes"]
KNOWN_CLASSES: frozenset[str] = frozenset(WOW_CLASSES)
REALMS: tuple[str, ...] = tuple(WOW_DATA["realms"])

CLASS_ALIASES: dict[str, str] = {
    alias.lower(): canonical
    for canonical, class_data in WOW_CLASSES.items()
    for alias in {canonical, *class_data["aliases"]}
}

CLASS_SPEC_ROLES: dict[tuple[str, str], str] = {
    (class_name, spec_name): spec_data["role"]
    for class_name, class_data in WOW_CLASSES.items()
    for spec_name, spec_data in class_data["specs"].items()
}


def classes_and_specs() -> list[tuple[str, list[str]]]:
    return [
        (class_name, list(class_data["specs"])) for class_name, class_data in WOW_CLASSES.items()
    ]
