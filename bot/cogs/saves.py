from __future__ import annotations

import asyncio
import logging
from typing import Literal, Optional

import discord
from discord import app_commands
from discord.ext import commands

from bot.db import get_session
from bot.cogs.raid import is_officer
from db.models import Character

logger = logging.getLogger(__name__)

# ── constants ─────────────────────────────────────────────────────────────────

RAID_SAVE_INSTANCES = [
    # ICC10 / ICC10 HC share a lockout — stored as "ICC10"
    "ICC10", "ICC25",
    # TOC10 / TOGC10 and TOC25 / TOGC25 share a lockout — stored as "TOC10" / "TOC25"
    "TOC10", "TOC25",
    "ULD10", "ULD25",
    # RS10 / RS10 HC and RS25 / RS25 HC share a lockout — stored as "RS10" / "RS25"
    "RS10", "RS25",
    "NAXX10", "NAXX25",
    "EOE10", "EOE25",
    "ONY10", "ONY25",
    "OS10", "OS25",
]

# Instances that share the same weekly lockout are mapped to a single canonical
# name.  Setting or toggling a save for any alias transparently stores it under
# the canonical name, so e.g. "ICC10 HC" and "ICC10" always resolve to the same
# row in char_raid_saves.
LOCKOUT_CANONICAL: dict[str, str] = {
    "ICC10 HC": "ICC10",
    "ICC25 HC": "ICC25",
    "TOGC10":   "TOC10",
    "TOGC25":   "TOC25",
    "RS10 HC":  "RS10",
    "RS25 HC":  "RS25",
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
    from bot.db import engine
    from sqlalchemy import text
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
    from bot.db import engine
    from sqlalchemy import text
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
    from bot.db import engine
    from sqlalchemy import text
    with engine.begin() as conn:
        result = conn.execute(
            text("DELETE FROM char_raid_saves WHERE is_saved = 1")
        )
    return result.rowcount


# ── cog ──────────────────────────────────────────────────────────────────────

class SavesCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    saves_group = app_commands.Group(
        name="saves",
        description="Manage raid-save (lockout) states for your characters.",
    )

    # ── /saves view ───────────────────────────────────────────────────────

    @saves_group.command(
        name="view",
        description="Show all raid saves recorded for your characters.",
    )
    async def saves_view(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True, thinking=True)
        loop = asyncio.get_event_loop()

        rows = await loop.run_in_executor(
            None, _fetch_all_saves_for_user, interaction.user.id
        )

        if not rows:
            await interaction.followup.send(
                "No raid saves recorded for any of your characters.\n"
                "Use `/saves set` to mark a character as saved.",
                ephemeral=True,
            )
            return

        # Group by character name
        grouped: dict[str, list[dict]] = {}
        for r in rows:
            key = f"{r['char_name']}-{r['realm']}"
            grouped.setdefault(key, []).append(r)

        embed = discord.Embed(
            title=f"🔒 Raid Saves for {interaction.user.display_name}",
            color=discord.Color.orange(),
        )
        for char_key, saves in grouped.items():
            lines = [
                f"{'🟢' if s['is_saved'] else '🔴'} {s['instance_name']}"
                for s in saves
            ]
            embed.add_field(name=char_key, value="\n".join(lines), inline=True)

        embed.set_footer(text="🟢 = saved (locked out)  |  🔴 = not saved")
        await interaction.followup.send(embed=embed, ephemeral=True)

    # ── /saves set ────────────────────────────────────────────────────────

    @saves_group.command(
        name="set",
        description="Mark one of your characters as saved (or not saved) for a raid instance.",
    )
    @app_commands.describe(
        character="Character name",
        instance="Raid instance name (e.g. ICC10, TOGC25, ULD25)",
        saved="Whether the character is saved (locked out) this week",
    )
    @app_commands.autocomplete(instance=_autocomplete_instance)
    async def saves_set(
        self,
        interaction: discord.Interaction,
        character: str,
        instance: str,
        saved: Literal["yes", "no"],
    ):
        await interaction.response.defer(ephemeral=True, thinking=True)
        loop = asyncio.get_event_loop()

        chars = await loop.run_in_executor(
            None, _fetch_user_chars, interaction.user.id, character
        )

        if not chars:
            await interaction.followup.send(
                f"❌ No character named **{character}** found in your registered list.",
                ephemeral=True,
            )
            return

        # Use the first row's id as the canonical character id (saves are per char-name, not per spec)
        char = chars[0]
        is_saved_val = 1 if saved == "yes" else 0
        instance_clean = instance.strip()

        await loop.run_in_executor(
            None, _set_save_state, char.id, instance_clean, is_saved_val
        )

        state_str = "🟢 **saved** (locked out)" if is_saved_val else "🔴 **not saved**"
        await interaction.followup.send(
            f"{char.char_name}-{char.realm} is now {state_str} for **{instance_clean}**.",
            ephemeral=True,
        )

    # ── /saves toggle ─────────────────────────────────────────────────────

    @saves_group.command(
        name="toggle",
        description="Toggle the save state for one of your characters on a raid instance.",
    )
    @app_commands.describe(
        character="Character name",
        instance="Raid instance name (e.g. ICC10, TOGC25, ULD25)",
    )
    @app_commands.autocomplete(instance=_autocomplete_instance)
    async def saves_toggle(
        self,
        interaction: discord.Interaction,
        character: str,
        instance: str,
    ):
        await interaction.response.defer(ephemeral=True, thinking=True)
        loop = asyncio.get_event_loop()

        chars = await loop.run_in_executor(
            None, _fetch_user_chars, interaction.user.id, character
        )

        if not chars:
            await interaction.followup.send(
                f"❌ No character named **{character}** found in your registered list.",
                ephemeral=True,
            )
            return

        char = chars[0]
        instance_clean = instance.strip()

        current = await loop.run_in_executor(
            None, _get_save_state, char.id, instance_clean
        )
        new_state = 0 if current else 1

        await loop.run_in_executor(
            None, _set_save_state, char.id, instance_clean, new_state
        )

        state_str = "🟢 **saved** (locked out)" if new_state else "🔴 **not saved**"
        await interaction.followup.send(
            f"{char.char_name}-{char.realm} is now {state_str} for **{instance_clean}**.",
            ephemeral=True,
        )

    # ── /saves clear_all  (officer-only) ──────────────────────────────────

    @saves_group.command(
        name="clear_all",
        description="[Officer] Clear all raid saves — same effect as the weekly Warmane reset.",
    )
    @is_officer()
    async def saves_clear_all(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True, thinking=True)
        loop = asyncio.get_event_loop()

        deleted = await loop.run_in_executor(None, _clear_all_saves)

        await interaction.followup.send(
            f"✅ Cleared **{deleted}** raid save(s). All characters are now unsaved.",
            ephemeral=True,
        )


    # ── /savecharacter  (top-level shortcut) ──────────────────────────────

    @app_commands.command(
        name="savecharacter",
        description="Toggle the raid-save state for one of your characters on an instance.",
    )
    @app_commands.describe(
        character="Character name",
        instance="Raid instance name (e.g. ICC10, TOGC25, ULD25)",
    )
    @app_commands.autocomplete(instance=_autocomplete_instance)
    async def savecharacter(
        self,
        interaction: discord.Interaction,
        character: str,
        instance: str,
    ):
        await interaction.response.defer(ephemeral=True, thinking=True)
        loop = asyncio.get_event_loop()

        chars = await loop.run_in_executor(
            None, _fetch_user_chars, interaction.user.id, character
        )

        if not chars:
            await interaction.followup.send(
                f"❌ No character named **{character}** found in your registered list.",
                ephemeral=True,
            )
            return

        char = chars[0]
        instance_clean = instance.strip()

        current = await loop.run_in_executor(
            None, _get_save_state, char.id, instance_clean
        )
        new_state = 0 if current else 1

        await loop.run_in_executor(
            None, _set_save_state, char.id, instance_clean, new_state
        )

        state_str = "🟢 **saved** (locked out)" if new_state else "🔴 **not saved**"
        await interaction.followup.send(
            f"{char.char_name}-{char.realm} is now {state_str} for **{instance_clean}**.",
            ephemeral=True,
        )


async def setup(bot: commands.Bot):
    await bot.add_cog(SavesCog(bot))
