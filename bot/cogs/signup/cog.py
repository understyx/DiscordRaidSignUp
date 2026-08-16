from __future__ import annotations

import asyncio
import datetime
import logging

import discord
from discord.ext import commands

from bot.db import get_session
from db.models import Character, Raid, RaidStatus

from .parser import (
    _CHAR_LINE_RE,
    _MAX_RANDOM_LINES_IN_ERROR,
    _find_random_text_lines,
    _parse_character_lines,
    format_gs,
)
from .process import _upsert_discord_user, process_text_signup

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

        If the user shares exactly one guild with the bot the guild is chosen
        automatically. If they share multiple guilds a button picker is shown
        so they can pick which guild to associate the characters with.
        """
        content = message.content
        # Silently ignore DMs that contain no character sign-up lines
        if not any(
            _CHAR_LINE_RE.match(line.strip()) for line in content.splitlines() if line.strip()
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

        # ── Resolve which guild to register characters under ───────────────
        mutual_guilds = [
            guild for guild in self.bot.guilds if guild.get_member(discord_user_id) is not None
        ]

        if not mutual_guilds:
            try:
                await message.channel.send(
                    "❌ You don't appear to be a member of any server managed by this bot. "
                    "Please join a server first, then try again."
                )
            except Exception:
                pass
            return

        if len(mutual_guilds) == 1:
            # Auto-pick — no prompt needed
            await self._dm_register_and_reply(message, parsed, mutual_guilds[0])
        else:
            # Multiple guilds: show picker embed with buttons
            embed = discord.Embed(
                title="🏰 Which server should these characters be added to?",
                description=(
                    "You're registering characters via DM. "
                    "Pick the server you'd like to associate them with:"
                ),
                color=discord.Color.blurple(),
            )
            embed.set_footer(text="This prompt expires in 2 minutes.")
            view = DmGuildPickerView(
                guilds=mutual_guilds,
                parsed=parsed,
                message=message,
                cog=self,
            )
            try:
                await message.channel.send(embed=embed, view=view)
            except Exception:
                pass

    async def _dm_register_and_reply(
        self,
        message: discord.Message,
        parsed: list[dict],
        guild: discord.Guild,
        *,
        reply_target=None,
    ):
        """Save parsed characters to *guild* and send a success reply.

        *reply_target* is where the success/error message is sent.  When
        called from a button callback it is the interaction; otherwise it is
        the original DM message channel.
        """
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
                            guild_id=guild.id,
                            discord_user_id=discord_user_id,
                            char_name=entry["char_name"],
                            spec=entry["spec"],
                        )
                        .first()
                    )
                    if char is None:
                        char = Character(
                            guild_id=guild.id,
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
                return char_spec_info
            finally:
                session.close()

        try:
            char_spec_info = await loop.run_in_executor(None, _register)
        except Exception:
            logger.exception(
                "Failed to process DM character registration from %s in guild %s",
                discord_user_id,
                guild.id,
            )
            err = (
                "❌ An error occurred while registering your character(s). Please try again later."
            )
            try:
                if reply_target is not None:
                    await reply_target.edit_original_response(content=err, embed=None, view=None)
                else:
                    await message.channel.send(err)
            except Exception:
                pass
            return

        summaries = []
        for data in char_spec_info.values():
            spec_parts = [f"{s['spec']} GS {format_gs(s['gearscore'])}" for s in data["specs"]]
            summaries.append(
                f"• **{data['char_name']}** ({data['char_class']}) – {' / '.join(spec_parts)}"
            )

        lines = "\n".join(summaries)
        note = (
            "\n\n⚠️ **Note:** This only registered your character(s) — "
            "it did **not** sign you up for any raid. "
            "Use the **✅ Sign Up** button on the raid message to sign up."
        )

        try:
            if reply_target is not None:
                embed = discord.Embed(
                    title=f"✅ Character(s) registered! → {guild.name}",
                    description=lines + note,
                    color=discord.Color.green(),
                )
                await reply_target.edit_original_response(content=None, embed=embed, view=None)
            else:
                await message.channel.send(
                    f"✅ Character(s) registered for **{guild.name}**:\n{lines}{note}"
                )
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
            _CHAR_LINE_RE.match(line.strip()) for line in content.splitlines() if line.strip()
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


class DmGuildButton(discord.ui.Button):
    """A button for one guild in the DM character-registration guild picker."""

    def __init__(
        self,
        guild: discord.Guild,
        parsed: list[dict],
        message: discord.Message,
        cog: "SignupCog",
    ):
        super().__init__(
            label=guild.name,
            style=discord.ButtonStyle.primary,
            emoji="🏰",
        )
        self.guild = guild
        self.parsed = parsed
        self.dm_message = message
        self.cog = cog

    async def callback(self, interaction: discord.Interaction) -> None:
        # Disable all buttons immediately to prevent double-clicks
        for item in self.view.children:
            item.disabled = True
        await interaction.response.defer()
        await self.cog._dm_register_and_reply(
            self.dm_message,
            self.parsed,
            self.guild,
            reply_target=interaction,
        )


class DmGuildPickerView(discord.ui.View):
    """Shown in DMs when the user belongs to multiple bot-managed guilds."""

    def __init__(
        self,
        guilds: list[discord.Guild],
        parsed: list[dict],
        message: discord.Message,
        cog: "SignupCog",
    ):
        super().__init__(timeout=120)
        for guild in guilds[:25]:  # Discord hard-cap: 25 components per message
            self.add_item(
                DmGuildButton(
                    guild=guild,
                    parsed=parsed,
                    message=message,
                    cog=cog,
                )
            )

    async def on_timeout(self) -> None:
        for item in self.children:
            item.disabled = True
