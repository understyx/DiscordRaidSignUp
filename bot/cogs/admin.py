from __future__ import annotations

import logging
import discord
from discord import app_commands
from discord.ext import commands

from bot.db import get_session
from db.models import GuildAdminRole

logger = logging.getLogger(__name__)


def _can_manage_admin():
    """Only guild owners or members with manage_guild permission may run these commands."""

    async def predicate(interaction: discord.Interaction) -> bool:
        if interaction.user.guild_permissions.manage_guild:
            return True
        if interaction.guild and interaction.guild.owner_id == interaction.user.id:
            return True
        return False

    return app_commands.check(predicate)


class RaidAdminGroup(app_commands.Group):
    """Manage which roles have raid-admin privileges."""

    def __init__(self):
        super().__init__(name="raidadmin", description="Manage raid admin roles (server managers only).")

    async def on_error(self, interaction: discord.Interaction, error: app_commands.AppCommandError) -> None:
        if isinstance(error, app_commands.CheckFailure):
            await interaction.response.send_message(
                "❌ You do not have permission to use this command. "
                "Only the server owner or members with **Manage Server** permission can manage raid admin roles.",
                ephemeral=True,
            )
        else:
            raise error

    @app_commands.command(name="add", description="Grant a role raid-admin access.")
    @_can_manage_admin()
    async def add(self, interaction: discord.Interaction, role: discord.Role):
        guild_id = interaction.guild_id
        if guild_id is None:
            await interaction.response.send_message("❌ This command must be used in a server.", ephemeral=True)
            return

        import asyncio
        loop = asyncio.get_running_loop()

        def _add():
            session = get_session()
            try:
                existing = session.get(GuildAdminRole, (guild_id, role.id, "admin"))
                if existing:
                    return False
                session.add(GuildAdminRole(guild_id=guild_id, role_id=role.id, role_type="admin"))
                session.commit()
                return True
            finally:
                session.close()

        added = await loop.run_in_executor(None, _add)
        if added:
            await interaction.response.send_message(
                f"✅ **{role.name}** can now manage raids on the website.", ephemeral=True
            )
        else:
            await interaction.response.send_message(
                f"ℹ️ **{role.name}** already has raid-admin access.", ephemeral=True
            )

    @app_commands.command(name="remove", description="Revoke raid-admin access from a role.")
    @_can_manage_admin()
    async def remove(self, interaction: discord.Interaction, role: discord.Role):
        guild_id = interaction.guild_id
        if guild_id is None:
            await interaction.response.send_message("❌ This command must be used in a server.", ephemeral=True)
            return

        import asyncio
        loop = asyncio.get_running_loop()

        def _remove():
            session = get_session()
            try:
                existing = session.get(GuildAdminRole, (guild_id, role.id, "admin"))
                if not existing:
                    return False
                session.delete(existing)
                session.commit()
                return True
            finally:
                session.close()

        removed = await loop.run_in_executor(None, _remove)
        if removed:
            await interaction.response.send_message(
                f"✅ Removed raid-admin access from **{role.name}**.", ephemeral=True
            )
        else:
            await interaction.response.send_message(
                f"ℹ️ **{role.name}** did not have raid-admin access.", ephemeral=True
            )

    @app_commands.command(name="list", description="List all roles with raid-admin access.")
    @_can_manage_admin()
    async def list_roles(self, interaction: discord.Interaction):
        guild_id = interaction.guild_id
        if guild_id is None:
            await interaction.response.send_message("❌ This command must be used in a server.", ephemeral=True)
            return

        import asyncio
        loop = asyncio.get_running_loop()

        def _list():
            session = get_session()
            try:
                from sqlalchemy import select
                rows = session.execute(
                    select(GuildAdminRole).where(
                        GuildAdminRole.guild_id == guild_id,
                        GuildAdminRole.role_type == "admin",
                    )
                ).scalars().all()
                return [r.role_id for r in rows]
            finally:
                session.close()

        role_ids = await loop.run_in_executor(None, _list)

        if not role_ids:
            await interaction.response.send_message(
                "ℹ️ No raid-admin roles configured. All logged-in users currently have full website access.\n"
                "Use `/raidadmin add @role` to restrict access.",
                ephemeral=True,
            )
            return

        lines = []
        for rid in role_ids:
            role = interaction.guild.get_role(rid)
            lines.append(f"• {role.mention if role else f'Unknown role ({rid})'}")

        await interaction.response.send_message(
            "**Raid Admin Roles:**\n" + "\n".join(lines), ephemeral=True
        )


class AdminCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot
        bot.tree.add_command(RaidAdminGroup())


async def setup(bot: commands.Bot):
    await bot.add_cog(AdminCog(bot))
