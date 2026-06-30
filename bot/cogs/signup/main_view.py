from __future__ import annotations

import asyncio
import logging
from typing import Optional

import discord

from bot.config import WEB_BASE_URL, BASE_DOMAIN
from bot.db import get_session
from db.models import BotGuild, Character, Raid, RaidStatus, Signup, SignupStatus, SignupType
from .char_helpers import _chars_to_dicts, _group_chars_by_name
from .log_thread import _post_to_raid_log, format_user_raid_log_message
from .embed import update_raid_embed
from .parser import format_gs
from .views import (
    SignupCharacterSelectView,
    SignupTestingCharacterSelectView,
    SignupTesting2ClassSelectView,
    TextSignupModal,
    EditNotesModal
)

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
            dm_text = (
                "👋 **You have no registered characters!**\n\n"
                "The easiest way to add your characters is to **reply to me here in DMs** "
                "using the following format (one character per line):\n\n"
                "```\n"
                "CharName / CharClass / Spec1 / GS1 / Spec2 / GS2 / ... / Spec6 / GS6\n"
                "```\n"
                "**Example:**\n"
                "```\n"
                "Thrall / Shaman / Enhancement / 6200 / Restoration / 5800\n"
                "```\n"
                "You can list up to 6 specs per character and multiple characters at once.\n\n"
                "Alternatively, use the `/addcharacter` or `/addcharacters` commands in the server."
            )
            try:
                await interaction.user.send(dm_text)
                dm_note = " A DM has been sent to you with instructions."
            except discord.Forbidden:
                dm_note = " (Could not send you a DM — please enable DMs from server members.)"
            except Exception:
                dm_note = ""
            await interaction.response.send_message(
                "❌ You have no registered characters." + dm_note,
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
        label="Sign up",
        style=discord.ButtonStyle.success,
        custom_id="signup:multi",
        emoji="✅",
        row=0,
    )
    async def btn_signup(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self._start_signup_flow(interaction, SignupStatus.signed)

    @discord.ui.button(
        label="Sign up (Testing)",
        style=discord.ButtonStyle.secondary,
        custom_id="signup:testing",
        emoji="🧪",
        row=0,
    )
    async def btn_signup_testing(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self._start_signup_testing_flow(interaction)

    @discord.ui.button(
        label="Sign up (Test 2)",
        style=discord.ButtonStyle.secondary,
        custom_id="signup:testing2",
        emoji="🧪",
        row=0,
    )
    async def btn_signup_testing2(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self._start_signup_testing2_flow(interaction)

    async def _start_signup_testing_flow(
        self,
        interaction: discord.Interaction,
    ):
        """Open the character sign-up testing flow."""
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
            dm_text = (
                "👋 **You have no registered characters!**\n\n"
                "The easiest way to add your characters is to **reply to me here in DMs** "
                "using the following format (one character per line):\n\n"
                "```\n"
                "CharName / CharClass / Spec1 / GS1 / Spec2 / GS2 / ... / Spec6 / GS6\n"
                "```\n"
                "**Example:**\n"
                "```\n"
                "Thrall / Shaman / Enhancement / 6200 / Restoration / 5800\n"
                "```\n"
                "You can list up to 6 specs per character and multiple characters at once.\n\n"
                "Alternatively, use the `/addcharacter` or `/addcharacters` commands in the server."
            )
            try:
                await interaction.user.send(dm_text)
                dm_note = " A DM has been sent to you with instructions."
            except discord.Forbidden:
                dm_note = " (Could not send you a DM — please enable DMs from server members.)"
            except Exception:
                dm_note = ""
            await interaction.response.send_message(
                "❌ You have no registered characters." + dm_note,
                ephemeral=True,
            )
            return

        view = SignupTestingCharacterSelectView(char_dicts, raid_id)
        await interaction.response.send_message(
            "**Step 1:** Select characters to sign up:",
            view=view,
            ephemeral=True,
        )

    async def _start_signup_testing2_flow(
        self,
        interaction: discord.Interaction,
    ):
        """Open the second character sign-up testing flow."""
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
            dm_text = (
                "👋 **You have no registered characters!**\n\n"
                "The easiest way to add your characters is to **reply to me here in DMs** "
                "using the following format (one character per line):\n\n"
                "```\n"
                "CharName / CharClass / Spec1 / GS1 / Spec2 / GS2 / ... / Spec6 / GS6\n"
                "```\n"
                "**Example:**\n"
                "```\n"
                "Thrall / Shaman / Enhancement / 6200 / Restoration / 5800\n"
                "```\n"
                "You can list up to 6 specs per character and multiple characters at once.\n\n"
                "Alternatively, use the `/addcharacter` or `/addcharacters` commands in the server."
            )
            try:
                await interaction.user.send(dm_text)
                dm_note = " A DM has been sent to you with instructions."
            except discord.Forbidden:
                dm_note = " (Could not send you a DM — please enable DMs from server members.)"
            except Exception:
                dm_note = ""
            await interaction.response.send_message(
                "❌ You have no registered characters." + dm_note,
                ephemeral=True,
            )
            return

        view = SignupTesting2ClassSelectView(char_dicts, raid_id)
        await interaction.response.send_message(
            "**Step 1:** Select a class:",
            view=view,
            ephemeral=True,
        )

    @discord.ui.button(
        label="Sign up (Text)",
        style=discord.ButtonStyle.secondary,
        custom_id="signup:show_characters",
        emoji="📋",
        row=0,
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
        label="Sign up (Website)",
        style=discord.ButtonStyle.secondary,
        custom_id="signup:website",
        emoji="🌐",
        row=0,
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

    async def _change_status(
        self,
        interaction: discord.Interaction,
        new_status: SignupStatus,
    ):
        """Change the status of all existing signups for this user+raid to new_status."""
        raid_id = self._get_raid_id(interaction)
        if raid_id is None:
            await interaction.response.send_message(
                "❌ Could not determine raid ID from this message.", ephemeral=True
            )
            return

        discord_user_id = interaction.user.id
        loop = asyncio.get_event_loop()

        def _update():
            session = get_session()
            try:
                signups = (
                    session.query(Signup)
                    .filter_by(raid_id=raid_id, discord_user_id=discord_user_id)
                    .all()
                )
                if not signups:
                    return None, []

                for signup in signups:
                    signup.status = new_status
                session.commit()

                grouped: dict[str, dict] = {}
                for signup in signups:
                    char = signup.character
                    if char is None:
                        continue
                    key = char.char_name.lower()
                    if key not in grouped:
                        grouped[key] = {
                            "char_name": char.char_name,
                            "char_class": char.char_class or "?",
                            "specs": [],
                            "note": signup.note,
                        }
                    star = " ⭐" if signup.signup_type == SignupType.prio_character else ""
                    grouped[key]["specs"].append(
                        f"{char.spec or '?'}{star} GS {format_gs(char.gearscore or 0.0)}"
                    )

                bullets = []
                for key, d in grouped.items():
                    note_str = f" 💬 *{d['note']}*" if d.get("note") else ""
                    bullets.append(
                        f"• **{d['char_name']}** ({d['char_class']}) – {' / '.join(d['specs'])}{note_str}"
                    )
                return len(signups), bullets
            finally:
                session.close()

        result = await loop.run_in_executor(None, _update)
        count, bullets = result

        if count is None:
            await interaction.response.send_message(
                "❌ You are not signed up for this raid. Use **Sign up** first.",
                ephemeral=True,
            )
            return

        if new_status == SignupStatus.signed:
            emoji = "✅"
            action = "is coming"
            reply = "✅ Status updated: **I'm coming**!"
        else:
            emoji = "❓"
            action = "is tentative"
            reply = "❓ Status updated: **I'm tentative**!"

        await interaction.response.send_message(reply, ephemeral=True)

        log_message = format_user_raid_log_message(
            raid_id=raid_id,
            discord_user_id=discord_user_id,
            user_mention=interaction.user.mention,
            emoji=emoji,
            action=action,
            detail_lines=bullets,
        )
        await _post_to_raid_log(
            interaction.client,
            raid_id,
            log_message,
            discord_user_id=discord_user_id,
        )
        await update_raid_embed(interaction.client, raid_id)

    @discord.ui.button(
        label="I'm coming",
        style=discord.ButtonStyle.success,
        custom_id="signup:coming",
        emoji="✅",
        row=1,
    )
    async def btn_coming(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self._change_status(interaction, SignupStatus.signed)

    @discord.ui.button(
        label="I'm tentative",
        style=discord.ButtonStyle.primary,
        custom_id="signup:status_tentative",
        emoji="❓",
        row=1,
    )
    async def btn_status_tentative(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self._change_status(interaction, SignupStatus.tentative)

    @discord.ui.button(
        label="Not coming",
        style=discord.ButtonStyle.secondary,
        custom_id="signup:withdraw",
        emoji="❌",
        row=1,
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

    @discord.ui.button(
        label="Edit notes",
        style=discord.ButtonStyle.secondary,
        custom_id="signup:edit_notes",
        emoji="📝",
        row=2,
    )
    async def btn_edit_notes(self, interaction: discord.Interaction, button: discord.ui.Button):
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
                signups = (
                    session.query(Signup)
                    .filter_by(raid_id=raid_id, discord_user_id=discord_user_id)
                    .all()
                )
                if not signups:
                    return None
                seen: set[str] = set()
                result: list[tuple[str, str]] = []
                for signup in signups:
                    char = signup.character
                    if char is None:
                        continue
                    key = char.char_name.lower()
                    if key not in seen:
                        seen.add(key)
                        result.append((char.char_name, signup.note or ""))
                return result
            finally:
                session.close()

        char_name_notes = await loop.run_in_executor(None, _fetch)

        if char_name_notes is None:
            await interaction.response.send_message(
                "❌ You are not signed up for this raid.", ephemeral=True
            )
            return

        await interaction.response.send_modal(
            EditNotesModal(raid_id, discord_user_id, char_name_notes)
        )
