from __future__ import annotations

import asyncio
import datetime
import logging
from typing import Optional

import discord
from discord.ext import commands

from bot.db import get_session
from db.models import Character, Raid, RaidStatus
from .parser import (
    _CHAR_LINE_RE,
    _find_random_text_lines,
    _parse_character_lines,
    _MAX_RANDOM_LINES_IN_ERROR,
    format_gs,
)
from .process import process_text_signup, _upsert_discord_user

logger = logging.getLogger(__name__)


class SignupCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    # ── DM handler: register characters only ──────────────────────────────
    async def _handle_dm_signup(self, message: discord.Message):
        """
        Handle character registration via DM.

        Parses character lines in the same format as the channel parser but
        only registers the character(s) in the database — it does not sign the
        player up for any specific raid.
        """
        content = message.content
        # Silently ignore DMs that contain no character sign-up lines
        if not any(
            _CHAR_LINE_RE.match(line.strip())
            for line in content.splitlines()
            if line.strip()
        ):
            return

        random_lines = _find_random_text_lines(content)
        parsed, parse_errors = _parse_character_lines(content)

        all_errors: list[str] = []
        if random_lines:
            quoted = "\n".join(f"> {line}" for line in random_lines[:_MAX_RANDOM_LINES_IN_ERROR])
            all_errors.append(
                "Your message contains text that is not a character sign-up line:\n"
                + quoted
                + "\nPlease post **only** your character sign-up lines."
            )
        all_errors.extend(parse_errors)

        if all_errors or not parsed:
            if not all_errors:
                all_errors.append(
                    "No valid sign-up lines could be parsed. "
                    "Expected format: `CharName / Class / Spec / GS`"
                )
            error_text = "❌ Character registration failed:\n" + "\n".join(all_errors)
            try:
                await message.channel.send(error_text)
            except Exception:
                pass
            return

        discord_user_id = message.author.id
        loop = asyncio.get_event_loop()

        def _register():
            session = get_session()
            try:
                _upsert_discord_user(session, message.author)
                char_spec_info: dict[str, dict] = {}
                for entry in parsed:
                    char = (
                        session.query(Character)
                        .filter_by(
                            discord_user_id=discord_user_id,
                            char_name=entry["char_name"],
                            spec=entry["spec"],
                        )
                        .first()
                    )
                    if char is None:
                        char = Character(
                            discord_user_id=discord_user_id,
                            char_name=entry["char_name"],
                        )
                        session.add(char)
                    char.char_class = entry["char_class"]
                    char.spec = entry["spec"]
                    char.gearscore = entry["gearscore"]
                    char.is_deleted = False
                    char.last_updated = datetime.datetime.now(datetime.timezone.utc)
                    session.flush()

                    key = entry["char_name"].lower()
                    if key not in char_spec_info:
                        char_spec_info[key] = {
                            "char_name": entry["char_name"],
                            "char_class": entry["char_class"],
                            "specs": [],
                        }
                    char_spec_info[key]["specs"].append(
                        {
                            "spec": entry["spec"],
                            "gearscore": entry["gearscore"],
                        }
                    )
                session.commit()

                summaries = []
                for data in char_spec_info.values():
                    spec_parts = [
                        f"{s['spec']} GS {format_gs(s['gearscore'])}" for s in data["specs"]
                    ]
                    summaries.append(
                        f"• **{data['char_name']}** ({data['char_class']}) – {' / '.join(spec_parts)}"
                    )
                return summaries
            finally:
                session.close()

        try:
            summaries = await loop.run_in_executor(None, _register)
        except Exception:
            logger.exception("Failed to process DM character registration from %s", discord_user_id)
            try:
                await message.channel.send(
                    "❌ An error occurred while registering your character(s). Please try again later."
                )
            except Exception:
                pass
            return

        reply = (
            "✅ Character(s) registered successfully:\n"
            + "\n".join(summaries)
            + "\n\n⚠️ **Note:** This only registered your character(s) — "
            "it did **not** sign you up for any raid. "
            "Use the **✅ Sign Up** button on the raid message to sign up."
        )
        try:
            await message.channel.send(reply)
        except Exception:
            pass

    # ── on_message: character list parser ─────────────────────────────────
    @commands.Cog.listener()
    async def on_message(self, message: discord.Message):
        """
        Parse character sign-up lines posted in raid channels.

        Format (one character per line)::

            CharName / CharClass / Spec1 / GS1 [/ Spec2 / GS2 ...] [⭐ or ❌]

        ⭐  = priority character (maps to prio_character signup type)
        ❌  = saved character (ID-locked; marks signup as is_saved=True)

        Characters with multiple specs produce one Character row and one
        Signup per spec, keyed on (discord_user_id, char_name, spec).

        The bot only acts in channels that have an active (open) raid.
        It saves/updates the character(s) in the DB and auto-signs the
        player up for the raid.  A summary reply is sent to the channel.
        """
        # Ignore bot messages
        if message.author.bot:
            return

        # Handle DMs: register characters only (no raid sign-up)
        if not message.guild:
            await self._handle_dm_signup(message)
            return

        # Quick pre-check: does the message contain at least one potential
        # character sign-up line?  If not, ignore silently (normal chat).
        content = message.content
        if not any(
            _CHAR_LINE_RE.match(line.strip())
            for line in content.splitlines()
            if line.strip()
        ):
            return

        loop = asyncio.get_event_loop()

        # If the message is in a thread, use the parent channel to look up the raid.
        if isinstance(message.channel, discord.Thread):
            raid_channel_id = message.channel.parent_id
        else:
            raid_channel_id = message.channel.id

        # Find an open raid in this channel (or parent channel if in a thread)
        def _find_raid():
            session = get_session()
            try:
                raid = (
                    session.query(Raid)
                    .filter_by(discord_channel_id=raid_channel_id, status=RaidStatus.open)
                    .order_by(Raid.id.desc())
                    .first()
                )
                if raid:
                    return {
                        "id": raid.id,
                        "name": raid.name,
                        "discord_log_thread_id": raid.discord_log_thread_id,
                    }
                return None
            finally:
                session.close()

        raid_info = await loop.run_in_executor(None, _find_raid)
        if not raid_info:
            return  # Not a raid channel with an open raid; ignore silently

        await process_text_signup(
            self.bot,
            message.author,
            content,
            raid_info["id"],
            raid_info["name"],
            raid_info.get("discord_log_thread_id"),
            message.channel,
            message_to_delete=message,
        )
