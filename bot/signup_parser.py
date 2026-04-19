"""Text and gearscore parsing utilities for character sign-up messages."""

from __future__ import annotations

import re

from bot.class_utils import normalize_class, KNOWN_CLASSES

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Sentinel float value representing a "Best in Slot" gearscore.
BIS_GS = 99999.0

# Maximum number of random/invalid lines shown in a single rejection error.
MAX_RANDOM_LINES_IN_ERROR = 5

# Keywords that mark a text sign-up as tentative when placed on the first non-empty line.
TENTATIVE_KEYWORDS = frozenset({"tentative", "maybe"})

# Matches a potential character sign-up line.
# Name must be 1–12 letters, optionally preceded and/or followed by
# whitespace / saved (❌✗) or priority (⭐★) markers, then the first "/".
# Requires at least 4 slash-separated parts (name, class, spec, gs).
CHAR_LINE_RE = re.compile(
    r"^[⭐★❌✗]?\s*[A-Za-z]{1,12}\s*[⭐★❌✗]?\s*/.+/.+/.+",
    re.IGNORECASE,
)

# Validates a bare character name (after stripping markers): letters only, 1–12 chars.
_NAME_RE = re.compile(r"^[A-Za-z]{1,12}$")

# Matches a GS number (with optional k/K suffix) at the start of a segment,
# followed by optional whitespace and an optional trailing note.
_GS_NOTE_RE = re.compile(r"^([0-9]+(?:[.,][0-9]+)?[kK]?)\s*(.*)?$", re.DOTALL)


# ---------------------------------------------------------------------------
# GS parsing helpers
# ---------------------------------------------------------------------------

def format_gs(value: float) -> str:
    """Format a gearscore for display, returning ``"BiS"`` for the sentinel value."""
    if value >= BIS_GS:
        return "BiS"
    return f"{value:.0f}"


def parse_gs(raw: str) -> float:
    """Parse a gearscore string into a float.

    Accepts full numbers (``"6200"``), decimal shorthand (``"6.2"`` → 6200),
    the explicit *k* suffix (``"6.2k"`` → 6200), and ``"bis"`` (case-insensitive)
    for Best-in-Slot.  Values already in the thousands are returned unchanged.
    Any commas are treated as decimal separators (e.g. ``"6,2"`` → 6200).
    Values below 1000 are auto-scaled by 1000, so ``"999"`` → 999000 — use the
    full number for sub-1000 scores.
    """
    stripped = raw.strip()
    if stripped.lower() == "bis":
        return BIS_GS
    cleaned = stripped.replace(",", ".")
    if cleaned.lower().endswith("k"):
        return float(cleaned[:-1]) * 1000
    value = float(cleaned)
    if value < 1000:
        value *= 1000
    return value


def _parse_gs_and_note(gs_raw: str) -> tuple[float, str]:
    """Parse a GS segment, returning ``(gearscore, note)``.

    Star markers (⭐ ★) are stripped before parsing.  ``"bis"`` (case-insensitive)
    is accepted as a synonym for Best-in-Slot.  Any text that follows the numeric
    GS value (after stripping stars and whitespace) is returned as the note.
    Raises ``ValueError`` if no valid GS number is found.
    """
    cleaned = gs_raw.replace("⭐", "").replace("★", "").strip()
    if cleaned.lower() == "bis":
        return BIS_GS, ""
    m = _GS_NOTE_RE.match(cleaned)
    if not m:
        raise ValueError(f"Cannot parse GS from {gs_raw!r}")
    gs = parse_gs(m.group(1))
    note = (m.group(2) or "").strip()
    return gs, note


# ---------------------------------------------------------------------------
# Message classification helpers
# ---------------------------------------------------------------------------

def is_tentative_message(text: str) -> bool:
    """Return True if the first non-empty line of *text* is a tentative keyword."""
    for line in text.splitlines():
        stripped = line.strip().lower()
        if stripped:
            return stripped in TENTATIVE_KEYWORDS
    return False


def find_random_text_lines(text: str) -> list[str]:
    """
    Return a list of non-empty lines that are neither a leading tentative
    keyword nor a valid character sign-up line.

    Only call this when the message already contains at least one character
    line (detected via ``CHAR_LINE_RE``); the function is a no-op otherwise
    because the caller guards on that condition.

    Rules:
      - The *first* non-empty line may be a tentative keyword ("tentative" /
        "maybe") — it is allowed and excluded from the results.
      - Every other non-empty line must match ``CHAR_LINE_RE``.  Lines that
        do not match are returned as random-text offenders.
    """
    random_lines: list[str] = []
    first_non_empty_checked = False

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if not first_non_empty_checked:
            first_non_empty_checked = True
            if line.lower() in TENTATIVE_KEYWORDS:
                continue
        if not CHAR_LINE_RE.match(line):
            random_lines.append(line)

    return random_lines


