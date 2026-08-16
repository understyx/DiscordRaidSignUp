"""Utilities for normalising WoW class names entered by users."""

from __future__ import annotations

from bot.wow import CLASS_ALIASES, KNOWN_CLASSES

__all__ = ["KNOWN_CLASSES", "normalize_class"]


def normalize_class(raw: str) -> str:
    """Return the canonical WoW class name for *raw*, or title-case *raw* if unknown.

    Lookup is case-insensitive and ignores surrounding whitespace.
    """
    key = raw.strip().lower()
    return CLASS_ALIASES.get(key, raw.strip().title())
