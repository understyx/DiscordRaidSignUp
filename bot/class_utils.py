"""Utilities for normalising WoW class names entered by users."""

from __future__ import annotations

# All valid WoW (WotLK) class names in canonical form.
KNOWN_CLASSES: frozenset[str] = frozenset({
    "Death Knight",
    "Druid",
    "Hunter",
    "Mage",
    "Paladin",
    "Priest",
    "Rogue",
    "Shaman",
    "Warlock",
    "Warrior",
})

# Maps lower-cased aliases / common misspellings to the canonical class name.
CLASS_ALIASES: dict[str, str] = {
    # Death Knight
    "dk": "Death Knight",
    "deathknight": "Death Knight",
    "death knight": "Death Knight",
    # Druid
    "druid": "Druid",
    "dudu": "Druid",
    "drood": "Druid",
    "druide": "Druid",
    # Hunter
    "hunter": "Hunter",
    "hunt": "Hunter",
    "huntr": "Hunter",
    # Mage
    "mage": "Mage",
    "maje": "Mage",
    # Paladin
    "paladin": "Paladin",
    "pala": "Paladin",
    "pally": "Paladin",
    "pallie": "Paladin",
    "palladin": "Paladin",
    # Priest
    "priest": "Priest",
    "prst": "Priest",
    "preist": "Priest",
    # Rogue
    "rogue": "Rogue",
    "rouge": "Rogue",
    "rog": "Rogue",
    "roge": "Rogue",
    # Shaman
    "shaman": "Shaman",
    "sham": "Shaman",
    "shammy": "Shaman",
    "shamy": "Shaman",
    # Warlock
    "warlock": "Warlock",
    "lock": "Warlock",
    "wlock": "Warlock",
    "warlok": "Warlock",
    # Warrior
    "warrior": "Warrior",
    "war": "Warrior",
    "warr": "Warrior",
    "warior": "Warrior",
}


def normalize_class(raw: str) -> str:
    """Return the canonical WoW class name for *raw*, or title-case *raw* if unknown.

    Lookup is case-insensitive and ignores surrounding whitespace.
    """
    key = raw.strip().lower()
    return CLASS_ALIASES.get(key, raw.strip().title())
