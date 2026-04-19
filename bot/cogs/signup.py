from __future__ import annotations

import asyncio
import datetime
import logging
from typing import Optional

import discord
from discord.ext import commands

from bot.config import WEB_BASE_URL, BASE_DOMAIN
from bot.db import get_session
from bot.signup_parser import (
    BIS_GS,
    MAX_RANDOM_LINES_IN_ERROR,
    CHAR_LINE_RE,
    TENTATIVE_KEYWORDS,
    format_gs,
    parse_gs,
    is_tentative_message,
    find_random_text_lines,
    parse_character_lines,
)
from bot.signup_embed import (
    upsert_discord_user,
    chars_to_dicts,
    char_display_description,
    char_label,
    group_chars_by_name,
    build_signup_embed,
    update_raid_embed,
    post_to_raid_log,
)
from db.models import BotGuild, Character, Raid, RaidStatus, Signup, SignupStatus, SignupType

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# "How to Sign Up" guide – shared between the raid-creation thread post,
# the ephemeral button reply, and the fallback officer DM.
# ---------------------------------------------------------------------------
HOWTO_TEXT = (
    "**How to Sign Up for the Raid**\n\n"
    "**Method 1: Sign up on the Website**\n"
    "Visit the raid page on the website and sign up directly with your Discord account.\n"
    "Click the **🌐 Sign Up on Website** button on the raid message to get the link.\n\n"
    "**Method 2: Use `/addcharacter` then click the Sign Up button**\n"
    "1. Register your character: `/addcharacter name:<name> char_class:<class> spec1:<spec> gs1:<gearscore>`\n"
    "2. Click the **✅ Sign Up** (or **❓ Tentative**) button on the raid message\n"
    "3. Select your character(s), optionally mark preferred, then confirm\n\n"
    "**Method 3: Post your character(s) as a text message in this channel**\n"
    "Post one character per line in the format below. "
    "This will both **register your character** and **sign you up** automatically.\n"
    "```\nCharName / Class / Spec / GS\n```\n"
    "Use a number (`6200`), shorthand (`6.2k`), or `BiS` for Best in Slot as your GS.\n"
    "Multiple specs: `Thralladin / Paladin / Holy / 5800 / Ret / 5600`\n\n"
    "**Method 4: Send a DM to the bot**\n"
    "You can also DM the bot with the same character format.\n"
    "⚠️ **Note:** DM sign-ups will only **register your character** — "
    "they will **not** sign you up for any specific raid. "
    "After registering via DM, use the **✅ Sign Up** button on the raid message to sign up.\n\n"
    "**Signing up as tentative (Method 3)**\n"
    "Put `tentative` or `maybe` on the **first line** of your message to sign up as tentative:\n"
    "```\ntentative\n\nBlazelord / Mage / Fire / 6200\nCloudsky / Paladin / Holy / 6300 / Protection / 6300\n```\n\n"
    "**Marking preferred specs (⭐)**\n"
    "Put ⭐ after the spec name to mark that specific spec as preferred:\n"
    "`Lifedenier / Priest / Shadow ⭐ / 6500 / Disc / 6300` → Shadow is preferred\n"
    "Put ⭐ at the very end of the line (after the last GS) to mark **all** specs as preferred:\n"
    "`Puredecay / Hunter / Survival / 6500 ⭐` → all listed specs are preferred\n\n"
    "Add ❌ anywhere in the line if your character is already saved this lockout.\n\n"
    "*Your message will be deleted automatically and a sign-up summary will be posted in the log thread.*"
)


