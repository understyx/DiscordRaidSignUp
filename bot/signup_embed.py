"""Discord embed building and character display helpers for raid sign-ups."""

from __future__ import annotations

import asyncio
import datetime
import logging

import discord

from bot.db import get_session
from bot.signup_parser import format_gs
from db.models import DiscordUser, Raid, RaidStatus, Signup

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Discord user helper
# ---------------------------------------------------------------------------

def upsert_discord_user(session, user: discord.User | discord.Member) -> None:
    """Upsert Discord username/display_name into discord_users table."""
    display = getattr(user, "display_name", None)
    existing = session.get(DiscordUser, user.id)
    if existing:
        existing.username = user.name
        existing.display_name = display
        existing.updated_at = datetime.datetime.now(datetime.timezone.utc)
    else:
        session.add(DiscordUser(
            discord_user_id=user.id,
            username=user.name,
            display_name=display,
            updated_at=datetime.datetime.now(datetime.timezone.utc),
        ))


# ---------------------------------------------------------------------------
# Character display helpers
# ---------------------------------------------------------------------------

def chars_to_dicts(characters) -> list[dict]:
    """Serialize Character ORM objects to plain dicts (safe to use after session close)."""
    return [
        {
            "id": c.id,
            "char_name": c.char_name,
            "realm": c.realm,
            "char_class": c.char_class,
            "spec": c.spec,
            "gearscore": c.gearscore or 0.0,
        }
        for c in characters
    ]


def char_display_description(char: dict) -> str:
    """Return a short spec/class/GS description string for a character dict."""
    spec_or_class = char["spec"] if char["spec"] else (char["char_class"] or "?")
    return f"{spec_or_class} – GS {format_gs(char['gearscore'])}"


def char_label(char: dict) -> str:
    """Return 'CharName (Spec)' when a spec is present, otherwise just 'CharName'."""
    if char.get("spec"):
        return f"{char['char_name']} ({char['spec']})"
    return char["char_name"]


def group_chars_by_name(char_dicts: list[dict]) -> list[dict]:
    """
    Group per-spec character rows by character name.

    Each unique char_name becomes one group dict with:
        id         – primary character ID (row with the highest gearscore)
        char_name  – character name
        realm      – realm name
        char_class – class string
        spec       – primary spec name (highest GS), or None if no specs
        gearscore  – highest gearscore across all rows (including spec-less)
        specs      – list of (spec, gearscore, id) tuples for rows that have a
                     spec, sorted by GS descending; may be empty
    """
    groups: dict[str, dict] = {}
    # Track all (gs, id) pairs per group regardless of spec, for primary selection
    all_rows: dict[str, list[tuple[float, int]]] = {}

    for c in char_dicts:
        key = c["char_name"].lower()
        gs = c.get("gearscore", 0.0)
        if key not in groups:
            groups[key] = {
                "id": c["id"],
                "char_name": c["char_name"],
                "realm": c.get("realm", ""),
                "char_class": c.get("char_class"),
                "spec": c.get("spec"),
                "gearscore": gs,
                "specs": [],
            }
            all_rows[key] = []
        spec = c.get("spec")
        if spec:
            groups[key]["specs"].append((spec, gs, c["id"]))
        all_rows[key].append((gs, c["id"]))

    result = []
    for key, group in groups.items():
        group["specs"].sort(key=lambda x: x[1], reverse=True)
        if group["specs"]:
            # Primary is the highest-GS spec row
            group["id"] = group["specs"][0][2]
            group["spec"] = group["specs"][0][0]
            group["gearscore"] = group["specs"][0][1]
        else:
            # No spec rows – use the highest-GS row as primary
            best_gs, best_id = max(all_rows[key], key=lambda x: x[0])
            group["id"] = best_id
            group["gearscore"] = best_gs
        result.append(group)
    return result


# ---------------------------------------------------------------------------
# Raid embed builder
# ---------------------------------------------------------------------------

def build_signup_embed(raid: dict, signups: list) -> discord.Embed:
    """Build the standard raid sign-up embed from a raid data dict and signup list.

    *raid* must contain keys: ``id``, ``name``, ``date``, ``raid_instance``,
    ``description``, ``max_size``, ``status`` (string value, e.g. ``"open"``).
    *signups* is a list of dicts with at least a ``discord_user_id`` key, or a
    list of ORM Signup objects with a ``discord_user_id`` attribute.
    """
    def _user_id(s):
        return s.get("discord_user_id") if isinstance(s, dict) else s.discord_user_id

    unique_players = len({_user_id(s) for s in signups if _user_id(s)})

    status = raid.get("status", "open") if isinstance(raid, dict) else raid.status.value
    status_emoji = {"open": "🟢", "locked": "🔒"}.get(status, "🟢")
    is_open = status == "open"

    name = raid["name"] if isinstance(raid, dict) else raid.name
    description = (raid.get("description") or "") if isinstance(raid, dict) else (raid.description or "")
    raid_instance = raid["raid_instance"] if isinstance(raid, dict) else raid.raid_instance
    date = raid["date"] if isinstance(raid, dict) else raid.date
    max_size = raid["max_size"] if isinstance(raid, dict) else raid.max_size
    raid_id = raid["id"] if isinstance(raid, dict) else raid.id

    embed = discord.Embed(
        title=f"⚔️ {name}",
        description=description,
        color=discord.Color.gold() if is_open else discord.Color.red(),
    )
    embed.add_field(name="📍 Instance", value=raid_instance, inline=True)
    embed.add_field(
        name="📅 Date",
        value=f"<t:{int(date.timestamp())}:F>",
        inline=True,
    )
    embed.add_field(name="Status", value=f"{status_emoji} {status.capitalize()}", inline=True)
    embed.add_field(
        name="👥 Players Signed Up",
        value=f"{unique_players} / {max_size}",
        inline=False,
    )
    embed.set_footer(text=f"Raid ID: {raid_id}")
    return embed


# ---------------------------------------------------------------------------
# Discord channel helpers
# ---------------------------------------------------------------------------

async def update_raid_embed(bot: discord.Client, raid_id: int) -> None:
    """Fetch raid + signups and edit the original Discord message."""
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

    from bot.cogs.signup import SignupView  # avoid circular import at module level

    try:
        channel = bot.get_channel(raid_data["discord_channel_id"])
        if channel is None:
            channel = await bot.fetch_channel(raid_data["discord_channel_id"])
        msg = await channel.fetch_message(raid_data["discord_message_id"])
        embed = build_signup_embed(raid_data, signup_data)
        is_locked = raid_data["status"] != "open"
        view = None if is_locked else SignupView()
        await msg.edit(embed=embed, view=view)
    except discord.Forbidden as e:
        logger.info("Missing access to update raid embed for raid %s: %s", raid_id, e)
    except Exception as e:
        logger.warning("Failed to update raid embed for raid %s: %s", raid_id, e)


async def post_to_raid_log(bot: discord.Client, raid_id: int, log_message: str) -> None:
    """Post a message to the raid's sign-up log thread, if one exists."""
    loop = asyncio.get_event_loop()

    def _get_thread_id():
        session = get_session()
        try:
            raid = session.get(Raid, raid_id)
            return raid.discord_log_thread_id if raid else None
        finally:
            session.close()

    thread_id = await loop.run_in_executor(None, _get_thread_id)
    if not thread_id:
        return
    try:
        thread = bot.get_channel(thread_id)
        if thread is None:
            thread = await bot.fetch_channel(thread_id)
        await thread.send(log_message)
    except Exception as e:
        logger.warning("Failed to post to raid log thread %s: %s", thread_id, e)
