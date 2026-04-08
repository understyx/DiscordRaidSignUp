from __future__ import annotations

import asyncio
import datetime
import logging
import re
from typing import Optional

import discord
from discord.ext import commands

from bot.db import get_session
from db.models import Character, Raid, RaidStatus, Signup, SignupStatus, SignupType

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Chat message parser helpers
# ---------------------------------------------------------------------------

# Matches: CharName / CharClass / Spec / GS [/ Spec / GS ...] [⭐ or ❌]
# Requires at least 4 slash-separated parts (name, class, spec, gs).
_CHAR_LINE_RE = re.compile(r"^[^\s/].+/.+/.+/.+", re.IGNORECASE)


def _parse_character_lines(text: str) -> list[dict]:
    """
    Parse one or more character lines from a message body.

    Supported format (one per line)::

        CharName / CharClass / Spec1 / GS1 [/ Spec2 / GS2 ...] [⭐ or ❌]

    ⭐  = priority character
    ❌  = saved character (already saved this lockout)

    Returns a list of dicts with keys:
        char_name, char_class, spec, gearscore, is_prio (bool), is_saved (bool)

    One dict is returned per unique character name (first spec/GS pair is used
    as the primary spec and gearscore).
    """
    results = []
    seen_names: set[str] = set()

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or not _CHAR_LINE_RE.match(line):
            continue

        is_prio = "⭐" in line or "★" in line
        is_saved = "❌" in line or "✗" in line

        # Strip flag characters before splitting
        clean = line.replace("⭐", "").replace("★", "").replace("❌", "").replace("✗", "").strip()

        parts = [p.strip() for p in clean.split("/")]
        # Need at least: CharName / CharClass / Spec / GS
        if len(parts) < 4:
            continue

        char_name = parts[0].strip()
        char_class = parts[1].strip()
        if not char_name or not char_class:
            continue

        name_key = char_name.lower()
        if name_key in seen_names:
            continue

        # Remaining parts alternate: spec, gs, spec, gs, …
        spec_gs = parts[2:]
        if len(spec_gs) < 2:
            continue

        spec = spec_gs[0].strip()
        try:
            gs = float(spec_gs[1].strip().replace(",", "."))
        except ValueError:
            continue

        if spec:
            seen_names.add(name_key)
            results.append(
                {
                    "char_name": char_name.capitalize(),
                    "char_class": char_class,
                    "spec": spec,
                    "gearscore": gs,
                    "is_prio": is_prio,
                    "is_saved": is_saved,
                }
            )

    return results


def _build_signup_embed(raid: Raid, signups: list) -> discord.Embed:
    tanks = [s for s in signups if s.get("role") == "tank"]
    healers = [s for s in signups if s.get("role") == "healer"]
    dps = [s for s in signups if s.get("role") not in ("tank", "healer")]

    status_emoji = {"open": "🟢", "locked": "🔒", "posted": "📋"}.get(
        raid.get("status", "open"), "🟢"
    )
    is_open = raid.get("status", "open") == "open"

    embed = discord.Embed(
        title=f"⚔️ {raid['name']}",
        description=raid.get("description") or "",
        color=discord.Color.gold() if is_open else discord.Color.red(),
    )
    embed.add_field(name="📍 Instance", value=raid["raid_instance"], inline=True)
    embed.add_field(
        name="📅 Date",
        value=raid["date"].strftime("%Y-%m-%d %H:%M UTC"),
        inline=True,
    )
    embed.add_field(name="Status", value=f"{status_emoji} {raid['status'].capitalize()}", inline=True)
    embed.add_field(name="🛡️ Tanks", value=str(len(tanks)), inline=True)
    embed.add_field(name="💚 Healers", value=str(len(healers)), inline=True)
    embed.add_field(name="⚔️ DPS", value=str(len(dps)), inline=True)
    embed.add_field(name="Total", value=f"{len(signups)} / {raid['max_size']}", inline=False)
    embed.set_footer(text=f"Raid ID: {raid['id']}")
    return embed