class SignupPrioritySelectView(discord.ui.View):
    """
    Step 2 of the sign-up flow.

    Lets players optionally mark characters as preferred, then confirms.
    For tentative sign-ups the signup is saved with tentative status but
    preferred character selection is still available.
    """

    def __init__(self, selected_chars: list[dict], raid_id: int, signup_status: SignupStatus = SignupStatus.signed):
        super().__init__(timeout=120)
        self.raid_id = raid_id
        self.selected_chars = selected_chars
        self.signup_status = signup_status
        self.priority_select: discord.ui.Select | None = None

        options = [
            discord.SelectOption(
                label=char_label(c)[:100],
                description=char_display_description(c)[:100],
                value=str(c["id"]),
            )
            for c in selected_chars[:25]
        ]
        self.priority_select = discord.ui.Select(
            placeholder="Mark preferred characters (optional)…",
            options=options,
            min_values=0,
            max_values=len(options),
            row=0,
        )
        self.priority_select.callback = self._on_priority_select
        self.add_item(self.priority_select)

        is_tentative = signup_status == SignupStatus.tentative
        confirm_btn = discord.ui.Button(
            label="Confirm Tentative Sign Up" if is_tentative else "Confirm Sign Up",
            style=discord.ButtonStyle.primary if is_tentative else discord.ButtonStyle.success,
            emoji="❓" if is_tentative else "✅",
            row=1,
        )
        confirm_btn.callback = self.confirm
        self.add_item(confirm_btn)

    async def _on_priority_select(self, interaction: discord.Interaction):
        """Acknowledge the select interaction; values are read when Confirm is pressed."""
        await interaction.response.defer()

    async def confirm(self, interaction: discord.Interaction):
        priority_ids = {int(v) for v in (self.priority_select.values if self.priority_select else [])}
        discord_user_id = interaction.user.id
        raid_id = self.raid_id
        signup_status = self.signup_status
        loop = asyncio.get_event_loop()

        def _upsert_all():
            session = get_session()
            try:
                upsert_discord_user(session, interaction.user)
                for char in self.selected_chars:
                    signup_type = (
                        SignupType.prio_character if char["id"] in priority_ids else SignupType.fill
                    )
                    existing = (
                        session.query(Signup)
                        .filter_by(
                            raid_id=raid_id,
                            discord_user_id=discord_user_id,
                            character_id=char["id"],
                        )
                        .first()
                    )
                    if existing:
                        existing.signup_type = signup_type
                        existing.status = signup_status
                    else:
                        session.add(
                            Signup(
                                raid_id=raid_id,
                                discord_user_id=discord_user_id,
                                character_id=char["id"],
                                signup_type=signup_type,
                                status=signup_status,
                            )
                        )
                session.commit()
            finally:
                session.close()

        await loop.run_in_executor(None, _upsert_all)

        is_tentative = signup_status == SignupStatus.tentative
        lines = [
            f"• **{char_label(c)}**" + (" ⭐ preferred" if c["id"] in priority_ids else "")
            for c in self.selected_chars
        ]
        if is_tentative:
            reply_prefix = "❓ Tentatively signed up for the raid:"
            log_emoji = "❓"
            log_action = "tentatively signed up"
        else:
            reply_prefix = "✅ Signed up for the raid:"
            log_emoji = "✅"
            log_action = "signed up"

        await interaction.response.edit_message(
            content=f"{reply_prefix}\n" + "\n".join(lines),
            view=None,
        )

        log_message = (
            f"{log_emoji} {interaction.user.mention} {log_action} with: "
            + ", ".join(f"**{char_label(c)}**" for c in self.selected_chars)
        )
        await post_to_raid_log(interaction.client, raid_id, log_message)
        await update_raid_embed(interaction.client, raid_id)


