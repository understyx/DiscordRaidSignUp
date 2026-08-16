from __future__ import annotations

from bot.wow import CLASS_SPEC_ROLES
from db.models import CharacterRole


# Maps each (class, spec) pair to a role so shared spec names don't collide.
# Keys are (Canonical Class Name, Normalized Spec Name).
def get_role_from_spec(char_class: str | None, spec: str | None) -> CharacterRole:
    """Determine the role (tank, healer, dps) from class and spec."""
    if not char_class or not spec:
        return CharacterRole.dps

    # Normalise input to match the dictionary keys
    c = char_class.strip().title()
    if c == "Dk":
        c = "Death Knight"

    s = spec.strip().title()

    # Handle common variants
    if "Blood" in s and c == "Death Knight":
        s = "Blood"
    if "Frost" in s and c == "Death Knight":
        s = "Frost"
    if "Unholy" in s and c == "Death Knight":
        s = "Unholy"

    if "Prot" in s:
        s = "Protection"
    if "Ret" in s:
        s = "Retribution"
    if "Disc" in s:
        s = "Discipline"
    if "Resto" in s:
        s = "Restoration"
    if "Ele" in s:
        s = "Elemental"
    if "Enha" in s:
        s = "Enhancement"
    if "Affli" in s:
        s = "Affliction"
    if "Demo" in s:
        s = "Demonology"
    if "Destro" in s:
        s = "Destruction"

    if "Bear" in s and c == "Druid":
        s = "Feral (Bear)"
    if "Cat" in s and c == "Druid":
        s = "Feral (Cat)"

    role = CLASS_SPEC_ROLES.get((c, s))
    if role:
        return CharacterRole(role)

    # Fallback logic if not in dict
    s_lower = s.lower()
    if "tank" in s_lower or "protection" in s_lower or "blood" in s_lower or "bear" in s_lower:
        return CharacterRole.tank
    if (
        "heal" in s_lower
        or "holy" in s_lower
        or "restoration" in s_lower
        or "discipline" in s_lower
    ):
        return CharacterRole.healer

    return CharacterRole.dps