async def update_raid_embed(bot: discord.Client, raid_id: int):
    """Fetch raid + signups and edit the original Discord message."""
    loop = asyncio.get_event_loop()

    def _fetch():
        session = get_session()
        try:
            raid = session.get(Raid, raid_id)
            if raid is None:
                return None, None
            sups = session.query(Signup).filter_by(raid_id=raid_id).all()
            signup_data = []
            for s in sups:
                signup_data.append(
                    {
                        "role": s.character.role.value if (s.character and s.character.role) else None,
                    }
                )
            raid_data = {
                "id": raid.id,
                "name": raid.name,
                "date": raid.date,
                "raid_instance": raid.raid_instance,
                "description": raid.description,
                "max_size": raid.max_size,
                "status": raid.status.value if raid.status else "open",
                "discord_message_id": raid.discord_message_id,
                "discord_channel_id": raid.discord_channel_id,
            }
            return raid_data, signup_data
        finally:
            session.close()

    raid_data, signup_data = await loop.run_in_executor(None, _fetch)

    if not raid_data or not raid_data.get("discord_message_id"):
        return

    try:
        channel = bot.get_channel(raid_data["discord_channel_id"])
        if channel is None:
            channel = await bot.fetch_channel(raid_data["discord_channel_id"])
        msg = await channel.fetch_message(raid_data["discord_message_id"])
        embed = _build_signup_embed(raid_data, signup_data)
        is_locked = raid_data["status"] != "open"
        view = None if is_locked else SignupView()
        await msg.edit(embed=embed, view=view)
    except Exception as e:
        logger.warning(f"Failed to update raid embed for raid {raid_id}: {e}")


def _chars_to_dicts(characters) -> list[dict]:
    """Serialize Character ORM objects to plain dicts (safe to use after session close)."""
    return [
        {
            "id": c.id,
            "char_name": c.char_name,
            "realm": c.realm,
            "char_class": c.char_class,
            "spec": c.spec,
            "gearscore": c.gearscore or 0.0,
        }
        for c in characters
    ]


def _char_display_description(char: dict) -> str:
    """Return a short spec/class/GS description string for a character dict."""
    spec_or_class = char["spec"] if char["spec"] else (char["char_class"] or "?")
    return f"{spec_or_class} – GS {char['gearscore']:.0f}"


def _group_chars_by_name(char_dicts: list[dict]) -> list[dict]:
    """
    Group per-spec character rows by character name.

    Each unique char_name becomes one group dict with:
        id         – primary character ID (spec with the highest gearscore)
        char_name  – character name
        realm      – realm name
        char_class – class string
        spec       – primary spec name (highest GS)
        gearscore  – highest gearscore across all specs
        specs      – list of (spec, gearscore, id) tuples sorted by GS descending
    """
    groups: dict[str, dict] = {}
    for c in char_dicts:
        key = c["char_name"].lower()
        if key not in groups:
            groups[key] = {
                "id": c["id"],
                "char_name": c["char_name"],
                "realm": c.get("realm", ""),
                "char_class": c.get("char_class"),
                "spec": c.get("spec"),
                "gearscore": c.get("gearscore", 0.0),
                "specs": [],
            }
        spec = c.get("spec")
        gs = c.get("gearscore", 0.0)
        if spec:
            groups[key]["specs"].append((spec, gs, c["id"]))

    result = []
    for group in groups.values():
        group["specs"].sort(key=lambda x: x[1], reverse=True)
        if group["specs"]:
            group["id"] = group["specs"][0][2]
            group["spec"] = group["specs"][0][0]
            group["gearscore"] = group["specs"][0][1]
        result.append(group)
    return result


