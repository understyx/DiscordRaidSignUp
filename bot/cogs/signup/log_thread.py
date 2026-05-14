from __future__ import annotations

import asyncio
import logging
from typing import Optional

import discord

from bot.db import get_session
from db.models import Raid, RaidLogMessage

logger = logging.getLogger(__name__)

# Maximum number of log-thread messages to scan for an existing per-user entry.
_RAID_LOG_HISTORY_SCAN_LIMIT = 10000


async def _post_to_raid_log(
    bot: discord.Client,
    raid_id: int,
    log_message: str,
    *,
    discord_user_id: Optional[int] = None,
    thread_id: Optional[int] = None,
):
    """Post to the raid log thread, editing an existing per-user message when possible."""
    loop = asyncio.get_event_loop()
    stored_message_id: Optional[int] = None
    allow_new_post = True

    if thread_id is None or discord_user_id:
        def _get_log_refs():
            session = get_session()
            try:
                raid = session.get(Raid, raid_id)
                resolved_thread_id = thread_id or (raid.discord_log_thread_id if raid else None)
                resolved_message_id = None
                if discord_user_id:
                    row = (
                        session.query(RaidLogMessage)
                        .filter_by(raid_id=raid_id, discord_user_id=discord_user_id)
                        .first()
                    )
                    resolved_message_id = row.discord_message_id if row else None
                return resolved_thread_id, resolved_message_id
            finally:
                session.close()

        thread_id, stored_message_id = await loop.run_in_executor(None, _get_log_refs)
    if not thread_id:
        return

    async def _save_log_ref(message_id: int):
        if not discord_user_id:
            return

        def _save():
            session = get_session()
            try:
                row = (
                    session.query(RaidLogMessage)
                    .filter_by(raid_id=raid_id, discord_user_id=discord_user_id)
                    .first()
                )
                if row is None:
                    row = RaidLogMessage(
                        raid_id=raid_id,
                        discord_user_id=discord_user_id,
                        discord_thread_id=thread_id,
                        discord_message_id=message_id,
                    )
                    session.add(row)
                else:
                    row.discord_thread_id = thread_id
                    row.discord_message_id = message_id
                session.commit()
            finally:
                session.close()

        await loop.run_in_executor(None, _save)

    try:
        thread = bot.get_channel(thread_id)
        if thread is None:
            thread = await bot.fetch_channel(thread_id)
        if discord_user_id and stored_message_id:
            try:
                await thread.get_partial_message(stored_message_id).edit(content=log_message)
                return
            except discord.NotFound:
                pass
            except discord.Forbidden as e:
                logger.warning(f"Missing access to edit raid log message {stored_message_id}: {e}")
                allow_new_post = False
            except Exception as e:
                logger.warning(f"Failed to edit stored raid log message {stored_message_id}: {e}")
                allow_new_post = False
        if discord_user_id and bot.user:
            # Mentions may appear as either <@id> or <@!id> depending on context/client.
            mention_a = f"<@{discord_user_id}>"
            mention_b = f"<@!{discord_user_id}>"
            async for msg in thread.history(limit=_RAID_LOG_HISTORY_SCAN_LIMIT):
                if msg.author.id != bot.user.id:
                    continue
                if mention_a not in msg.content and mention_b not in msg.content:
                    continue
                await msg.edit(content=log_message)
                await _save_log_ref(msg.id)
                return
        if not allow_new_post:
            return
        sent = await thread.send(log_message)
        await _save_log_ref(sent.id)
    except Exception as e:
        logger.warning(f"Failed to post to raid log thread {thread_id}: {e}")


async def _create_log_thread(
    channel: discord.abc.Messageable,
    raid_id: int,
    raid_name: str,
) -> Optional[int]:
    """Attempt to create a sign-up log thread for a raid and persist its ID.

    Returns the new thread ID on success, or None if creation failed.
    """
    try:
        log_thread_name = f"📋 {raid_name} – Sign-Up Log"[:100]
        thread = await channel.create_thread(
            name=log_thread_name,
            auto_archive_duration=10080,  # 7 days in minutes
            type=discord.ChannelType.public_thread,
        )
        await thread.send(f"📋 **Sign-Up Log for {raid_name}**\nPlayer sign-ups will be recorded here.")
        new_thread_id = thread.id

        loop = asyncio.get_event_loop()

        def _save():
            session = get_session()
            try:
                raid = session.get(Raid, raid_id)
                if raid:
                    raid.discord_log_thread_id = new_thread_id
                    session.commit()
            finally:
                session.close()

        await loop.run_in_executor(None, _save)
        logger.info("Created log thread %s for raid %s", new_thread_id, raid_id)
        return new_thread_id
    except Exception:
        logger.warning("Failed to create log thread for raid %s", raid_id, exc_info=True)
        return None
