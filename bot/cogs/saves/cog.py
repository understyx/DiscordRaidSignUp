from __future__ import annotations

from typing import Literal, Optional

import discord
from discord import app_commands

from bot.db import get_session
from db.models import Character
from .helpers import (
    RAID_SAVE_INSTANCES,
    _autocomplete_instance,
    _fetch_user_chars,
    _get_save_state,
    _set_save_state,
    _fetch_all_saves_for_user,
    _clear_all_saves,
)

import asyncio
import logging
from discord.ext import commands
from bot.cogs.raid import is_officer

logger = logging.getLogger(__name__)


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