class SignupCharacterSelectView(discord.ui.View):
    """
    Step 1 of the sign-up flow.

    Shows the player's individual character specs in a multi-select so they
    can choose exactly which spec(s) to sign up with.  After selecting,
    transitions to SignupPrioritySelectView.
    """

    def __init__(self, char_dicts: list[dict], raid_id: int, signup_status: SignupStatus = SignupStatus.signed):
        super().__init__(timeout=120)
        self.raid_id = raid_id
        self.char_dicts = char_dicts
        self.chars_by_id = {c["id"]: c for c in char_dicts}
        self.signup_status = signup_status

        options = []
        for c in char_dicts[:25]:
            label = char_label(c)[:100]
            description = char_display_description(c)[:100]
            options.append(
                discord.SelectOption(
                    label=label,
                    description=description,
                    value=str(c["id"]),
                )
            )

        self.char_select = discord.ui.Select(
            placeholder="Choose spec(s) to sign up with…",
            options=options,
            min_values=1,
            max_values=len(options),
            row=0,
        )
        self.char_select.callback = self._on_select
        self.add_item(self.char_select)

    async def _on_select(self, interaction: discord.Interaction):
        selected_ids = {int(v) for v in interaction.data["values"]}
        selected_chars = [
            self.chars_by_id[sid] for sid in selected_ids if sid in self.chars_by_id
        ]

        names = ", ".join(char_label(c) for c in selected_chars)
        is_tentative = self.signup_status == SignupStatus.tentative
        view = SignupPrioritySelectView(selected_chars, self.raid_id, self.signup_status)
        next_step_text = (
            f"Selected: {names}\n\n"
            f"Optionally mark any as **preferred** below, then click **{'Confirm Tentative Sign Up' if is_tentative else 'Confirm Sign Up'}**."
        )
        await interaction.response.edit_message(
            content=next_step_text,
            embed=None,
            view=view,
        )


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
                return raid.status, chars_to_dicts(chars)
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
        is_tentative = signup_status == SignupStatus.tentative
        await interaction.response.send_message(
            "**Step 1 of 2:** Select the spec(s) you want to sign up tentatively with:"
            if is_tentative else
            "**Step 1 of 2:** Select the spec(s) you want to sign up with:",
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
        label="How to Sign Up",
        style=discord.ButtonStyle.secondary,
        custom_id="signup:howto",
        emoji="❓",
        row=1,
    )
    async def btn_howto(self, interaction: discord.Interaction, button: discord.ui.Button):
        await interaction.response.send_message(HOWTO_TEXT, ephemeral=True)

    @discord.ui.button(
        label="Show Characters",
        style=discord.ButtonStyle.secondary,
        custom_id="signup:show_characters",
        emoji="📋",
        row=1,
    )
    async def btn_show_characters(self, interaction: discord.Interaction, button: discord.ui.Button):
        discord_user_id = interaction.user.id
        loop = asyncio.get_event_loop()

        def _fetch():
            session = get_session()
            try:
                chars = (
                    session.query(Character)
                    .filter_by(discord_user_id=discord_user_id, is_deleted=False)
                    .order_by(Character.char_name, Character.gearscore.desc())
                    .all()
                )
                return chars_to_dicts(chars)
            finally:
                session.close()

        char_dicts = await loop.run_in_executor(None, _fetch)

        if not char_dicts:
            await interaction.response.send_message(
                "You have no registered characters. Use `/addcharacter` to add one.",
                ephemeral=True,
            )
            return

        char_groups = group_chars_by_name(char_dicts)
        lines = []
        for g in char_groups:
            parts = [g["char_name"], g["char_class"] or "Unknown"]
            if g["specs"]:
                for spec, gs, _ in g["specs"]:
                    parts.append(spec)
                    parts.append(f"{gs:.0f}")
            line = " / ".join(parts)
            lines.append(line)

        codeblock = "```\n" + "\n".join(lines) + "\n```"
        await interaction.response.send_message(codeblock, ephemeral=True)

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
            log_message = f"❌ {interaction.user.mention} withdrew from the raid."
            await post_to_raid_log(interaction.client, raid_id, log_message)
            await update_raid_embed(interaction.client, raid_id)
        else:
            await interaction.response.send_message(
                "You were not signed up for this raid.", ephemeral=True
            )


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
            CHAR_LINE_RE.match(line.strip())
            for line in content.splitlines()
            if line.strip()
        ):
            return

        random_lines = find_random_text_lines(content)
        parsed, parse_errors = parse_character_lines(content)

        all_errors: list[str] = []
        if random_lines:
            quoted = "\n".join(f"> {line}" for line in random_lines[:MAX_RANDOM_LINES_IN_ERROR])
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
                upsert_discord_user(session, message.author)
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
            CHAR_LINE_RE.match(line.strip())
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

        # ── Strict validation ────────────────────────────────────────────────
        # Now that we know this is a raid channel, validate the full message.

        # 1. Check for non-signup lines mixed in with character lines.
        random_lines = find_random_text_lines(content)

        # 2. Parse character lines with strict name + class validation.
        parsed, parse_errors = parse_character_lines(content)

        is_tentative_msg = is_tentative_message(content)
        signup_status = SignupStatus.tentative if is_tentative_msg else SignupStatus.signed

        all_errors: list[str] = []
        if random_lines:
            quoted = "\n".join(f"> {line}" for line in random_lines[:MAX_RANDOM_LINES_IN_ERROR])
            all_errors.append(
                "Your message contains text that is not a character sign-up line:\n"
                + quoted
                + "\nPlease post **only** your character sign-up lines "
                "(optionally preceded by `tentative` or `maybe` on its own line)."
            )
        all_errors.extend(parse_errors)

        if all_errors or not parsed:
            try:
                await message.delete()
            except Exception:
                pass
            if not all_errors:
                all_errors.append(
                    "No valid sign-up lines could be parsed. "
                    "Expected format: `CharName / Class / Spec / GS`"
                )
            error_text = (
                f"❌ {message.author.mention} Sign-up rejected:\n"
                + "\n".join(all_errors)
            )
            try:
                await message.channel.send(error_text)
            except Exception:
                pass
            return
        # ── end validation ───────────────────────────────────────────────────

        discord_user_id = message.author.id
        raid_id = raid_info["id"]

        def _save_and_signup():
            session = get_session()
            try:
                upsert_discord_user(session, message.author)

                # Remove ALL existing signups for this user+raid so the new message
                # fully overwrites the old sign-up instead of merging with it.
                session.query(Signup).filter_by(
                    raid_id=raid_id,
                    discord_user_id=discord_user_id,
                ).delete()

                # Accumulate spec info per char_name for grouped summary display
                char_spec_info: dict[str, dict] = {}
                for entry in parsed:
                    # Upsert character keyed on (discord_user_id, char_name, spec)
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
                    char.last_updated = datetime.datetime.now(datetime.timezone.utc)
                    session.flush()

                    # Upsert signup (one per character row per raid)
                    signup_type = (
                        SignupType.prio_character if entry["is_prio"] else SignupType.fill
                    )
                    existing = (
                        session.query(Signup)
                        .filter_by(raid_id=raid_id, discord_user_id=discord_user_id, character_id=char.id)
                        .first()
                    )
                    if existing:
                        existing.signup_type = signup_type
                        existing.status = signup_status
                        existing.is_saved = entry["is_saved"]
                        existing.note = entry.get("note") or None
                    else:
                        session.add(
                            Signup(
                                raid_id=raid_id,
                                discord_user_id=discord_user_id,
                                character_id=char.id,
                                signup_type=signup_type,
                                status=signup_status,
                                is_saved=entry["is_saved"],
                                note=entry.get("note") or None,
                            )
                        )

                    # Collect spec data for grouped summary
                    key = entry["char_name"].lower()
                    if key not in char_spec_info:
                        char_spec_info[key] = {
                            "char_name": entry["char_name"],
                            "char_class": entry["char_class"],
                            "specs": [],
                            "is_saved": entry["is_saved"],
                            "note": entry.get("note", ""),
                        }
                    char_spec_info[key]["specs"].append(
                        {
                            "spec": entry["spec"],
                            "gearscore": entry["gearscore"],
                            "is_prio": entry["is_prio"],
                        }
                    )

                session.commit()

                # Build summaries grouped by character name
                summaries = []
                for data in char_spec_info.values():
                    spec_parts = []
                    for s in data["specs"]:
                        star = " ⭐" if s["is_prio"] else ""
                        spec_parts.append(f"{s['spec']}{star} GS {format_gs(s['gearscore'])}")
                    specs_str = " / ".join(spec_parts)
                    saved_flag = " ❌" if data["is_saved"] else ""
                    note_str = f" 💬 *{data['note']}*" if data.get("note") else ""
                    summaries.append(
                        f"• **{data['char_name']}** ({data['char_class']}) – {specs_str}{saved_flag}{note_str}"
                    )
                return summaries
            finally:
                session.close()

        try:
            summaries = await loop.run_in_executor(None, _save_and_signup)
        except Exception:
            logger.exception("Failed to process chat character sign-up from %s", discord_user_id)
            return

        if signup_status == SignupStatus.tentative:
            log_message = (
                f"❓ {message.author.mention} tentatively signed up for **{raid_info['name']}**:\n"
                + "\n".join(summaries)
            )
        else:
            log_message = (
                f"✅ {message.author.mention} signed up for **{raid_info['name']}**:\n"
                + "\n".join(summaries)
            )

        # Delete the user's message to keep the channel clean
        try:
            await message.delete()
        except Exception:
            pass

        # Post sign-up summary to the log thread; fall back to channel if no thread exists
        log_thread_id = raid_info.get("discord_log_thread_id")
        if log_thread_id:
            try:
                thread = self.bot.get_channel(log_thread_id)
                if thread is None:
                    thread = await self.bot.fetch_channel(log_thread_id)
                await thread.send(log_message)
            except Exception:
                logger.warning("Failed to post to log thread, falling back to channel")
                try:
                    await message.channel.send(log_message)
                except Exception:
                    pass
        else:
            try:
                await message.channel.send(log_message)
            except Exception:
                pass

        # Refresh the raid embed
        await update_raid_embed(self.bot, raid_id)


async def setup(bot: commands.Bot):
    await bot.add_cog(SignupCog(bot))
