from __future__ import annotations

import asyncio
import logging
from typing import Optional

import discord
from sqlalchemy.dialects.mysql import insert as mysql_insert

from bot.db import get_session
from db.models import Raid, RaidLogMessage

logger = logging.getLogger(__name__)

# Maximum number of log-thread messages to scan for an existing per-user entry.
_RAID_LOG_HISTORY_SCAN_LIMIT = 10000
_RAID_LOG_TOKEN_PREFIX = "[raid-log:"

# Per-(raid_id, discord_user_id) locks that serialize concurrent _post_to_raid_log
# calls for the same user+raid, preventing race conditions that would cause
# duplicate messages when two coroutines both find no existing post before either
# has had a chance to save its newly-sent message ID.
# Growth is naturally bounded by the number of unique (raid, user) combinations
# that have ever interacted with the log thread during the bot's lifetime.
_log_post_locks: dict[tuple[int, int], asyncio.Lock] = {}


def _get_log_post_lock(raid_id: int, discord_user_id: int) -> asyncio.Lock:
    """Return (creating if necessary) the asyncio.Lock for a given raid+user pair."""
    key = (raid_id, discord_user_id)
    # setdefault is a single atomic dict operation: it only stores the new Lock
    # when the key is absent, so concurrent lookups always share the same instance.
    return _log_post_locks.setdefault(key, asyncio.Lock())


def _user_log_identity_token(raid_id: int, discord_user_id: int) -> str:
    return f"{_RAID_LOG_TOKEN_PREFIX}{raid_id}:{discord_user_id}]"


def _ensure_user_log_identity_token(log_message: str, raid_id: int, discord_user_id: int) -> str:
    token = _user_log_identity_token(raid_id, discord_user_id)
    if token in log_message:
        return log_message
    return f"{log_message}\n{token}"


def format_user_raid_log_message(
    *,
    raid_id: int,
    discord_user_id: int,
    user_mention: str,
    emoji: str,
    action: str,
    raid_name: Optional[str] = None,
    detail_lines: Optional[list[str]] = None,
) -> str:
    raid_part = f" for **{raid_name}**" if raid_name else ""
    header = f"{emoji} {user_mention} {action}{raid_part}"
    if detail_lines:
        message = f"{header}:\n" + "\n".join(detail_lines)
    else:
        message = header
    return _ensure_user_log_identity_token(message, raid_id, discord_user_id)


async def _post_to_raid_log(
    bot: discord.Client,
    raid_id: int,
    log_message: str,
    *,
    discord_user_id: Optional[int] = None,
    thread_id: Optional[int] = None,
):
    """Post to the raid log thread, editing an existing per-user message when possible."""
    if discord_user_id:
        log_message = _ensure_user_log_identity_token(log_message, raid_id, discord_user_id)
        async with _get_log_post_lock(raid_id, discord_user_id):
            await _do_post_to_raid_log(
                bot, raid_id, log_message,
                discord_user_id=discord_user_id,
                thread_id=thread_id,
            )
    else:
        await _do_post_to_raid_log(
            bot, raid_id, log_message,
            discord_user_id=None,
            thread_id=thread_id,
        )


async def _do_post_to_raid_log(
    bot: discord.Client,
    raid_id: int,
    log_message: str,
    *,
    discord_user_id: Optional[int] = None,
    thread_id: Optional[int] = None,
):
    """Internal implementation – call _post_to_raid_log instead."""
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

        try:
            thread_id, stored_message_id = await loop.run_in_executor(None, _get_log_refs)
        except Exception as e:
            logger.warning(f"Failed to look up log refs for raid {raid_id}: {e}")
            return

    if not thread_id:
        return

    async def _save_log_ref(message_id: int):
        if not discord_user_id:
            return

        def _save():
            session = get_session()
            try:
                stmt = mysql_insert(RaidLogMessage.__table__).values(
                    raid_id=raid_id,
                    discord_user_id=discord_user_id,
                    discord_thread_id=thread_id,
                    discord_message_id=message_id,
                )
                stmt = stmt.on_duplicate_key_update(
                    discord_thread_id=stmt.inserted.discord_thread_id,
                    discord_message_id=stmt.inserted.discord_message_id,
                )
                session.execute(stmt)
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
                edited = await thread.get_partial_message(stored_message_id).edit(content=log_message)
                await _save_log_ref(edited.id)
                return
            except discord.NotFound:
                pass
            except discord.Forbidden as e:
                logger.warning(f"Missing access to edit raid log message {stored_message_id}: {e}")
                allow_new_post = False
            except Exception as e:
                logger.warning(f"Failed to edit stored raid log message {stored_message_id}: {e}")
                allow_new_post = False
        if discord_user_id:
            token = _user_log_identity_token(raid_id, discord_user_id)
            async for msg in thread.history(limit=_RAID_LOG_HISTORY_SCAN_LIMIT):
                if bot.user and msg.author.id != bot.user.id:
                    continue
                if token not in msg.content:
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
