from __future__ import annotations

from .parser import format_gs


def _chars_to_dicts(characters) -> list[dict]:
    """Serialize Character ORM objects to plain dicts (safe to use after session close)."""
    return [
        {
            "id": c.id,
            "char_name": c.char_name,
            "realm": c.realm,
            "char_class": c.char_class,
            "spec": c.spec,
            "gearscore": c.gearscore or 0.0,
        }
        for c in characters
    ]


def _char_display_description(char: dict) -> str:
    """Return a short spec/class/GS description string for a character dict."""
    spec_or_class = char["spec"] if char["spec"] else (char["char_class"] or "?")
    return f"{spec_or_class} – GS {format_gs(char['gearscore'])}"


def _char_label(char: dict) -> str:
    """Return 'CharName (Spec)' when a spec is present, otherwise just 'CharName'."""
    if char.get("spec"):
        return f"{char['char_name']} ({char['spec']})"
    return char["char_name"]


def _group_chars_by_name(char_dicts: list[dict]) -> list[dict]:
    """
    Group per-spec character rows by character name.

    Each unique char_name becomes one group dict with:
        id         – primary character ID (row with the highest gearscore)
        char_name  – character name
        realm      – realm name
        char_class – class string
        spec       – primary spec name (highest GS), or None if no specs
        gearscore  – highest gearscore across all rows (including spec-less)
        specs      – list of (spec, gearscore, id) tuples for rows that have a
                     spec, sorted by GS descending; may be empty
    """
    groups: dict[str, dict] = {}
    # Track all (gs, id) pairs per group regardless of spec, for primary selection
    all_rows: dict[str, list[tuple[float, int]]] = {}

    for c in char_dicts:
        key = c["char_name"].lower()
        gs = c.get("gearscore", 0.0)
        if key not in groups:
            groups[key] = {
                "id": c["id"],
                "char_name": c["char_name"],
                "realm": c.get("realm", ""),
                "char_class": c.get("char_class"),
                "spec": c.get("spec"),
                "gearscore": gs,
                "specs": [],
            }
            all_rows[key] = []
        spec = c.get("spec")
        if spec:
            groups[key]["specs"].append((spec, gs, c["id"]))
        all_rows[key].append((gs, c["id"]))

    result = []
    for key, group in groups.items():
        group["specs"].sort(key=lambda x: x[1], reverse=True)
        if group["specs"]:
            # Primary is the highest-GS spec row
            group["id"] = group["specs"][0][2]
            group["spec"] = group["specs"][0][0]
            group["gearscore"] = group["specs"][0][1]
        else:
            # No spec rows – use the highest-GS row as primary
            best_gs, best_id = max(all_rows[key], key=lambda x: x[0])
            group["id"] = best_id
            group["gearscore"] = best_gs
        result.append(group)
    return result
