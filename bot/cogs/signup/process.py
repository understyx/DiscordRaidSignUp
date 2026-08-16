from __future__ import annotations

import asyncio
import datetime
import logging
from typing import Optional

import discord

from bot.db import get_session
from bot.discord_utils import get_top_role_name
from bot.role_utils import get_role_from_spec
from db.models import Character, DiscordUser, Raid, Signup, SignupStatus, SignupType

from .embed import update_raid_embed
from .log_thread import _create_log_thread, _post_to_raid_log, format_user_raid_log_message
from .parser import (
    _MAX_RANDOM_LINES_IN_ERROR,
    _find_random_text_lines,
    _is_tentative_message,
    _parse_character_lines,
    format_gs,
)

logger = logging.getLogger(__name__)


def _raid_id_to_guild_id(session, raid_id: int) -> Optional[int]:
    """Helper to get guild_id from a raid_id."""
    raid = session.get(Raid, raid_id)
    return raid.guild_id if raid else None


def _upsert_discord_user(session, user: discord.User | discord.Member) -> None:
    """Upsert Discord username/display_name into discord_users table."""
    display = getattr(user, "display_name", None)
    existing = session.get(DiscordUser, user.id)
    if existing:
        existing.username = user.name
        existing.display_name = display
        existing.updated_at = datetime.datetime.now(datetime.timezone.utc)
    else:
        session.add(
            DiscordUser(
                discord_user_id=user.id,
                username=user.name,
                display_name=display,
                updated_at=datetime.datetime.now(datetime.timezone.utc),
            )
        )