# ---------------------------------------------------------------------------
# Character line parser
# ---------------------------------------------------------------------------

def parse_character_lines(text: str) -> tuple[list[dict], list[str]]:
    """
    Parse one or more character lines from a message body.

    Supported format (one per line)::

        CharName / CharClass / Spec1 / GS1 [/ Spec2 / GS2 ...] [⭐ or ❌]

    Priority (⭐ or ★) placement controls which specs are marked as priority:
      - ⭐ after a spec name (before the GS): only that spec is priority
        e.g. ``Shadow ⭐ / 6500 / Disc / 6300``  →  only Shadow is priority
      - ⭐ after the *last* GS (end of line): all specs for that character are priority
        e.g. ``Survival / 6500 / BM / 6400 ⭐``  →  both Survival and BM are priority
      - ⭐ after any middle GS: only that spec is priority

    ❌  = saved character (already saved this lockout)

    Returns ``(results, errors)`` where *results* is a list of dicts with keys:
        char_name, char_class, spec, gearscore, is_prio (bool), is_saved (bool), note (str)
    and *errors* is a list of human-readable rejection reasons.

    One dict is returned per spec/GS pair. Characters with multiple specs
    (e.g. Shadow/6500/Disc/6300) produce multiple dicts, one per spec.
    All dicts for the same character line share the same ``note`` value.
    """
    results = []
    errors = []
    seen: set[tuple[str, str]] = set()  # (char_name_lower, spec_lower)

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or not CHAR_LINE_RE.match(line):
            continue

        is_saved = "❌" in line or "✗" in line

        # Strip only saved markers before splitting; keep star markers in place
        # so we can detect per-spec priority later.
        clean = line.replace("❌", "").replace("✗", "").strip()

        parts = [p.strip() for p in clean.split("/")]
        # Need at least: CharName / CharClass / Spec / GS
        if len(parts) < 4:
            continue

        char_name = parts[0].replace("⭐", "").replace("★", "").strip()
        char_class_raw = parts[1].replace("⭐", "").replace("★", "").strip()
        if not char_name or not char_class_raw:
            continue

        # Strict name validation: letters only, 1–12 characters.
        if not _NAME_RE.match(char_name):
            errors.append(
                f"**{char_name}**: invalid character name — names must be 1–12 letters only (A–Z)."
            )
            continue

        # Class validation: must resolve to a known WoW class.
        char_class = normalize_class(char_class_raw)
        if char_class not in KNOWN_CLASSES:
            errors.append(
                f"**{char_name}**: unrecognised class `{char_class_raw}` — "
                f"valid classes are: {', '.join(sorted(KNOWN_CLASSES))}."
            )
            continue

        name_lower = char_name.lower()

        # Remaining parts alternate: spec, gs, spec, gs, …
        spec_gs = parts[2:]
        if len(spec_gs) < 2:
            errors.append(f"**{char_name}**: missing spec/GS data.")
            continue

        # ⭐ in the very last part (trailing star after final GS) means all specs
        # for this character are priority.
        last_has_star = "⭐" in spec_gs[-1] or "★" in spec_gs[-1]

        # Note for this line — accumulated from any GS segment that has trailing text.
        line_note = ""

        i = 0
        while i + 1 < len(spec_gs):
            spec_raw = spec_gs[i]
            gs_raw = spec_gs[i + 1]

            spec_has_star = "⭐" in spec_raw or "★" in spec_raw
            gs_has_star = "⭐" in gs_raw or "★" in gs_raw

            # This spec is priority if: line-level star (last GS), star in the
            # spec name segment, or star in this GS segment.
            spec_is_prio = last_has_star or spec_has_star or gs_has_star

            spec = spec_raw.replace("⭐", "").replace("★", "").strip()

            try:
                gs, segment_note = _parse_gs_and_note(gs_raw)
            except ValueError:
                errors.append(f"**{char_name}**: could not parse GS value from `{gs_raw.strip()}`.")
                i += 2
                continue

            if segment_note:
                line_note = segment_note

            if spec:
                key = (name_lower, spec.lower())
                if key not in seen:
                    seen.add(key)
                    results.append(
                        {
                            "char_name": char_name.capitalize(),
                            "char_class": char_class,
                            "spec": spec,
                            "gearscore": gs,
                            "is_prio": spec_is_prio,
                            "is_saved": is_saved,
                            "note": "",  # filled in after the loop
                        }
                    )
            i += 2

        # Back-fill the note for all entries produced by this line.
        if line_note:
            for entry in results:
                if entry["char_name"].lower() == name_lower and entry["note"] == "":
                    entry["note"] = line_note

    return results, errors
