from __future__ import annotations

import asyncio
import logging
from typing import Optional

import discord
from discord.ext import commands

from bot.db import get_session
from db.models import Character, Raid, RaidStatus, Signup, SignupStatus, SignupType

logger = logging.getLogger(__name__)


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


class CharacterSelectView(discord.ui.View):
    """Shown when a user has multiple characters and needs to pick one."""

    def __init__(self, characters: list[Character], raid_id: int, signup_type: SignupType, preferred_role: str | None = None):
        super().__init__(timeout=60)
        self.raid_id = raid_id
        self.signup_type = signup_type
        self.preferred_role = preferred_role

        options = [
            discord.SelectOption(
                label=f"{c.char_name} ({c.realm})",
                description=f"{c.char_class or '?'} – GS {c.gearscore:.0f}",
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


async def _process_signup(
    interaction: discord.Interaction,
    raid_id: int,
    character_id: int,
    signup_type: SignupType,
    preferred_role: str | None = None,
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
            else:
                new_signup = Signup(
                    raid_id=raid_id,
                    discord_user_id=discord_user_id,
                    character_id=character_id,
                    signup_type=signup_type,
                    status=SignupStatus.signed,
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

    msg = f"✅ Signed up as **{char_display}** ({type_label})!"
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
        label="Withdraw",
        style=discord.ButtonStyle.secondary,
        custom_id="signup:withdraw",
        emoji="❌",
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


async def setup(bot: commands.Bot):
    await bot.add_cog(SignupCog(bot))