async def process_text_signup(
    bot: discord.Client,
    user: discord.User | discord.Member,
    content: str,
    raid_id: int,
    raid_name: str,
    log_thread_id: Optional[int],
    channel: discord.abc.Messageable,
    message_to_delete: Optional[discord.Message] = None,
    interaction: Optional[discord.Interaction] = None,
) -> bool:
    """
    Common logic for processing a text-based sign-up (either from a channel
    message or a modal submission).

    Returns True if successful, False otherwise.
    """
    # 1. Validation
    random_lines = _find_random_text_lines(content)
    parsed, parse_errors = _parse_character_lines(content)
    is_tentative_msg = _is_tentative_message(content)
    signup_status = SignupStatus.tentative if is_tentative_msg else SignupStatus.signed

    all_errors: list[str] = []
    if random_lines:
        quoted = "\n".join(f"> {line}" for line in random_lines[:_MAX_RANDOM_LINES_IN_ERROR])
        all_errors.append(
            "Your message contains text that is not a character sign-up line:\n"
            + quoted
            + "\nPlease post **only** your character sign-up lines "
            "(optionally preceded by `tentative` or `maybe` on its own line)."
        )
    all_errors.extend(parse_errors)

    if all_errors or not parsed:
        if message_to_delete:
            try:
                await message_to_delete.delete()
            except Exception:
                pass
        if not all_errors:
            all_errors.append(
                "No valid sign-up lines could be parsed. "
                "Expected format: `CharName / Class / Spec / GS`"
            )
        error_text = f"❌ {user.mention} Sign-up rejected:\n" + "\n".join(all_errors)
        if interaction:
            if interaction.response.is_done():
                await interaction.followup.send(error_text, ephemeral=True)
            else:
                await interaction.response.send_message(error_text, ephemeral=True)
        else:
            try:
                await user.send(error_text)
            except Exception:
                logger.warning("Failed to DM sign-up error to user %s", user.id, exc_info=True)
        return False

    # 2. Save and signup
    discord_user_id = user.id
    loop = asyncio.get_event_loop()

    def _save_and_signup_db():
        session = get_session()
        try:
            _upsert_discord_user(session, user)
            # Remove ALL existing signups for this user+raid so the new message
            # fully overwrites the old sign-up instead of merging with it.
            session.query(Signup).filter_by(
                raid_id=raid_id,
                discord_user_id=discord_user_id,
            ).delete()

            char_spec_info: dict[str, dict] = {}
            top_role = get_top_role_name(user) if isinstance(user, discord.Member) else None

            for entry in parsed:
                char = (
                    session.query(Character)
                    .filter_by(
                        discord_user_id=discord_user_id,
                        char_name=entry["char_name"],
                        spec=entry["spec"],
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
                char.role = get_role_from_spec(entry["char_class"], entry["spec"])
                char.gearscore = entry["gearscore"]
                char.is_deleted = False
                char.last_updated = datetime.datetime.now(datetime.timezone.utc)
                session.flush()

            # Update ALL characters for this user in this guild with the latest Discord info
            session.query(Character).filter_by(
                guild_id=_raid_id_to_guild_id(session, raid_id),
                discord_user_id=discord_user_id,
            ).update(
                {
                    "discord_role": top_role,
                    "membership_status": "active",
                    "last_updated": datetime.datetime.now(datetime.timezone.utc),
                }
            )

            for entry in parsed:
                signup_type = SignupType.prio_character if entry["is_prio"] else SignupType.fill
                session.add(
                    Signup(
                        raid_id=raid_id,
                        discord_user_id=discord_user_id,
                        character_id=char.id,
                        signup_type=signup_type,
                        status=signup_status,
                        is_saved=entry["is_saved"],
                        note=entry.get("note") or None,
                    )
                )

                key = entry["char_name"].lower()
                if key not in char_spec_info:
                    char_spec_info[key] = {
                        "char_name": entry["char_name"],
                        "char_class": entry["char_class"],
                        "specs": [],
                        "is_saved": entry["is_saved"],
                        "note": entry.get("note", ""),
                    }
                char_spec_info[key]["specs"].append(
                    {
                        "spec": entry["spec"],
                        "gearscore": entry["gearscore"],
                        "is_prio": entry["is_prio"],
                    }
                )
            session.commit()

            summaries = []
            for data in char_spec_info.values():
                spec_parts = []
                for s in data["specs"]:
                    star = " ⭐" if s["is_prio"] else ""
                    spec_parts.append(f"{s['spec']}{star} GS {format_gs(s['gearscore'])}")
                specs_str = " / ".join(spec_parts)
                saved_flag = " ❌" if data["is_saved"] else ""
                note_str = f" 💬 *{data['note']}*" if data.get("note") else ""
                summaries.append(
                    f"• **{data['char_name']}** ({data['char_class']}) – {specs_str}{saved_flag}{note_str}"
                )
            return summaries
        finally:
            session.close()

    try:
        summaries = await loop.run_in_executor(None, _save_and_signup_db)
    except Exception:
        logger.exception("Failed to process character sign-up from %s", discord_user_id)
        if interaction:
            msg = "❌ An error occurred while processing your sign-up."
            if interaction.response.is_done():
                await interaction.followup.send(msg, ephemeral=True)
            else:
                await interaction.response.send_message(msg, ephemeral=True)
        return False

    # 3. Log and cleanup
    if signup_status == SignupStatus.tentative:
        log_message = format_user_raid_log_message(
            raid_id=raid_id,
            discord_user_id=discord_user_id,
            user_mention=user.mention,
            emoji="❓",
            action="tentatively signed up",
            raid_name=raid_name,
            detail_lines=summaries,
        )
    else:
        log_message = format_user_raid_log_message(
            raid_id=raid_id,
            discord_user_id=discord_user_id,
            user_mention=user.mention,
            emoji="✅",
            action="signed up",
            raid_name=raid_name,
            detail_lines=summaries,
        )

    if message_to_delete:
        try:
            await message_to_delete.delete()
        except Exception:
            pass

    if not log_thread_id:
        log_thread_id = await _create_log_thread(channel, raid_id, raid_name)

    if log_thread_id:
        await _post_to_raid_log(
            bot,
            raid_id,
            log_message,
            discord_user_id=discord_user_id,
            thread_id=log_thread_id,
        )
    else:
        logger.warning("No log thread available for raid %s; skipping log message", raid_id)

    if interaction:
        success_msg = f"✅ Sign-up processed for **{raid_name}**!"
        if interaction.response.is_done():
            await interaction.followup.send(success_msg, ephemeral=True)
        else:
            await interaction.response.send_message(success_msg, ephemeral=True)

    await update_raid_embed(bot, raid_id)
    return True