class CharacterSelectView(discord.ui.View):
    """Shown when a user has multiple characters and needs to pick one."""

    def __init__(self, characters: list[Character], raid_id: int, signup_type: SignupType, preferred_role: str | None = None):
        super().__init__(timeout=60)
        self.raid_id = raid_id
        self.signup_type = signup_type
        self.preferred_role = preferred_role

        options = [
            discord.SelectOption(
                label=f"{c.char_name} ({c.realm})"[:100],
                description=(
                    f"{c.spec or c.char_class or '?'} – GS {c.gearscore:.0f}"
                )[:100],
                value=str(c.id),
            )
            for c in characters[:25]  # Discord max 25 options
        ]

        select = discord.ui.Select(placeholder="Choose a character…", options=options)
        select.callback = self._on_select
        self.add_item(select)

    async def _on_select(self, interaction: discord.Interaction):
        char_id = int(interaction.data["values"][0])
        await _process_signup(interaction, self.raid_id, char_id, self.signup_type, self.preferred_role)
        self.stop()


class SignupPrioritySelectView(discord.ui.View):
    """
    Step 2 of the multi-character sign-up flow.

    Shows the characters the player has chosen to sign up with and lets them
    optionally mark any of them as priority.  A Confirm button submits all
    the signups.
    """

    def __init__(self, selected_chars: list[dict], raid_id: int):
        super().__init__(timeout=120)
        self.raid_id = raid_id
        self.selected_chars = selected_chars

        options = [
            discord.SelectOption(
                label=c["char_name"][:100],
                description=_char_display_description(c)[:100],
                value=str(c["id"]),
            )
            for c in selected_chars[:25]
        ]

        self.priority_select = discord.ui.Select(
            placeholder="Mark priority characters (optional)…",
            options=options,
            min_values=0,
            max_values=len(options),
            row=0,
        )
        self.priority_select.callback = self._on_priority_select
        self.add_item(self.priority_select)

    async def _on_priority_select(self, interaction: discord.Interaction):
        """Acknowledge the select interaction; values are read when Confirm is pressed."""
        await interaction.response.defer()

    @discord.ui.button(
        label="Confirm Sign Up",
        style=discord.ButtonStyle.success,
        emoji="✅",
        row=1,
    )
    async def confirm(self, interaction: discord.Interaction, button: discord.ui.Button):
        priority_ids = {int(v) for v in (self.priority_select.values or [])}
        discord_user_id = interaction.user.id
        raid_id = self.raid_id
        loop = asyncio.get_event_loop()

        def _upsert_all():
            session = get_session()
            try:
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
                        existing.status = SignupStatus.signed
                    else:
                        session.add(
                            Signup(
                                raid_id=raid_id,
                                discord_user_id=discord_user_id,
                                character_id=char["id"],
                                signup_type=signup_type,
                                status=SignupStatus.signed,
                            )
                        )
                session.commit()
            finally:
                session.close()

        await loop.run_in_executor(None, _upsert_all)

        lines = [
            f"• **{c['char_name']}**{' ⭐ priority' if c['id'] in priority_ids else ''}"
            for c in self.selected_chars
        ]
        await interaction.response.edit_message(
            content=f"✅ Signed up for the raid:\n" + "\n".join(lines),
            view=None,
        )
        await update_raid_embed(interaction.client, raid_id)


