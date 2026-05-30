from __future__ import annotations

import asyncio
import json
import logging
import os

import discord

from bot.db import get_session
from db.models import Raid, Signup

logger = logging.getLogger(__name__)
DEFAULT_SIGNUP_STATUS = "signed"
VALID_SIGNUP_STATUSES = frozenset({DEFAULT_SIGNUP_STATUS, "tentative"})

# ---------------------------------------------------------------------------
# Emoji data loaded once at import time from emojis.json at the repo root.
# ---------------------------------------------------------------------------
_EMOJIS_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "..", "emojis.json")
try:
    with open(_EMOJIS_PATH, "r", encoding="utf-8") as _f:
        _EMOJIS: dict = json.load(_f)
except Exception:
    _EMOJIS = {}

# Ordered list of class names taken directly from emojis.json so that the
# class fields always appear in a consistent order in the embed.
_CLASS_ORDER: list[str] = list(_EMOJIS.keys())


def _class_emoji(class_name: str) -> str:
    return _EMOJIS.get(class_name, {}).get("emoji", "")


def _spec_emoji(class_name: str, spec_name: str) -> str:
    return _EMOJIS.get(class_name, {}).get("specs", {}).get(spec_name, "")


def _build_signup_embed(raid: dict, signups: list) -> discord.Embed:
    # ── per-user status aggregation (for the summary line) ──────────────────
    statuses_by_user: dict[str, set[str]] = {}
    for s in signups:
        user_id = s.get("discord_user_id")
        if not user_id:
            continue
        uid = str(user_id)
        status = s.get("status") or DEFAULT_SIGNUP_STATUS
        if status not in VALID_SIGNUP_STATUSES:
            status = DEFAULT_SIGNUP_STATUS
        statuses_by_user.setdefault(uid, set()).add(status)

    coming_count = 0
    tentative_count = 0
    for statuses in statuses_by_user.values():
        if statuses == {"tentative"}:
            tentative_count += 1
        else:
            coming_count += 1

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
        value=f"{coming_count} + {tentative_count} tentative",
        inline=False,
    )

    # ── raid-helper style class / spec breakdown ─────────────────────────────
    # Group signups: class_name → spec_name → list of (char_name, status)
    class_spec_groups: dict[str, dict[str, list[tuple[str, str]]]] = {}
    for s in signups:
        char_class = s.get("char_class") or "Unknown"
        spec = s.get("spec") or "Unknown"
        char_name = s.get("char_name") or "?"
        status = s.get("status") or DEFAULT_SIGNUP_STATUS
        class_spec_groups.setdefault(char_class, {}).setdefault(spec, []).append(
            (char_name, status)
        )

    # Emit fields in the canonical class order, then any extras at the end.
    ordered_classes = [c for c in _CLASS_ORDER if c in class_spec_groups]
    remaining = [c for c in class_spec_groups if c not in _CLASS_ORDER]

    for class_name in ordered_classes + remaining:
        spec_groups = class_spec_groups[class_name]
        c_emoji = _class_emoji(class_name)
        total = sum(len(v) for v in spec_groups.values())

        lines: list[str] = []
        for spec, entries in spec_groups.items():
            s_emoji = _spec_emoji(class_name, spec)
            prefix = f"{s_emoji} " if s_emoji else ""
            for char_name, status in entries:
                suffix = " ❓" if status == "tentative" else ""
                lines.append(f"{prefix}{char_name}{suffix}")

        field_name = f"{c_emoji} {class_name} ({total})" if c_emoji else f"{class_name} ({total})"
        # Discord field value max is 1024 chars; truncate gracefully if needed.
        value = "\n".join(lines)
        if len(value) > 1024:
            value = value[:1021] + "…"

        embed.add_field(name=field_name, value=value or "—", inline=True)

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
            signup_data = []
            for s in sups:
                char = s.character
                signup_data.append({
                    "discord_user_id": s.discord_user_id,
                    "status": s.status.value if s.status else DEFAULT_SIGNUP_STATUS,
                    "char_name": char.char_name if char else None,
                    "char_class": char.char_class if char else None,
                    "spec": char.spec if char else None,
                })
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
