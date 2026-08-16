from __future__ import annotations

import asyncio
import datetime
import logging
from dataclasses import dataclass, field

import discord
from discord import app_commands
from discord.ext import commands
from sqlalchemy import func, select

from bot.config import OFFICER_ROLE_NAME
from bot.db import get_session
from db.models import GuildAdminRole, Raid, RaidStatus

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
    """App-command check: user must have OFFICER_ROLE_NAME, manage_guild permission, or be a Raid Admin."""

    async def predicate(interaction: discord.Interaction) -> bool:
        if interaction.user.guild_permissions.manage_guild:
            return True

        if any(r.name == OFFICER_ROLE_NAME for r in interaction.user.roles):
            return True

        if interaction.guild_id:
            import asyncio

            loop = asyncio.get_running_loop()

            def _get_admin_roles():
                session = get_session()
                try:
                    return (
                        session.execute(
                            select(GuildAdminRole.role_id).where(
                                GuildAdminRole.guild_id == interaction.guild_id
                            )
                        )
                        .scalars()
                        .all()
                    )
                finally:
                    session.close()

            admin_role_ids = await loop.run_in_executor(None, _get_admin_roles)
            if admin_role_ids:
                user_role_ids = {r.id for r in interaction.user.roles}
                if any(rid in user_role_ids for rid in admin_role_ids):
                    return True

        return False

    return app_commands.check(predicate)


def _build_signup_embed(raid: Raid, signups: list) -> discord.Embed:
    unique_players = len(set(s.discord_user_id for s in signups if s.discord_user_id))

    status_emoji = {"open": "🟢", "locked": "🔒"}.get(
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
        value=f"<t:{int(raid.date.timestamp())}:F>",
        inline=True,
    )
    embed.add_field(
        name="Status", value=f"{status_emoji} {raid.status.value.capitalize()}", inline=True
    )
    embed.add_field(
        name="👥 Players Signed Up",
        value=str(unique_players),
        inline=False,
    )
    embed.set_footer(text=f"Raid ID: {raid.id}")
    return embed


class CreateRaidModal(discord.ui.Modal, title="Create Raid"):
    raid_name = discord.ui.TextInput(label="Raid Name", max_length=100)
    raid_instance = discord.ui.TextInput(
        label="Raid Instance", max_length=100, placeholder="e.g. ICC 25"
    )
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

        size = 10

        discord_user_id = interaction.user.id
        loop = asyncio.get_running_loop()

        try:

            def _create():
                session = get_session()
                try:
                    next_num = session.execute(
                        select(func.coalesce(func.max(Raid.guild_raid_number), 0) + 1).where(
                            Raid.guild_id == interaction.guild_id
                        )
                    ).scalar()
                    raid = Raid(
                        name=self.raid_name.value.strip(),
                        date=raid_dt,
                        description=self.description.value.strip()
                        if self.description.value
                        else "",
                        raid_instance=self.raid_instance.value.strip(),
                        max_size=size,
                        status=RaidStatus.open,
                        created_by=discord_user_id,
                        guild_id=interaction.guild_id,
                        guild_raid_number=next_num,
                    )
                    session.add(raid)
                    session.commit()
                    session.refresh(raid)
                    return (
                        raid.id,
                        raid.name,
                        raid.date,
                        raid.raid_instance,
                        raid.description,
                        raid.max_size,
                    )
                finally:
                    session.close()

            raid_id, name, date, instance, desc, max_size = await loop.run_in_executor(
                None, _create
            )
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

        # Create a standalone log thread for sign-up activity.
        try:
            channel = interaction.channel
            log_thread_name = f"📋 {name} – Sign-Up Log"[:100]
            log_thread = await channel.create_thread(
                name=log_thread_name,
                auto_archive_duration=10080,  # 7 days in minutes
                type=discord.ChannelType.public_thread,
            )
            await log_thread.send(
                f"📋 **Sign-Up Log for {name}**\nPlayer sign-ups will be recorded here."
            )

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
        except discord.Forbidden:
            logger.info("No permission to create log thread for raid %s", raid_id)
        except Exception:
            logger.warning("Failed to create log thread for raid %s", raid_id, exc_info=True)
            try:
                await interaction.followup.send(
                    "⚠️ Raid created, but the sign-up log thread could not be created. "
                    "Please check that the bot has **Create Public Threads** permission "
                    "in this channel and try again.",
                    ephemeral=True,
                )
            except Exception:
                pass

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
