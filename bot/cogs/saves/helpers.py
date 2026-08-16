from __future__ import annotations

from typing import Optional

import discord
from discord import app_commands

from bot.db import get_session
from db.models import Character

# ── constants ─────────────────────────────────────────────────────────────────

RAID_SAVE_INSTANCES = [
    # RS10 / RS10 HC and RS25 / RS25 HC share a lockout — stored as "RS10" / "RS25"
    "RS10",
    "RS25",
    # ICC10 / ICC10 HC share a lockout — stored as "ICC10"
    "ICC10",
    "ICC25",
    # TOC10 / TOGC10 and TOC25 / TOGC25 share a lockout — stored as "TOC10" / "TOC25"
    "TOC10",
    "TOC25",
    "ONY10",
    "ONY25",
    "ULD10",
    "ULD25",
    "EOE10",
    "EOE25",
    "OS10",
    "OS25",
    "NAXX10",
    "NAXX25",
]

# Instances that share the same weekly lockout are mapped to a single canonical
# name.  Setting or toggling a save for any alias transparently stores it under
# the canonical name, so e.g. "ICC10 HC" and "ICC10" always resolve to the same
# row in char_raid_saves.
LOCKOUT_CANONICAL: dict[str, str] = {
    "ICC10 HC": "ICC10",
    "ICC25 HC": "ICC25",
    "TOGC10": "TOC10",
    "TOGC25": "TOC25",
    "RS10 HC": "RS10",
    "RS25 HC": "RS25",
}


def _canonicalize_instance(instance_name: str) -> str:
    """Return the canonical (shared-lockout) name for the given instance."""
    return LOCKOUT_CANONICAL.get(instance_name.strip(), instance_name.strip())


async def _autocomplete_instance(
    interaction: discord.Interaction,  # noqa: ARG001
    current: str,
) -> list[app_commands.Choice[str]]:
    return [
        app_commands.Choice(name=i, value=i)
        for i in RAID_SAVE_INSTANCES
        if current.lower() in i.lower()
    ]


# ── helpers ──────────────────────────────────────────────────────────────────


def _fetch_user_chars(discord_user_id: int, name_filter: Optional[str] = None) -> list[Character]:
    """Return non-deleted characters for a Discord user, optionally filtered by name."""
    session = get_session()
    try:
        q = session.query(Character).filter(
            Character.discord_user_id == discord_user_id,
            Character.is_deleted == False,  # noqa: E712
        )
        if name_filter:
            q = q.filter(Character.char_name.ilike(name_filter))
        return q.all()
    finally:
        session.close()


def _get_save_state(character_id: int, instance_name: str) -> int:
    """Return current is_saved value (0 or 1) for the given character/instance."""
    from bot.db import engine

    with engine.connect() as conn:
        from sqlalchemy import text

        row = conn.execute(
            text(
                "SELECT is_saved FROM char_raid_saves"
                " WHERE character_id = :cid AND instance_name = :inst"
            ),
            {"cid": character_id, "inst": _canonicalize_instance(instance_name)},
        ).fetchone()
    return int(row[0]) if row else 0


def _set_save_state(character_id: int, instance_name: str, is_saved: int) -> None:
    """Upsert save state for the given character/instance (canonical lockout key)."""
    from sqlalchemy import text

    from bot.db import engine

    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO char_raid_saves (character_id, instance_name, is_saved)"
                " VALUES (:cid, :inst, :saved)"
                " ON DUPLICATE KEY UPDATE is_saved = VALUES(is_saved), updated_at = NOW()"
            ),
            {"cid": character_id, "inst": _canonicalize_instance(instance_name), "saved": is_saved},
        )


def _fetch_all_saves_for_user(discord_user_id: int) -> list[dict]:
    """
    Return a list of dicts {char_name, realm, instance_name, is_saved} for all
    non-deleted characters belonging to the given Discord user.
    """
    from sqlalchemy import text

    from bot.db import engine

    with engine.connect() as conn:
        rows = conn.execute(
            text(
                "SELECT c.char_name, c.realm, s.instance_name, s.is_saved"
                " FROM char_raid_saves s"
                " JOIN characters c ON c.id = s.character_id"
                " WHERE c.discord_user_id = :uid AND c.is_deleted = 0"
                " ORDER BY c.char_name, s.instance_name"
            ),
            {"uid": discord_user_id},
        ).fetchall()
    return [
        {"char_name": r[0], "realm": r[1], "instance_name": r[2], "is_saved": int(r[3])}
        for r in rows
    ]


def _clear_all_saves() -> int:
    """Delete all is_saved=1 rows.  Returns number of rows deleted."""
    from sqlalchemy import text

    from bot.db import engine

    with engine.begin() as conn:
        result = conn.execute(text("DELETE FROM char_raid_saves WHERE is_saved = 1"))
    return result.rowcount