class SignupCharacterSelectView(discord.ui.View):
    """
    Step 1 of the multi-character sign-up flow.

    Shows the player's characters (grouped by name) in a multi-select.
    Each option shows the character name, class, and all their specs/GS.
    After selecting, transitions to SignupPrioritySelectView.
    """

    def __init__(self, char_groups: list[dict], raid_id: int):
        super().__init__(timeout=120)
        self.raid_id = raid_id
        self.char_groups = char_groups
        self.groups_by_id = {g["id"]: g for g in char_groups}

        options = []
        for g in char_groups[:25]:
            label = f"{g['char_name']} ({g['char_class'] or '?'})"[:100]
            if g["specs"]:
                spec_parts = [f"{s} {gs:.0f}" for s, gs, _ in g["specs"][:4]]
                desc = " / ".join(spec_parts)
            else:
                desc = g["char_class"] or "?"
            options.append(
                discord.SelectOption(
                    label=label,
                    description=desc[:100],
                    value=str(g["id"]),
                )
            )

        self.char_select = discord.ui.Select(
            placeholder="Choose characters to sign up with…",
            options=options,
            min_values=1,
            max_values=len(options),
            row=0,
        )
        self.char_select.callback = self._on_select
        self.add_item(self.char_select)

    async def _on_select(self, interaction: discord.Interaction):
        selected_ids = {int(v) for v in interaction.data["values"]}
        selected_groups = [
            self.groups_by_id[sid] for sid in selected_ids if sid in self.groups_by_id
        ]
        # Convert groups to char dicts expected by SignupPrioritySelectView
        selected_chars = [
            {
                "id": g["id"],
                "char_name": g["char_name"],
                "char_class": g["char_class"],
                "spec": g["spec"],
                "gearscore": g["gearscore"],
            }
            for g in selected_groups
        ]

        names = ", ".join(f"**{c['char_name']}**" for c in selected_chars)
        view = SignupPrioritySelectView(selected_chars, self.raid_id)
        await interaction.response.edit_message(
            content=(
                f"Selected: {names}\n\n"
                "Optionally mark any as **priority** below, then click **Confirm Sign Up**."
            ),
            embed=None,
            view=view,
        )


