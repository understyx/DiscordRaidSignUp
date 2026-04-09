from __future__ import annotations

import asyncio
import datetime
import logging
from dataclasses import dataclass, field
from typing import Optional

import discord
from discord import app_commands
from discord.ext import commands

from bot.config import OFFICER_ROLE_NAME
from bot.db import get_session
from db.models import Character, Composition, Raid, RaidStatus, Signup

logger = logging.getLogger(__name__)


@dataclass
class _RaidEmbed:
    """Lightweight dataclass used to build a signup embed before the DB object is available."""
    id: int
    name: str
    date: datetime.datetime
    raid_instance: str
    description: str
    max_size: int
    status: RaidStatus = field(default=RaidStatus.open)


def is_officer():
    """App-command check: user must have OFFICER_ROLE_NAME or manage_guild permission."""

    async def predicate(interaction: discord.Interaction) -> bool:
        if interaction.user.guild_permissions.manage_guild:
            return True
        return any(r.name == OFFICER_ROLE_NAME for r in interaction.user.roles)

    return app_commands.check(predicate)


def _build_signup_embed(raid: Raid, signups: list[Signup]) -> discord.Embed:
    unique_players = len(set(
        s.discord_user_id for s in signups if s.discord_user_id
    ))

    status_emoji = {"open": "🟢", "locked": "🔒", "posted": "📋"}.get(
        raid.status.value if raid.status else "open", "🟢"
    )

    embed = discord.Embed(
        title=f"⚔️ {raid.name}",
        description=raid.description or "",
        color=discord.Color.gold() if raid.status == RaidStatus.open else discord.Color.red(),
    )
    embed.add_field(name="📍 Instance", value=raid.raid_instance, inline=True)
    embed.add_field(
        name="📅 Date",
        value=raid.date.strftime("%Y-%m-%d %H:%M UTC"),
        inline=True,
    )
    embed.add_field(name="Status", value=f"{status_emoji} {raid.status.value.capitalize()}", inline=True)
    embed.add_field(
        name="👥 Players Signed Up",
        value=f"{unique_players} / {raid.max_size}",
        inline=False,
    )
    embed.set_footer(text=f"Raid ID: {raid.id}")
    return embed


