from __future__ import annotations

import asyncio
import logging

import discord

from bot.db import get_session
from db.models import Raid, Signup
from .parser import format_gs

logger = logging.getLogger(__name__)


def _build_signup_embed(raid: dict, signups: list) -> discord.Embed:
    unique_players = len(set(
        s.get("discord_user_id") for s in signups if s.get("discord_user_id")
    ))

    status_emoji = {"open": "🟢", "locked": "🔒"}.get(
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
        value=f"<t:{int(raid['date'].timestamp())}:F>",
        inline=True,
    )
    embed.add_field(name="Status", value=f"{status_emoji} {raid['status'].capitalize()}", inline=True)
    embed.add_field(
        name="👥 Players Signed Up",
        value=f"{unique_players} / {raid['max_size']}",
        inline=False,
    )
    embed.set_footer(text=f"Raid ID: {raid['id']}")
    return embed


async def update_raid_embed(bot: discord.Client, raid_id: int):
    """Fetch raid + signups and edit the original Discord message."""
    # Lazy import to avoid circular dependency with main_view.
    from .main_view import SignupView

    loop = asyncio.get_event_loop()

    def _fetch():
        session = get_session()
        try:
            raid = session.get(Raid, raid_id)
            if raid is None:
                return None, None
            sups = session.query(Signup).filter_by(raid_id=raid_id).all()
            signup_data = [{"discord_user_id": s.discord_user_id} for s in sups]
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
    except discord.Forbidden as e:
        logger.info(f"Missing access to update raid embed for raid {raid_id}: {e}")
    except Exception as e:
        logger.warning(f"Failed to update raid embed for raid {raid_id}: {e}")
