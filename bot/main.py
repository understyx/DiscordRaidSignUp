import asyncio
import logging

import discord
from discord.ext import commands

from bot.config import BOT_TOKEN
from bot.db import get_session
from db.models import BotGuild, Character

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def _upsert_guild_sync(guild: discord.Guild) -> None:
    """Upsert a guild record into bot_guilds (called from a thread executor)."""
    session = get_session()
    try:
        existing = session.get(BotGuild, guild.id)
        if existing:
            existing.guild_name = guild.name
            existing.icon = str(guild.icon) if guild.icon else None
        else:
            session.add(
                BotGuild(
                    guild_id=guild.id,
                    guild_name=guild.name,
                    icon=str(guild.icon) if guild.icon else None,
                )
            )
        session.commit()
    finally:
        session.close()


def _delete_guild_sync(guild_id: int) -> None:
    """Remove a guild record from bot_guilds (called from a thread executor)."""
    session = get_session()
    try:
        existing = session.get(BotGuild, guild_id)
        if existing:
            session.delete(existing)
            session.commit()
    finally:
        session.close()


def _update_membership_status_sync(
    guild_id: int, user_id: int, status: str, discord_role: str = None
) -> None:
    """Update membership_status for all characters of a user in a guild."""
    session = get_session()
    try:
        update_data = {"membership_status": status}
        if discord_role is not None:
            update_data["discord_role"] = discord_role

        session.query(Character).filter_by(
            guild_id=guild_id,
            discord_user_id=user_id,
        ).update(update_data)
        session.commit()
    finally:
        session.close()


class RaidBot(commands.Bot):
    def __init__(self):
        intents = discord.Intents.default()
        intents.message_content = True
        intents.guilds = True
        intents.members = True
        super().__init__(command_prefix="!", intents=intents)

    async def setup_hook(self):
        await self.load_extension("bot.cogs.character")
        await self.load_extension("bot.cogs.raid")
        await self.load_extension("bot.cogs.signup")
        await self.load_extension("bot.cogs.dev")
        await self.load_extension("bot.cogs.admin")
        await self.load_extension("bot.cogs.saves")

        # Register persistent views so their buttons survive bot restarts.
        from bot.cogs.character.helpnoobs import HelpNoobsChoiceView
        from bot.cogs.signup import SignupView

        self.add_view(SignupView())
        self.add_view(HelpNoobsChoiceView())

        await self.tree.sync()
        logger.info("Slash commands synced.")

    async def on_ready(self):
        logger.info(f"Logged in as {self.user} (ID: {self.user.id})")
        await self.change_presence(
            activity=discord.Activity(type=discord.ActivityType.watching, name="raid sign-ups")
        )
        # Sync all current guilds to bot_guilds table
        loop = asyncio.get_running_loop()
        for guild in self.guilds:
            try:
                await loop.run_in_executor(None, _upsert_guild_sync, guild)
            except Exception:
                logger.warning(
                    "Failed to upsert guild %s (%s)", guild.id, guild.name, exc_info=True
                )

    async def on_guild_join(self, guild: discord.Guild):
        loop = asyncio.get_running_loop()
        try:
            await loop.run_in_executor(None, _upsert_guild_sync, guild)
            logger.info("Joined guild %s (%s) — upserted into bot_guilds.", guild.id, guild.name)
        except Exception:
            logger.warning("Failed to upsert guild %s on join", guild.id, exc_info=True)

    async def on_guild_update(self, before: discord.Guild, after: discord.Guild):
        if before.name != after.name or before.icon != after.icon:
            loop = asyncio.get_running_loop()
            try:
                await loop.run_in_executor(None, _upsert_guild_sync, after)
            except Exception:
                logger.warning("Failed to update guild %s in bot_guilds", after.id, exc_info=True)

    async def on_guild_remove(self, guild: discord.Guild):
        loop = asyncio.get_running_loop()
        try:
            await loop.run_in_executor(None, _delete_guild_sync, guild.id)
            logger.info("Left guild %s (%s) — removed from bot_guilds.", guild.id, guild.name)
        except Exception:
            logger.warning("Failed to remove guild %s from bot_guilds", guild.id, exc_info=True)

    async def on_member_join(self, member: discord.Member):
        loop = asyncio.get_running_loop()
        from bot.discord_utils import get_top_role_name

        top_role = get_top_role_name(member)
        try:
            await loop.run_in_executor(
                None, _update_membership_status_sync, member.guild.id, member.id, "active", top_role
            )
            logger.info(
                "Member %s joined guild %s — marked characters as active.",
                member.id,
                member.guild.id,
            )
        except Exception:
            logger.warning(
                "Failed to update membership status for member %s on join", member.id, exc_info=True
            )

    async def on_member_remove(self, member: discord.Member):
        loop = asyncio.get_running_loop()
        status = "left"

        # Try to see if they were kicked or banned by checking audit logs
        try:
            async for entry in member.guild.audit_logs(limit=5, action=discord.AuditLogAction.kick):
                if entry.target.id == member.id:
                    status = "kicked"
                    break
            if status == "left":
                async for entry in member.guild.audit_logs(
                    limit=5, action=discord.AuditLogAction.ban
                ):
                    if entry.target.id == member.id:
                        status = "banned"
                        break
        except Exception:
            # Fallback to "left" if we don't have permissions to view audit logs
            pass

        try:
            await loop.run_in_executor(
                None, _update_membership_status_sync, member.guild.id, member.id, status
            )
            logger.info(
                "Member %s left guild %s (status: %s) — updated characters.",
                member.id,
                member.guild.id,
                status,
            )
        except Exception:
            logger.warning(
                "Failed to update membership status for member %s on remove",
                member.id,
                exc_info=True,
            )

    async def on_member_ban(self, guild: discord.Guild, user: discord.User | discord.Member):
        loop = asyncio.get_running_loop()
        try:
            await loop.run_in_executor(
                None, _update_membership_status_sync, guild.id, user.id, "banned"
            )
            logger.info("Member %s banned from guild %s — updated characters.", user.id, guild.id)
        except Exception:
            logger.warning(
                "Failed to update membership status for user %s on ban", user.id, exc_info=True
            )


async def main():
    bot = RaidBot()
    async with bot:
        await bot.start(BOT_TOKEN)


if __name__ == "__main__":
    asyncio.run(main())