class CreateRaidModal(discord.ui.Modal, title="Create Raid"):
    raid_name = discord.ui.TextInput(label="Raid Name", max_length=100)
    raid_instance = discord.ui.TextInput(label="Raid Instance", max_length=100, placeholder="e.g. ICC 25")
    raid_date = discord.ui.TextInput(
        label="Date (YYYY-MM-DD HH:MM)",
        placeholder="2024-12-31 20:00",
        max_length=16,
    )
    description = discord.ui.TextInput(
        label="Description",
        style=discord.TextStyle.paragraph,
        required=False,
        max_length=500,
    )
    max_size = discord.ui.TextInput(label="Max Size", default="25", max_length=3)

    async def on_submit(self, interaction: discord.Interaction):
        try:
            raid_dt = datetime.datetime.strptime(
                self.raid_date.value.strip(), "%Y-%m-%d %H:%M"
            ).replace(tzinfo=datetime.timezone.utc)
        except ValueError:
            await interaction.response.send_message(
                "❌ Invalid date format. Use `YYYY-MM-DD HH:MM`.", ephemeral=True
            )
            return

        try:
            size = int(self.max_size.value.strip())
        except ValueError:
            size = 25

        discord_user_id = interaction.user.id
        loop = asyncio.get_running_loop()

        try:
            def _create():
                session = get_session()
                try:
                    raid = Raid(
                        name=self.raid_name.value.strip(),
                        date=raid_dt,
                        description=self.description.value.strip() if self.description.value else "",
                        raid_instance=self.raid_instance.value.strip(),
                        max_size=size,
                        status=RaidStatus.open,
                        created_by=discord_user_id,
                    )
                    session.add(raid)
                    session.commit()
                    session.refresh(raid)
                    return raid.id, raid.name, raid.date, raid.raid_instance, raid.description, raid.max_size
                finally:
                    session.close()

            raid_id, name, date, instance, desc, max_size = await loop.run_in_executor(None, _create)
        except Exception:
            logger.exception("Failed to create raid in database")
            await interaction.response.send_message(
                "❌ Failed to create raid. Please try again later.", ephemeral=True
            )
            return

        fake = _RaidEmbed(
            id=raid_id,
            name=name,
            date=date,
            raid_instance=instance,
            description=desc,
            max_size=max_size,
        )

        from bot.cogs.signup import SignupView

        embed = _build_signup_embed(fake, [])  # type: ignore[arg-type]
        view = SignupView()

        await interaction.response.send_message(embed=embed, view=view)
        msg = await interaction.original_response()

        # Store discord_message_id and discord_channel_id
        def _store_msg():
            session = get_session()
            try:
                raid = session.get(Raid, raid_id)
                if raid:
                    raid.discord_message_id = msg.id
                    raid.discord_channel_id = interaction.channel_id
                    session.commit()
            finally:
                session.close()

        try:
            await loop.run_in_executor(None, _store_msg)
        except Exception:
            logger.warning("Failed to store discord_message_id for raid %s", raid_id, exc_info=True)

        # Create "How to Sign Up" thread on the raid embed message and a standalone log thread
        try:
            howto_thread = await msg.create_thread(
                name="📖 How to Sign Up",
                auto_archive_duration=10080,  # 7 days in minutes
            )
            await howto_thread.send(
                "**How to Sign Up for the Raid**\n\n"
                "**Method 1: Use `/addcharacter` then click the Sign Up button**\n"
                "1. Register your character: `/addcharacter name:<name> spec1:<spec> gs1:<gearscore>`\n"
                "2. Click the **✅ Sign Up** (or **❓ Tentative**) button on the raid message\n"
                "3. Select your character(s), optionally mark priority, then confirm\n\n"
                "**Method 2: Post your character(s) as a text message in this channel**\n"
                "Post one character per line in this format:\n"
                "```\nCharName / Class / Spec / GS\n```\n"
                "Example: `Thralladin / Paladin / Holy / 5800`\n"
                "Multiple specs: `Thralladin / Paladin / Holy / 5800 / Ret / 5600`\n"
                "Add ⭐ to mark as priority, ❌ if already saved this lockout.\n\n"
                "*Your message will be deleted automatically and a sign-up summary will be posted in the log thread.*"
            )

            channel = interaction.channel
            log_thread = await channel.create_thread(
                name=f"📋 {name} – Sign-Up Log",
                auto_archive_duration=10080,  # 7 days in minutes
                type=discord.ChannelType.public_thread,
            )
            await log_thread.send(f"📋 **Sign-Up Log for {name}**\nPlayer sign-ups will be recorded here.")

            def _store_log_thread():
                session = get_session()
                try:
                    raid = session.get(Raid, raid_id)
                    if raid:
                        raid.discord_log_thread_id = log_thread.id
                        session.commit()
                finally:
                    session.close()

            await loop.run_in_executor(None, _store_log_thread)
        except Exception:
            logger.warning("Failed to create raid threads for raid %s", raid_id, exc_info=True)

    async def on_error(self, interaction: discord.Interaction, error: Exception) -> None:
        logger.exception("Unhandled error in CreateRaidModal", exc_info=error)
        msg = "❌ An unexpected error occurred. Please try again later."
        try:
            if interaction.response.is_done():
                await interaction.followup.send(msg, ephemeral=True)
            else:
                await interaction.response.send_message(msg, ephemeral=True)
        except Exception:
            pass


class RaidCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    # ── /create_raid ───────────────────────────────────────────────────────
    @app_commands.command(name="create_raid", description="Create a new raid (Officer only).")
    @is_officer()
    async def create_raid(self, interaction: discord.Interaction):
        await interaction.response.send_modal(CreateRaidModal())

    # ── /view_signups ──────────────────────────────────────────────────────
    @app_commands.command(name="view_signups", description="View sign-ups for a raid.")
    @app_commands.describe(raid_id="The raid ID")
    @is_officer()
    async def view_signups(self, interaction: discord.Interaction, raid_id: int):
        await interaction.response.defer(ephemeral=True, thinking=True)
        loop = asyncio.get_event_loop()

        def _fetch():
            session = get_session()
            try:
                raid = session.get(Raid, raid_id)
                if raid is None:
                    return None, []
                signups = (
                    session.query(Signup)
                    .filter_by(raid_id=raid_id)
                    .join(Character)
                    .order_by(Character.role, Character.gearscore.desc())
                    .all()
                )
                # Detach data
                result = []
                for s in signups:
                    result.append(
                        {
                            "signup_type": s.signup_type.value if s.signup_type else "fill",
                            "char_name": s.character.char_name if s.character else "?",
                            "char_class": s.character.char_class if s.character else "?",
                            "gearscore": s.character.gearscore if s.character else 0,
                            "role": s.character.role.value if (s.character and s.character.role) else "?",
                        }
                    )
                return (
                    {"id": raid.id, "name": raid.name},
                    result,
                )
            finally:
                session.close()

        raid_info, signups = await loop.run_in_executor(None, _fetch)

        if raid_info is None:
            await interaction.followup.send(f"❌ Raid #{raid_id} not found.", ephemeral=True)
            return

        embed = discord.Embed(
            title=f"Sign-ups for {raid_info['name']} (ID {raid_info['id']})",
            color=discord.Color.blurple(),
        )

        groups: dict[str, list[str]] = {}
        for s in signups:
            key = f"{s['signup_type']} / {s['role']}"
            groups.setdefault(key, [])
            groups[key].append(f"{s['char_name']} ({s['char_class']}) GS: {s['gearscore']:.0f}")

        for group, entries in groups.items():
            embed.add_field(name=group.upper(), value="\n".join(entries) or "—", inline=False)

        if not groups:
            embed.description = "No sign-ups yet."

        await interaction.followup.send(embed=embed, ephemeral=True)

    # ── /lock_raid ─────────────────────────────────────────────────────────
    @app_commands.command(name="lock_raid", description="Lock a raid (no more sign-ups).")
    @app_commands.describe(raid_id="The raid ID to lock")
    @is_officer()
    async def lock_raid(self, interaction: discord.Interaction, raid_id: int):
        await interaction.response.defer(ephemeral=True, thinking=True)
        loop = asyncio.get_event_loop()

        def _lock():
            session = get_session()
            try:
                raid = session.get(Raid, raid_id)
                if raid is None:
                    return None
                raid.status = RaidStatus.locked
                session.commit()
                return {
                    "id": raid.id,
                    "name": raid.name,
                    "discord_message_id": raid.discord_message_id,
                    "discord_channel_id": raid.discord_channel_id,
                }
            finally:
                session.close()

        raid_info = await loop.run_in_executor(None, _lock)

        if raid_info is None:
            await interaction.followup.send(f"❌ Raid #{raid_id} not found.", ephemeral=True)
            return

        # Try to edit the original embed
        if raid_info["discord_channel_id"] and raid_info["discord_message_id"]:
            try:
                channel = self.bot.get_channel(raid_info["discord_channel_id"])
                if channel:
                    msg = await channel.fetch_message(raid_info["discord_message_id"])

                    def _fetch_signups():
                        session = get_session()
                        try:
                            raid = session.get(Raid, raid_id)
                            sups = session.query(Signup).filter_by(raid_id=raid_id).all()
                            return raid, sups
                        finally:
                            session.close()

                    raid, sups = await loop.run_in_executor(None, _fetch_signups)
                    embed = _build_signup_embed(raid, sups)

                    # Disable all buttons
                    from bot.cogs.signup import SignupView
                    locked_view = discord.ui.View()
                    await msg.edit(embed=embed, view=locked_view)
            except Exception as e:
                logger.warning(f"Could not edit raid message: {e}")

        await interaction.followup.send(
            f"🔒 Raid **{raid_info['name']}** (#{raid_id}) is now locked.", ephemeral=True
        )

    # ── /post_comp ─────────────────────────────────────────────────────────
    @app_commands.command(name="post_comp", description="Post the finalized raid composition.")
    @app_commands.describe(raid_id="The raid ID")
    @is_officer()
    async def post_comp(self, interaction: discord.Interaction, raid_id: int):
        await interaction.response.defer(thinking=True)
        loop = asyncio.get_event_loop()

        def _fetch():
            session = get_session()
            try:
                raid = session.get(Raid, raid_id)
                if raid is None:
                    return None, []
                comps = (
                    session.query(Composition)
                    .filter_by(raid_id=raid_id)
                    .join(Character, Composition.character_id == Character.id)
                    .order_by(Composition.role_slot)
                    .all()
                )
                result = []
                for c in comps:
                    result.append(
                        {
                            "role_slot": c.role_slot,
                            "char_name": c.character.char_name if c.character else "?",
                            "char_class": c.character.char_class if c.character else "?",
                            "spec": c.character.spec if c.character else "?",
                            "gearscore": c.character.gearscore if c.character else 0,
                        }
                    )
                return {"id": raid.id, "name": raid.name, "raid_instance": raid.raid_instance}, result
            finally:
                session.close()

        raid_info, comp_entries = await loop.run_in_executor(None, _fetch)

        if raid_info is None:
            await interaction.followup.send(f"❌ Raid #{raid_id} not found.")
            return

        if not comp_entries:
            await interaction.followup.send(f"❌ No composition set for raid #{raid_id}.")
            return

        embed = discord.Embed(
            title=f"📋 Composition: {raid_info['name']} – {raid_info['raid_instance']}",
            color=discord.Color.gold(),
        )

        groups: dict[str, list[str]] = {}
        for entry in comp_entries:
            prefix = entry["role_slot"].split("_")[0]  # tank, healer, dps
            groups.setdefault(prefix, [])
            groups[prefix].append(
                f"`{entry['role_slot']}` {entry['char_name']} ({entry['char_class']}) – {entry['spec']} GS {entry['gearscore']:.0f}"
            )

        role_emojis = {"tank": "🛡️", "healer": "💚", "dps": "⚔️"}
        for role in ("tank", "healer", "dps"):
            if role in groups:
                embed.add_field(
                    name=f"{role_emojis.get(role, '')} {role.capitalize()}s",
                    value="\n".join(groups[role]),
                    inline=False,
                )

        await interaction.followup.send(embed=embed)


async def setup(bot: commands.Bot):
    await bot.add_cog(RaidCog(bot))
