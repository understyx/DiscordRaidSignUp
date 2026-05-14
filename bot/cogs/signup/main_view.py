from __future__ import annotations

import asyncio
import logging
from typing import Optional

import discord

from bot.config import WEB_BASE_URL, BASE_DOMAIN
from bot.db import get_session
from db.models import BotGuild, Character, Raid, RaidStatus, Signup, SignupStatus
from .char_helpers import _chars_to_dicts, _group_chars_by_name
from .log_thread import _post_to_raid_log, format_user_raid_log_message
from .embed import update_raid_embed
from .views import SignupCharacterSelectView, TextSignupModal

logger = logging.getLogger(__name__)


class SignupView(discord.ui.View):
    """Persistent view attached to each raid sign-up message."""

    def __init__(self):
        super().__init__(timeout=None)  # persistent

    def _get_raid_id(self, interaction: discord.Interaction) -> Optional[int]:
        """Extract raid_id from the embed footer text."""
        try:
            if interaction.message and interaction.message.embeds:
                footer = interaction.message.embeds[0].footer.text or ""
                for part in footer.split():
                    if part.isdigit():
                        return int(part)
        except Exception:
            pass
        return None

    async def _start_signup_flow(
        self,
        interaction: discord.Interaction,
        signup_status: SignupStatus,
    ):
        """Open the two-step character sign-up flow for the given status."""
        raid_id = self._get_raid_id(interaction)
        if raid_id is None:
            await interaction.response.send_message(
                "❌ Could not determine raid ID from this message.", ephemeral=True
            )
            return

        loop = asyncio.get_event_loop()
        discord_user_id = interaction.user.id

        def _fetch():
            session = get_session()
            try:
                raid = session.get(Raid, raid_id)
                if raid is None:
                    return None, []
                chars = (
                    session.query(Character)
                    .filter_by(discord_user_id=discord_user_id, is_deleted=False)
                    .all()
                )
                return raid.status, _chars_to_dicts(chars)
            finally:
                session.close()

        status, char_dicts = await loop.run_in_executor(None, _fetch)

        if status is None:
            await interaction.response.send_message(
                "❌ Could not find this raid.", ephemeral=True
            )
            return

        if status != RaidStatus.open:
            await interaction.response.send_message(
                "❌ This raid is no longer accepting sign-ups.", ephemeral=True
            )
            return

        if not char_dicts:
            await interaction.response.send_message(
                "❌ You have no registered characters. Post a sign-up line or use `/addcharacter` first.",
                ephemeral=True,
            )
            return

        view = SignupCharacterSelectView(char_dicts, raid_id, signup_status)
        await interaction.response.send_message(
            view._step_text(),
            view=view,
            ephemeral=True,
        )

    @discord.ui.button(
        label="Sign Up",
        style=discord.ButtonStyle.success,
        custom_id="signup:multi",
        emoji="✅",
        row=0,
    )
    async def btn_signup(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self._start_signup_flow(interaction, SignupStatus.signed)

    @discord.ui.button(
        label="Tentative",
        style=discord.ButtonStyle.primary,
        custom_id="signup:tentative",
        emoji="❓",
        row=0,
    )
    async def btn_tentative(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self._start_signup_flow(interaction, SignupStatus.tentative)

    @discord.ui.button(
        label="Sign Up on Website",
        style=discord.ButtonStyle.secondary,
        custom_id="signup:website",
        emoji="🌐",
        row=1,
    )
    async def btn_website(self, interaction: discord.Interaction, button: discord.ui.Button):
        raid_id = self._get_raid_id(interaction)
        if raid_id is None:
            await interaction.response.send_message(
                "❌ Could not determine raid ID from this message.", ephemeral=True
            )
            return

        loop = asyncio.get_event_loop()

        def _fetch_raid():
            session = get_session()
            try:
                raid = session.get(Raid, raid_id)
                if raid is None:
                    return None, None, None
                guild = session.get(BotGuild, raid.guild_id) if raid.guild_id else None
                subdomain = guild.subdomain if guild else None
                return raid.guild_id, raid.guild_raid_number, subdomain
            finally:
                session.close()

        guild_id, guild_raid_number, subdomain = await loop.run_in_executor(None, _fetch_raid)

        if BASE_DOMAIN and guild_raid_number:
            # Use subdomain URL: {subdomain or guild_id}.{BASE_DOMAIN}/raids/{guild_raid_number}
            slug = subdomain if subdomain else str(guild_id)
            protocol = "https" if "https" in WEB_BASE_URL else "http"
            url = f"{protocol}://{slug}.{BASE_DOMAIN}/raids/{guild_raid_number}"
        elif guild_id is not None and guild_raid_number:
            url = f"{WEB_BASE_URL.rstrip('/')}/raids/{guild_id}/{guild_raid_number}"
        else:
            url = f"{WEB_BASE_URL.rstrip('/')}/raids/{raid_id}"

        await interaction.response.send_message(
            f"🌐 Sign up for this raid on the website: {url}",
            ephemeral=True,
        )

    @discord.ui.button(
        label="Text Sign Up",
        style=discord.ButtonStyle.secondary,
        custom_id="signup:show_characters",
        emoji="📋",
        row=1,
    )
    async def btn_show_characters(self, interaction: discord.Interaction, button: discord.ui.Button):
        raid_id = self._get_raid_id(interaction)
        if raid_id is None:
            await interaction.response.send_message(
                "❌ Could not determine raid ID from this message.", ephemeral=True
            )
            return

        discord_user_id = interaction.user.id
        loop = asyncio.get_event_loop()

        def _fetch():
            session = get_session()
            try:
                raid = session.get(Raid, raid_id)
                chars = (
                    session.query(Character)
                    .filter_by(discord_user_id=discord_user_id, is_deleted=False)
                    .order_by(Character.char_name, Character.gearscore.desc())
                    .all()
                )
                if not raid:
                    return None, None, None, []
                return raid.id, raid.name, raid.discord_log_thread_id, _chars_to_dicts(chars)
            finally:
                session.close()

        r_id, r_name, r_log_id, char_dicts = await loop.run_in_executor(None, _fetch)

        if r_id is None:
            await interaction.response.send_message("❌ Raid not found.", ephemeral=True)
            return

        initial_text = ""
        if char_dicts:
            char_groups = _group_chars_by_name(char_dicts)
            lines = []
            for g in char_groups:
                parts = [g["char_name"], g["char_class"] or "Unknown"]
                if g["specs"]:
                    for spec, gs, _ in g["specs"]:
                        parts.append(spec)
                        parts.append(f"{gs:.0f}")
                line = " / ".join(parts)
                lines.append(line)
            initial_text = "\n".join(lines)

        await interaction.response.send_modal(
            TextSignupModal(r_id, r_name, r_log_id, initial_text=initial_text)
        )

    @discord.ui.button(
        label="Withdraw",
        style=discord.ButtonStyle.secondary,
        custom_id="signup:withdraw",
        emoji="❌",
        row=0,
    )
    async def btn_withdraw(self, interaction: discord.Interaction, button: discord.ui.Button):
        raid_id = self._get_raid_id(interaction)
        if raid_id is None:
            await interaction.response.send_message("❌ Could not determine raid.", ephemeral=True)
            return

        discord_user_id = interaction.user.id
        loop = asyncio.get_event_loop()

        def _withdraw():
            session = get_session()
            try:
                removed_count = (
                    session.query(Signup)
                    .filter_by(raid_id=raid_id, discord_user_id=discord_user_id)
                    .delete()
                )
                session.commit()
                return removed_count > 0
            finally:
                session.close()

        removed = await loop.run_in_executor(None, _withdraw)

        if removed:
            await interaction.response.send_message("✅ Withdrawn from the raid.", ephemeral=True)
            log_message = format_user_raid_log_message(
                raid_id=raid_id,
                discord_user_id=interaction.user.id,
                user_mention=interaction.user.mention,
                emoji="❌",
                action="withdrew from the raid",
            )
            await _post_to_raid_log(
                interaction.client,
                raid_id,
                log_message,
                discord_user_id=interaction.user.id,
            )
            await update_raid_embed(interaction.client, raid_id)
        else:
            await interaction.response.send_message(
                "You were not signed up for this raid.", ephemeral=True
            )
