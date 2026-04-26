from __future__ import annotations

import asyncio
import datetime
import logging
from dataclasses import dataclass, field
import discord
from discord import app_commands
from discord.ext import commands
from sqlalchemy import select, func

from bot.config import OFFICER_ROLE_NAME
from bot.db import get_session
from db.models import Raid, RaidStatus

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


def _build_signup_embed(raid: Raid, signups: list) -> discord.Embed:
    unique_players = len(set(
        s.discord_user_id for s in signups if s.discord_user_id
    ))

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
    embed.add_field(name="Status", value=f"{status_emoji} {raid.status.value.capitalize()}", inline=True)
    embed.add_field(
        name="👥 Players Signed Up",
        value=str(unique_players),
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
                        select(func.coalesce(func.max(Raid.guild_raid_number), 0) + 1)
                        .where(Raid.guild_id == interaction.guild_id)
                    ).scalar()
                    raid = Raid(
                        name=self.raid_name.value.strip(),
                        date=raid_dt,
                        description=self.description.value.strip() if self.description.value else "",
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

        from bot.cogs.signup import SignupView, HOWTO_TEXT as _HOWTO_TEXT

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

        # Create "How to Sign Up" thread on the raid embed message and a standalone log thread.
        # If the bot lacks thread-creation permissions, fall back to sending the how-to guide
        # as an ephemeral message visible only to the officer who created the raid.
        try:
            howto_thread = await msg.create_thread(
                name="📖 How to Sign Up",
                auto_archive_duration=10080,  # 7 days in minutes
            )
            await howto_thread.send(_HOWTO_TEXT)

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
        except discord.Forbidden:
            logger.info(
                "No permission to create threads for raid %s; sending how-to guide ephemerally",
                raid_id,
            )
            try:
                await interaction.followup.send(_HOWTO_TEXT, ephemeral=True)
            except Exception:
                logger.warning("Failed to send ephemeral how-to for raid %s", raid_id, exc_info=True)
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


async def setup(bot: commands.Bot):
    await bot.add_cog(RaidCog(bot))