async def _process_signup(
    interaction: discord.Interaction,
    raid_id: int,
    character_id: int,
    signup_type: SignupType,
    preferred_role: str | None = None,
    is_saved: bool = False,
):
    """Upsert signup, optionally update character role, and refresh the raid embed."""
    discord_user_id = interaction.user.id
    loop = asyncio.get_event_loop()

    def _upsert():
        session = get_session()
        try:
            existing = (
                session.query(Signup)
                .filter_by(raid_id=raid_id, discord_user_id=discord_user_id)
                .first()
            )
            if existing:
                existing.character_id = character_id
                existing.signup_type = signup_type
                existing.status = SignupStatus.signed
                existing.is_saved = is_saved
            else:
                new_signup = Signup(
                    raid_id=raid_id,
                    discord_user_id=discord_user_id,
                    character_id=character_id,
                    signup_type=signup_type,
                    status=SignupStatus.signed,
                    is_saved=is_saved,
                )
                session.add(new_signup)

            # Update character role if a preferred role was specified
            if preferred_role:
                from db.models import CharacterRole
                char = session.get(Character, character_id)
                if char:
                    try:
                        char.role = CharacterRole(preferred_role)
                    except ValueError:
                        pass

            session.commit()
        finally:
            session.close()

    await loop.run_in_executor(None, _upsert)

    char_info = None

    def _get_char():
        session = get_session()
        try:
            c = session.get(Character, character_id)
            if c:
                return {"name": c.char_name, "realm": c.realm, "char_class": c.char_class}
            return None
        finally:
            session.close()

    char_info = await loop.run_in_executor(None, _get_char)

    char_display = (
        f"{char_info['name']} ({char_info['realm']})" if char_info else "your character"
    )

    type_label = {
        SignupType.fill: "Fill",
        SignupType.prio_role: "Prio (Role)",
        SignupType.prio_character: "Prio (Character)",
    }.get(signup_type, signup_type.value)

    saved_label = " ❌ *Saved*" if is_saved else ""
    msg = f"✅ Signed up as **{char_display}** ({type_label}){saved_label}!"
    if interaction.response.is_done():
        await interaction.followup.send(msg, ephemeral=True)
    else:
        await interaction.response.send_message(msg, ephemeral=True)

    # Update the raid embed counters
    await update_raid_embed(interaction.client, raid_id)


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

    async def _handle_button(
        self,
        interaction: discord.Interaction,
        signup_type: SignupType,
        preferred_role: str | None = None,
    ):
        raid_id = self._get_raid_id(interaction)
        if raid_id is None:
            await interaction.response.send_message(
                "❌ Could not determine raid ID from this message.", ephemeral=True
            )
            return

        # Check raid is still open
        loop = asyncio.get_event_loop()

        def _check_raid():
            session = get_session()
            try:
                raid = session.get(Raid, raid_id)
                return raid.status if raid else None
            finally:
                session.close()

        status = await loop.run_in_executor(None, _check_raid)
        if status != RaidStatus.open:
            await interaction.response.send_message(
                "❌ This raid is no longer accepting sign-ups.", ephemeral=True
            )
            return

        discord_user_id = interaction.user.id

        def _get_chars():
            session = get_session()
            try:
                return (
                    session.query(Character)
                    .filter_by(discord_user_id=discord_user_id)
                    .all()
                )
            finally:
                session.close()

        chars = await loop.run_in_executor(None, _get_chars)

        if not chars:
            await interaction.response.send_message(
                "❌ You have no registered characters. Use `/register_character` first.",
                ephemeral=True,
            )
            return

        if len(chars) == 1:
            await _process_signup(interaction, raid_id, chars[0].id, signup_type, preferred_role)
        else:
            view = CharacterSelectView(chars, raid_id, signup_type, preferred_role)
            await interaction.response.send_message(
                "Choose which character to sign up with:", view=view, ephemeral=True
            )

    @discord.ui.button(
        label="Fill",
        style=discord.ButtonStyle.secondary,
        custom_id="signup:fill",
        emoji="📋",
    )
    async def btn_fill(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self._handle_button(interaction, SignupType.fill)

    @discord.ui.button(
        label="Tank",
        style=discord.ButtonStyle.primary,
        custom_id="signup:tank",
        emoji="🛡️",
    )
    async def btn_tank(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self._handle_button(interaction, SignupType.prio_role, preferred_role="tank")

    @discord.ui.button(
        label="Healer",
        style=discord.ButtonStyle.success,
        custom_id="signup:healer",
        emoji="💚",
    )
    async def btn_healer(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self._handle_button(interaction, SignupType.prio_role, preferred_role="healer")

    @discord.ui.button(
        label="DPS",
        style=discord.ButtonStyle.danger,
        custom_id="signup:dps",
        emoji="⚔️",
    )
    async def btn_dps(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self._handle_button(interaction, SignupType.prio_role, preferred_role="dps")

    @discord.ui.button(
        label="Sign Up",
        style=discord.ButtonStyle.success,
        custom_id="signup:multi",
        emoji="✅",
        row=1,
    )
    async def btn_signup(self, interaction: discord.Interaction, button: discord.ui.Button):
        """Open the multi-character sign-up flow."""
        raid_id = self._get_raid_id(interaction)
        if raid_id is None:
            await interaction.response.send_message(
                "❌ Could not determine raid ID from this message.", ephemeral=True
            )
            return

        loop = asyncio.get_event_loop()

        def _check_raid():
            session = get_session()
            try:
                raid = session.get(Raid, raid_id)
                return raid.status if raid else None
            finally:
                session.close()

        status = await loop.run_in_executor(None, _check_raid)
        if status != RaidStatus.open:
            await interaction.response.send_message(
                "❌ This raid is no longer accepting sign-ups.", ephemeral=True
            )
            return

        discord_user_id = interaction.user.id

        def _get_chars():
            session = get_session()
            try:
                chars = (
                    session.query(Character)
                    .filter_by(discord_user_id=discord_user_id)
                    .all()
                )
                return _chars_to_dicts(chars)
            finally:
                session.close()

        char_dicts = await loop.run_in_executor(None, _get_chars)

        if not char_dicts:
            await interaction.response.send_message(
                "❌ You have no registered characters. Post a sign-up line or use `/addcharacter` first.",
                ephemeral=True,
            )
            return

        view = SignupCharacterSelectView(char_dicts, raid_id)
        await interaction.response.send_message(
            "Choose which characters to sign up with:", view=view, ephemeral=True
        )

    @discord.ui.button(
        label="Withdraw",
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
                existing = (
                    session.query(Signup)
                    .filter_by(raid_id=raid_id, discord_user_id=discord_user_id)
                    .first()
                )
                if existing:
                    session.delete(existing)
                    session.commit()
                    return True
                return False
            finally:
                session.close()

        removed = await loop.run_in_executor(None, _withdraw)

        if removed:
            await interaction.response.send_message("✅ Withdrawn from the raid.", ephemeral=True)
            await update_raid_embed(interaction.client, raid_id)
        else:
            await interaction.response.send_message(
                "You were not signed up for this raid.", ephemeral=True
            )


class SignupCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    # ── on_message: character list parser ─────────────────────────────────
    @commands.Cog.listener()
    async def on_message(self, message: discord.Message):
        """
        Parse character sign-up lines posted in raid channels.

        Format (one character per line)::

            CharName / CharClass / Spec1 / GS1 [/ Spec2 / GS2 ...] [⭐ or ❌]

        ⭐  = priority character (maps to prio_character signup type)
        ❌  = saved character (ID-locked; marks signup as is_saved=True)

        Characters are upserted by (discord_user_id, char_name) – one row
        per character.  The primary spec/GS (first pair) is stored.

        The bot only acts in channels that have an active (open) raid.
        It saves/updates the character(s) in the DB and auto-signs the
        player up for the raid.  A summary reply is sent to the channel.
        """
        # Ignore bot messages and DMs
        if message.author.bot or not message.guild:
            return

        parsed = _parse_character_lines(message.content)
        if not parsed:
            return

        loop = asyncio.get_event_loop()
        channel_id = message.channel.id

        # Find an open raid in this channel
        def _find_raid():
            session = get_session()
            try:
                raid = (
                    session.query(Raid)
                    .filter_by(discord_channel_id=channel_id, status=RaidStatus.open)
                    .order_by(Raid.id.desc())
                    .first()
                )
                if raid:
                    return {"id": raid.id, "name": raid.name}
                return None
            finally:
                session.close()

        raid_info = await loop.run_in_executor(None, _find_raid)
        if not raid_info:
            return  # Not a raid channel with an open raid; ignore silently

        discord_user_id = message.author.id
        raid_id = raid_info["id"]

        def _save_and_signup():
            session = get_session()
            try:
                summaries = []
                for entry in parsed:
                    # Upsert character keyed on (discord_user_id, char_name)
                    char = (
                        session.query(Character)
                        .filter_by(
                            discord_user_id=discord_user_id,
                            char_name=entry["char_name"],
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

                    # Upsert signup (one per character per raid)
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
                        existing.status = SignupStatus.signed
                        existing.is_saved = entry["is_saved"]
                    else:
                        session.add(
                            Signup(
                                raid_id=raid_id,
                                discord_user_id=discord_user_id,
                                character_id=char.id,
                                signup_type=signup_type,
                                status=SignupStatus.signed,
                                is_saved=entry["is_saved"],
                            )
                        )

                    flag = ""
                    if entry["is_prio"]:
                        flag = " ⭐"
                    elif entry["is_saved"]:
                        flag = " ❌"
                    summaries.append(
                        f"• **{entry['char_name']}** ({entry['char_class']}) – {entry['spec']} GS {entry['gearscore']:.0f}{flag}"
                    )

                session.commit()
                return summaries
            finally:
                session.close()

        try:
            summaries = await loop.run_in_executor(None, _save_and_signup)
        except Exception:
            logger.exception("Failed to process chat character sign-up from %s", discord_user_id)
            return

        reply = (
            f"✅ {message.author.mention} signed up for **{raid_info['name']}**:\n"
            + "\n".join(summaries)
        )
        try:
            await message.reply(reply, mention_author=False)
        except Exception:
            pass

        # Refresh the raid embed
        await update_raid_embed(self.bot, raid_id)


async def setup(bot: commands.Bot):
    await bot.add_cog(SignupCog(bot))
