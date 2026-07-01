from __future__ import annotations
from db.models import CharacterRole

# Maps each (class, spec) pair to a role so shared spec names don't collide.
# Keys are (Canonical Class Name, Normalized Spec Name).
_CLASS_SPEC_ROLES: dict[tuple[str, str], CharacterRole] = {
    ("Death Knight", "Blood"): CharacterRole.tank,
    ("Death Knight", "Frost"): CharacterRole.dps,
    ("Death Knight", "Unholy"): CharacterRole.dps,
    ("Druid", "Balance"): CharacterRole.dps,
    ("Druid", "Feral (Cat)"): CharacterRole.dps,
    ("Druid", "Feral (Bear)"): CharacterRole.tank,
    ("Druid", "Restoration"): CharacterRole.healer,
    ("Hunter", "Beast Mastery"): CharacterRole.dps,
    ("Hunter", "Marksmanship"): CharacterRole.dps,
    ("Hunter", "Survival"): CharacterRole.dps,
    ("Mage", "Arcane"): CharacterRole.dps,
    ("Mage", "Fire"): CharacterRole.dps,
    ("Mage", "Frost"): CharacterRole.dps,
    ("Paladin", "Holy"): CharacterRole.healer,
    ("Paladin", "Protection"): CharacterRole.tank,
    ("Paladin", "Retribution"): CharacterRole.dps,
    ("Priest", "Discipline"): CharacterRole.healer,
    ("Priest", "Holy"): CharacterRole.healer,
    ("Priest", "Shadow"): CharacterRole.dps,
    ("Rogue", "Assassination"): CharacterRole.dps,
    ("Rogue", "Combat"): CharacterRole.dps,
    ("Rogue", "Subtlety"): CharacterRole.dps,
    ("Shaman", "Elemental"): CharacterRole.dps,
    ("Shaman", "Enhancement"): CharacterRole.dps,
    ("Shaman", "Restoration"): CharacterRole.healer,
    ("Warlock", "Affliction"): CharacterRole.dps,
    ("Warlock", "Demonology"): CharacterRole.dps,
    ("Warlock", "Destruction"): CharacterRole.dps,
    ("Warrior", "Arms"): CharacterRole.dps,
    ("Warrior", "Fury"): CharacterRole.dps,
    ("Warrior", "Protection"): CharacterRole.tank,
}

def get_role_from_spec(char_class: str | None, spec: str | None) -> CharacterRole:
    """Determine the role (tank, healer, dps) from class and spec."""
    if not char_class or not spec:
        return CharacterRole.dps

    # Normalise input to match the dictionary keys
    c = char_class.strip().title()
    if c == "Dk": c = "Death Knight"

    s = spec.strip().title()

    # Handle common variants
    if "Blood" in s and c == "Death Knight": s = "Blood"
    if "Frost" in s and c == "Death Knight": s = "Frost"
    if "Unholy" in s and c == "Death Knight": s = "Unholy"

    if "Prot" in s: s = "Protection"
    if "Ret" in s: s = "Retribution"
    if "Disc" in s: s = "Discipline"
    if "Resto" in s: s = "Restoration"
    if "Ele" in s: s = "Elemental"
    if "Enha" in s: s = "Enhancement"
    if "Affli" in s: s = "Affliction"
    if "Demo" in s: s = "Demonology"
    if "Destro" in s: s = "Destruction"

    if "Bear" in s and c == "Druid": s = "Feral (Bear)"
    if "Cat" in s and c == "Druid": s = "Feral (Cat)"

    role = _CLASS_SPEC_ROLES.get((c, s))
    if role:
        return role

    # Fallback logic if not in dict
    s_lower = s.lower()
    if "tank" in s_lower or "protection" in s_lower or "blood" in s_lower or "bear" in s_lower:
        return CharacterRole.tank
    if "heal" in s_lower or "holy" in s_lower or "restoration" in s_lower or "discipline" in s_lower:
        return CharacterRole.healer

    return CharacterRole.dps
