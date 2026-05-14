from __future__ import annotations

import asyncio
import datetime
import logging
import re
from typing import Optional

import discord
from discord.ext import commands

from bot.config import WEB_BASE_URL, BASE_DOMAIN
from bot.db import get_session
from bot.class_utils import normalize_class, KNOWN_CLASSES
from db.models import BotGuild, Character, DiscordUser, Raid, RaidStatus, Signup, SignupStatus, SignupType

logger = logging.getLogger(__name__)


def _upsert_discord_user(session, user: discord.User | discord.Member) -> None:
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
# Chat message parser helpers
# ---------------------------------------------------------------------------

# Matches a potential character sign-up line.
# Name must be 1–12 letters, optionally preceded and/or followed by
# whitespace / saved (❌✗) or priority (⭐★) markers, then the first "/".
# Requires at least 4 slash-separated parts (name, class, spec, gs).
_CHAR_LINE_RE = re.compile(
    r"^[⭐★❌✗]?\s*[A-Za-z]{1,12}\s*[⭐★❌✗]?\s*/.+/.+/.+",
    re.IGNORECASE,
)

# Validates a bare character name (after stripping markers): letters only, 1–12 chars.
_NAME_RE = re.compile(r"^[A-Za-z]{1,12}$")

# Maximum number of random/invalid lines shown in a single rejection error.
_MAX_RANDOM_LINES_IN_ERROR = 5

# Matches a GS number (with optional k/K suffix) at the start of a segment,
# followed by optional whitespace and an optional trailing note.
_GS_NOTE_RE = re.compile(r"^([0-9]+(?:[.,][0-9]+)?[kK]?)\s*(.*)?$", re.DOTALL)

# Explicit note prefix: "Note:", "note:", "N:", or "n:" (case-insensitive).
# Only text following this prefix is treated as the signup note.
_NOTE_PREFIX_RE = re.compile(r"^[Nn](?:ote)?:\s*(.*)", re.DOTALL)

# Used to split a raw line at the note prefix so that slashes inside the note
# value are not treated as field separators.  Requires at least one whitespace
# character before the prefix so it is not confused with a field that starts
# with the letter N (e.g. a spec named "No" would never be followed by ":").
_NOTE_SPLIT_RE = re.compile(r"\s+[Nn](?:ote)?:\s*")

# Sentinel float value representing a "Best in Slot" gearscore.
BIS_GS = 99999.0

# Keywords that mark a text sign-up as tentative when placed on the first non-empty line.
_TENTATIVE_KEYWORDS = frozenset({"tentative", "maybe"})


def _is_tentative_message(text: str) -> bool:
    """Return True if the first non-empty line of *text* is a tentative keyword."""
    for line in text.splitlines():
        stripped = line.strip().lower()
        if stripped:
            return stripped in _TENTATIVE_KEYWORDS
    return False


def format_gs(value: float) -> str:
    """Format a gearscore for display, returning ``"BiS"`` for the sentinel value."""
    if value >= BIS_GS:
        return "BiS"
    return f"{value:.0f}"


def parse_gs(raw: str) -> float:
    """Parse a gearscore string into a float.

    Accepts full numbers (``"6200"``), decimal shorthand (``"6.2"`` → 6200),
    the explicit *k* suffix (``"6.2k"`` → 6200), and ``"bis"`` (case-insensitive)
    for Best-in-Slot.  Values already in the thousands are returned unchanged.
    Any commas are treated as decimal separators (e.g. ``"6,2"`` → 6200).
    Values below 1000 are auto-scaled by 1000, so ``"999"`` → 999000 — use the
    full number for sub-1000 scores.
    """
    stripped = raw.strip()
    if stripped.lower() == "bis":
        return BIS_GS
    cleaned = stripped.replace(",", ".")
    if cleaned.lower().endswith("k"):
        return float(cleaned[:-1]) * 1000
    value = float(cleaned)
    if value < 1000:
        value *= 1000
    return value


def _parse_gs_and_note(gs_raw: str) -> tuple[float, str]:
    """Parse a GS segment, returning ``(gearscore, note)``.

    Star markers (⭐ ★) are stripped before parsing.  ``"bis"`` (case-insensitive)
    is accepted as a synonym for Best-in-Slot.  A note is only extracted when an
    explicit prefix is found after the numeric GS value: ``Note:``, ``note:``,
    ``N:``, or ``n:`` (case-insensitive).  Any other trailing text is ignored.
    Raises ``ValueError`` if no valid GS number is found.
    """
    cleaned = gs_raw.replace("⭐", "").replace("★", "").strip()
    if cleaned.lower() == "bis":
        return BIS_GS, ""
    m = _GS_NOTE_RE.match(cleaned)
    if not m:
        raise ValueError(f"Cannot parse GS from {gs_raw!r}")
    gs = parse_gs(m.group(1))
    trailing = (m.group(2) or "").strip()
    note_match = _NOTE_PREFIX_RE.match(trailing)
    note = note_match.group(1).strip() if note_match else ""
    return gs, note


def _parse_character_lines(text: str) -> tuple[list[dict], list[str]]:
    """
    Parse one or more character lines from a message body.

    Supported format (one per line)::

        CharName / CharClass / Spec1 / GS1 [/ Spec2 / GS2 ...] [⭐ or ❌]

    Priority (⭐ or ★) placement controls which specs are marked as priority:
      - ⭐ after a spec name (before the GS): only that spec is priority
        e.g. ``Shadow ⭐ / 6500 / Disc / 6300``  →  only Shadow is priority
      - ⭐ after the *last* GS (end of line): all specs for that character are priority
        e.g. ``Survival / 6500 / BM / 6400 ⭐``  →  both Survival and BM are priority
      - ⭐ after any middle GS: only that spec is priority

    ❌  = saved character (already saved this lockout)

    Returns ``(results, errors)`` where *results* is a list of dicts with keys:
        char_name, char_class, spec, gearscore, is_prio (bool), is_saved (bool), note (str)
    and *errors* is a list of human-readable rejection reasons.

    One dict is returned per spec/GS pair. Characters with multiple specs
    (e.g. Shadow/6500/Disc/6300) produce multiple dicts, one per spec.
    All dicts for the same character line share the same ``note`` value.
    """
    results = []
    errors = []
    seen: set[tuple[str, str]] = set()  # (char_name_lower, spec_lower)

    for raw_line in text.splitlines():
        line = raw_line.strip()
        # Convert Discord text-form emoji :star: to the actual star character so
        # modal/text sign-ups using keyboard shortcuts are treated correctly.
        line = line.replace(":star:", "⭐").replace(":Star:", "⭐")
        if not line or not _CHAR_LINE_RE.match(line):
            continue

        is_saved = "❌" in line or "✗" in line

        # Strip only saved markers before splitting; keep star markers in place
        # so we can detect per-spec priority later.
        clean = line.replace("❌", "").replace("✗", "").strip()

        # Pre-extract any explicit note (n: / note: / N: / Note:) *before*
        # splitting on "/" so that slashes inside the note value are not
        # treated as additional field separators.
        pre_extracted_note = ""
        note_split_m = _NOTE_SPLIT_RE.search(clean)
        if note_split_m:
            pre_extracted_note = clean[note_split_m.end():]
            clean = clean[: note_split_m.start()]

        parts = [p.strip() for p in clean.split("/")]
        # Need at least: CharName / CharClass / Spec / GS
        if len(parts) < 4:
            continue

        char_name = parts[0].replace("⭐", "").replace("★", "").strip()
        char_class_raw = parts[1].replace("⭐", "").replace("★", "").strip()
        if not char_name or not char_class_raw:
            continue

        # Strict name validation: letters only, 1–12 characters.
        if not _NAME_RE.match(char_name):
            errors.append(
                f"**{char_name}**: invalid character name — names must be 1–12 letters only (A–Z)."
            )
            continue

        # Class validation: must resolve to a known WoW class.
        char_class = normalize_class(char_class_raw)
        if char_class not in KNOWN_CLASSES:
            errors.append(
                f"**{char_name}**: unrecognised class `{char_class_raw}` — "
                f"valid classes are: {', '.join(sorted(KNOWN_CLASSES))}."
            )
            continue

        name_lower = char_name.lower()

        # Remaining parts alternate: spec, gs, spec, gs, …
        spec_gs = parts[2:]
        if len(spec_gs) < 2:
            errors.append(f"**{char_name}**: missing spec/GS data.")
            continue

        # ⭐ in the very last part (trailing star after final GS) means all specs
        # for this character are priority.
        last_has_star = "⭐" in spec_gs[-1] or "★" in spec_gs[-1]

        # Note for this line — seeded with any note pre-extracted before the
        # slash split.  When a note was pre-extracted the GS segments no longer
        # contain a note prefix, so segment_note will be empty and line_note
        # stays as-is.  When no pre-extracted note exists, segment_note may
        # still populate line_note via the inline n:/note: path in _parse_gs_and_note.
        line_note = pre_extracted_note

        i = 0
        while i + 1 < len(spec_gs):
            spec_raw = spec_gs[i]
            gs_raw = spec_gs[i + 1]

            spec_has_star = "⭐" in spec_raw or "★" in spec_raw
            gs_has_star = "⭐" in gs_raw or "★" in gs_raw

            # This spec is priority if: line-level star (last GS), star in the
            # spec name segment, or star in this GS segment.
            spec_is_prio = last_has_star or spec_has_star or gs_has_star

            spec = spec_raw.replace("⭐", "").replace("★", "").strip()

            try:
                gs, segment_note = _parse_gs_and_note(gs_raw)
            except ValueError:
                errors.append(f"**{char_name}**: could not parse GS value from `{gs_raw.strip()}`.")
                i += 2
                continue

            if segment_note:
                line_note = segment_note

            if spec:
                key = (name_lower, spec.lower())
                if key not in seen:
                    seen.add(key)
                    results.append(
                        {
                            "char_name": char_name.capitalize(),
                            "char_class": char_class,
                            "spec": spec,
                            "gearscore": gs,
                            "is_prio": spec_is_prio,
                            "is_saved": is_saved,
                            "note": "",  # filled in after the loop
                        }
                    )
            i += 2

        # Back-fill the note for all entries produced by this line.
        if line_note:
            for entry in results:
                if entry["char_name"].lower() == name_lower and entry["note"] == "":
                    entry["note"] = line_note

    return results, errors


def _find_random_text_lines(text: str) -> list[str]:
    """
    Return a list of non-empty lines that are neither a leading tentative
    keyword nor a valid character sign-up line.

    Only call this when the message already contains at least one character
    line (detected via ``_CHAR_LINE_RE``); the function is a no-op otherwise
    because the caller guards on that condition.

    Rules:
      - The *first* non-empty line may be a tentative keyword ("tentative" /
        "maybe") — it is allowed and excluded from the results.
      - Every other non-empty line must match ``_CHAR_LINE_RE``.  Lines that
        do not match are returned as random-text offenders.
    """
    random_lines: list[str] = []
    first_non_empty_checked = False

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        # Allow the very first non-empty line to be a tentative keyword.
        if not first_non_empty_checked:
            first_non_empty_checked = True
            if line.lower() in _TENTATIVE_KEYWORDS:
                continue
        if not _CHAR_LINE_RE.match(line):
            random_lines.append(line)

    return random_lines


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
                signup_data.append(
                    {
                        "discord_user_id": s.discord_user_id,
                    }
                )
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

    if thread_id is None:
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
        if discord_user_id and bot.user:
            mention_a = f"<@{discord_user_id}>"
            mention_b = f"<@!{discord_user_id}>"
            async for msg in thread.history(limit=200):
                if msg.author.id != bot.user.id:
                    continue
                if mention_a not in msg.content and mention_b not in msg.content:
                    continue
                await msg.edit(content=log_message)
                return
        await thread.send(log_message)
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


def _chars_to_dicts(characters) -> list[dict]:
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


def _char_display_description(char: dict) -> str:
    """Return a short spec/class/GS description string for a character dict."""
    spec_or_class = char["spec"] if char["spec"] else (char["char_class"] or "?")
    return f"{spec_or_class} – GS {format_gs(char['gearscore'])}"


def _char_label(char: dict) -> str:
    """Return 'CharName (Spec)' when a spec is present, otherwise just 'CharName'."""
    if char.get("spec"):
        return f"{char['char_name']} ({char['spec']})"
    return char["char_name"]


def _group_chars_by_name(char_dicts: list[dict]) -> list[dict]:
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
        error_text = (
            f"❌ {user.mention} Sign-up rejected:\n"
            + "\n".join(all_errors)
        )
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
                char.gearscore = entry["gearscore"]
                char.is_deleted = False
                char.last_updated = datetime.datetime.now(datetime.timezone.utc)
                session.flush()

                signup_type = (
                    SignupType.prio_character if entry["is_prio"] else SignupType.fill
                )
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
        log_message = (
            f"❓ {user.mention} tentatively signed up for **{raid_name}**:\n"
            + "\n".join(summaries)
        )
    else:
        log_message = (
            f"✅ {user.mention} signed up for **{raid_name}**:\n"
            + "\n".join(summaries)
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


class TextSignupModal(discord.ui.Modal):
    characters = discord.ui.TextInput(
        label="Character Sign-up Lines",
        style=discord.TextStyle.paragraph,
        placeholder="Format: CharName / Class / Spec / GS\nExample: Thrall / Shaman / Enh / 6200\nOne character per line.",
        required=True,
        max_length=2000,
    )

    def __init__(self, raid_id: int, raid_name: str, log_thread_id: Optional[int], initial_text: str = ""):
        super().__init__(title=f"Sign Up: {raid_name}"[:45])
        self.raid_id = raid_id
        self.raid_name = raid_name
        self.log_thread_id = log_thread_id
        self.characters.default = initial_text

    async def on_submit(self, interaction: discord.Interaction):
        await process_text_signup(
            interaction.client,
            interaction.user,
            self.characters.value,
            self.raid_id,
            self.raid_name,
            self.log_thread_id,
            interaction.channel,
            interaction=interaction,
        )


_SELECT_PAGE_SIZE = 25


class SignupPrioritySelectView(discord.ui.View):
    """
    Step 2 of the sign-up flow.

    Lets players optionally mark characters as preferred, then confirms.
    For tentative sign-ups the signup is saved with tentative status but
    preferred character selection is still available.

    Supports more than 25 selected characters via page-by-page navigation
    while tracking priority_ids across pages.
    """

    def __init__(
        self,
        selected_chars: list[dict],
        raid_id: int,
        signup_status: SignupStatus = SignupStatus.signed,
        *,
        page: int = 0,
        priority_ids: set[int] | None = None,
        notes: dict[str, str] | None = None,
    ):
        super().__init__(timeout=120)
        self.raid_id = raid_id
        self.selected_chars = selected_chars
        self.signup_status = signup_status
        self.page = page
        self.priority_ids: set[int] = set(priority_ids) if priority_ids else set()
        self.notes: dict[str, str] = dict(notes) if notes else {}  # char_name.lower() -> note
        self.priority_select: discord.ui.Select | None = None
        self._build_components()

    def _max_pages(self) -> int:
        return max(1, (len(self.selected_chars) + _SELECT_PAGE_SIZE - 1) // _SELECT_PAGE_SIZE)

    def _build_components(self):
        self.clear_items()
        max_pages = self._max_pages()
        start = self.page * _SELECT_PAGE_SIZE
        page_chars = self.selected_chars[start : start + _SELECT_PAGE_SIZE]

        options = [
            discord.SelectOption(
                label=_char_label(c)[:100],
                description=_char_display_description(c)[:100],
                value=str(c["id"]),
                default=c["id"] in self.priority_ids,
            )
            for c in page_chars
        ]
        placeholder = "Mark preferred characters (optional)…"
        if max_pages > 1:
            placeholder = f"Mark preferred – Page {self.page + 1}/{max_pages} (optional)…"
        self.priority_select = discord.ui.Select(
            placeholder=placeholder,
            options=options,
            min_values=0,
            max_values=len(options),
            row=0,
        )
        self.priority_select.callback = self._on_priority_select
        self.add_item(self.priority_select)

        if max_pages > 1:
            prev_btn = discord.ui.Button(
                label="← Prev",
                style=discord.ButtonStyle.secondary,
                disabled=self.page == 0,
                row=1,
            )
            prev_btn.callback = self._on_prev
            self.add_item(prev_btn)

            next_btn = discord.ui.Button(
                label="Next →",
                style=discord.ButtonStyle.secondary,
                disabled=self.page >= max_pages - 1,
                row=1,
            )
            next_btn.callback = self._on_next
            self.add_item(next_btn)

        is_tentative = self.signup_status == SignupStatus.tentative
        confirm_btn = discord.ui.Button(
            label="Confirm Tentative Sign Up" if is_tentative else "Confirm Sign Up",
            style=discord.ButtonStyle.primary if is_tentative else discord.ButtonStyle.success,
            emoji="❓" if is_tentative else "✅",
            row=2,
        )
        confirm_btn.callback = self.confirm
        self.add_item(confirm_btn)

        add_note_btn = discord.ui.Button(
            label="Add Note to Character",
            style=discord.ButtonStyle.secondary,
            emoji="📝",
            row=3,
        )
        add_note_btn.callback = self._on_add_note
        self.add_item(add_note_btn)

    def _update_priority_from_page(self, selected_values: list[str]):
        """Replace priority marks for the current page's items based on the select interaction."""
        start = self.page * _SELECT_PAGE_SIZE
        page_char_ids = {c["id"] for c in self.selected_chars[start : start + _SELECT_PAGE_SIZE]}
        self.priority_ids -= page_char_ids
        for v in selected_values:
            self.priority_ids.add(int(v))

    def _step_text(self) -> str:
        max_pages = self._max_pages()
        is_tentative = self.signup_status == SignupStatus.tentative
        names = ", ".join(f"**{_char_label(c)}**" for c in self.selected_chars)
        text = (
            f"Selected: {names}\n\n"
            f"Optionally mark any as **preferred** below, then click "
            f"**{'Confirm Tentative Sign Up' if is_tentative else 'Confirm Sign Up'}**."
        )
        if max_pages > 1:
            marked = ", ".join(
                _char_label(c) for c in self.selected_chars if c["id"] in self.priority_ids
            )
            if marked:
                text += f"\n\n**Marked as preferred:** {marked}"
            text += f"\n\n*Page {self.page + 1} of {max_pages}*"
        if self.notes:
            seen: set[str] = set()
            note_lines = []
            for c in self.selected_chars:
                key = c["char_name"].lower()
                if key in self.notes and key not in seen:
                    seen.add(key)
                    note_lines.append(f"• **{c['char_name']}**: *{self.notes[key]}*")
            if note_lines:
                text += "\n\n**Notes:**\n" + "\n".join(note_lines)
        return text

    async def _on_add_note(self, interaction: discord.Interaction):
        parent_message = interaction.message
        note_view = NoteCharSelectView(parent_view=self, parent_message=parent_message)
        await interaction.response.edit_message(
            content="Select a character to add a note to:",
            view=note_view,
        )

    async def _on_priority_select(self, interaction: discord.Interaction):
        self._update_priority_from_page(interaction.data.get("values", []))
        self._build_components()
        await interaction.response.edit_message(content=self._step_text(), view=self)

    async def _on_prev(self, interaction: discord.Interaction):
        self.page -= 1
        self._build_components()
        await interaction.response.edit_message(content=self._step_text(), view=self)

    async def _on_next(self, interaction: discord.Interaction):
        self.page += 1
        self._build_components()
        await interaction.response.edit_message(content=self._step_text(), view=self)

    async def confirm(self, interaction: discord.Interaction):
        priority_ids = self.priority_ids
        notes = self.notes  # char_name.lower() -> note
        discord_user_id = interaction.user.id
        raid_id = self.raid_id
        signup_status = self.signup_status
        loop = asyncio.get_event_loop()

        def _upsert_all():
            session = get_session()
            try:
                _upsert_discord_user(session, interaction.user)
                raid = session.get(Raid, raid_id)
                raid_name = raid.name if raid else None
                for char in self.selected_chars:
                    signup_type = (
                        SignupType.prio_character if char["id"] in priority_ids else SignupType.fill
                    )
                    existing = (
                        session.query(Signup)
                        .filter_by(
                            raid_id=raid_id,
                            discord_user_id=discord_user_id,
                            character_id=char["id"],
                        )
                        .first()
                    )
                    char_note = notes.get(char["char_name"].lower()) or None
                    if existing:
                        existing.signup_type = signup_type
                        existing.status = signup_status
                        existing.note = char_note
                    else:
                        session.add(
                            Signup(
                                raid_id=raid_id,
                                discord_user_id=discord_user_id,
                                character_id=char["id"],
                                signup_type=signup_type,
                                status=signup_status,
                                note=char_note,
                            )
                        )
                session.commit()
                return raid_name
            finally:
                session.close()

        raid_name = await loop.run_in_executor(None, _upsert_all)

        is_tentative = signup_status == SignupStatus.tentative
        char_note_shown: set[str] = set()
        lines = []
        for c in self.selected_chars:
            prio_str = " ⭐ preferred" if c["id"] in priority_ids else ""
            name_key = c["char_name"].lower()
            note_str = ""
            if name_key in notes and name_key not in char_note_shown:
                note_str = f" 💬 *{notes[name_key]}*"
                char_note_shown.add(name_key)
            lines.append(f"• **{_char_label(c)}**{prio_str}{note_str}")
        if is_tentative:
            reply_prefix = "❓ Tentatively signed up for the raid:"
            log_emoji = "❓"
            log_action = "tentatively signed up"
        else:
            reply_prefix = "✅ Signed up for the raid:"
            log_emoji = "✅"
            log_action = "signed up"

        await interaction.response.edit_message(
            content=f"{reply_prefix}\n" + "\n".join(lines),
            view=None,
        )

        # Build grouped bullet lines matching the text sign-up format:
        # • **CharName** (CharClass) – Spec ⭐ GS 6200 / Spec2 GS 6300 💬 note
        grouped: dict[str, dict] = {}
        for c in self.selected_chars:
            key = c["char_name"].lower()
            if key not in grouped:
                grouped[key] = {
                    "char_name": c["char_name"],
                    "char_class": c.get("char_class") or "?",
                    "specs": [],
                }
            star = " ⭐" if c["id"] in priority_ids else ""
            grouped[key]["specs"].append(f"{c.get('spec') or '?'}{star} GS {format_gs(c.get('gearscore', 0.0))}")
        bullets = []
        for key, d in grouped.items():
            note_str = f" 💬 *{notes[key]}*" if key in notes else ""
            bullets.append(
                f"• **{d['char_name']}** ({d['char_class']}) – {' / '.join(d['specs'])}{note_str}"
            )
        raid_name_str = f" for **{raid_name}**" if raid_name else ""
        log_message = (
            f"{log_emoji} {interaction.user.mention} {log_action}{raid_name_str}:\n"
            + "\n".join(bullets)
        )
        await _post_to_raid_log(
            interaction.client,
            raid_id,
            log_message,
            discord_user_id=interaction.user.id,
        )
        await update_raid_embed(interaction.client, raid_id)


class SignupCharacterSelectView(discord.ui.View):
    """
    Step 1 of the sign-up flow.

    Shows the player's individual character specs in a multi-select so they
    can choose exactly which spec(s) to sign up with.  Supports more than 25
    characters via page-by-page navigation while keeping selected_ids across
    pages.  After making selections the player clicks "Next Step →" to proceed
    to SignupPrioritySelectView.
    """

    def __init__(
        self,
        char_dicts: list[dict],
        raid_id: int,
        signup_status: SignupStatus = SignupStatus.signed,
        *,
        page: int = 0,
        selected_ids: set[int] | None = None,
    ):
        super().__init__(timeout=120)
        self.raid_id = raid_id
        self.char_dicts = char_dicts
        self.chars_by_id = {c["id"]: c for c in char_dicts}
        self.signup_status = signup_status
        self.page = page
        self.selected_ids: set[int] = set(selected_ids) if selected_ids else set()
        self._build_components()

    def _max_pages(self) -> int:
        return max(1, (len(self.char_dicts) + _SELECT_PAGE_SIZE - 1) // _SELECT_PAGE_SIZE)

    def _build_components(self):
        self.clear_items()
        max_pages = self._max_pages()
        start = self.page * _SELECT_PAGE_SIZE
        page_chars = self.char_dicts[start : start + _SELECT_PAGE_SIZE]

        options = [
            discord.SelectOption(
                label=_char_label(c)[:100],
                description=_char_display_description(c)[:100],
                value=str(c["id"]),
                default=c["id"] in self.selected_ids,
            )
            for c in page_chars
        ]
        placeholder = "Choose spec(s) to sign up with…"
        if max_pages > 1:
            placeholder = f"Choose spec(s) – Page {self.page + 1}/{max_pages}…"
        self.char_select = discord.ui.Select(
            placeholder=placeholder,
            options=options,
            min_values=1 if max_pages == 1 else 0,
            max_values=len(options),
            row=0,
        )
        self.char_select.callback = self._on_select
        self.add_item(self.char_select)

        if max_pages > 1:
            prev_btn = discord.ui.Button(
                label="← Prev",
                style=discord.ButtonStyle.secondary,
                disabled=self.page == 0,
                row=1,
            )
            prev_btn.callback = self._on_prev
            self.add_item(prev_btn)

            next_btn = discord.ui.Button(
                label="Next →",
                style=discord.ButtonStyle.secondary,
                disabled=self.page >= max_pages - 1,
                row=1,
            )
            next_btn.callback = self._on_next
            self.add_item(next_btn)

        is_tentative = self.signup_status == SignupStatus.tentative
        next_step_btn = discord.ui.Button(
            label="Next Step →",
            style=discord.ButtonStyle.primary if is_tentative else discord.ButtonStyle.success,
            emoji="❓" if is_tentative else "✅",
            disabled=len(self.selected_ids) == 0,
            row=2,
        )
        next_step_btn.callback = self._on_next_step
        self.add_item(next_step_btn)

    def _update_selected_from_page(self, selected_values: list[str]):
        """Replace selections for the current page's items based on the select interaction."""
        start = self.page * _SELECT_PAGE_SIZE
        page_char_ids = {c["id"] for c in self.char_dicts[start : start + _SELECT_PAGE_SIZE]}
        self.selected_ids -= page_char_ids
        for v in selected_values:
            self.selected_ids.add(int(v))

    def _step_text(self) -> str:
        max_pages = self._max_pages()
        is_tentative = self.signup_status == SignupStatus.tentative
        base = (
            "**Step 1 of 2:** Select the spec(s) you want to sign up tentatively with:"
            if is_tentative else
            "**Step 1 of 2:** Select the spec(s) you want to sign up with:"
        )
        if max_pages > 1:
            selected_names = ", ".join(
                _char_label(self.chars_by_id[sid])
                for sid in self.selected_ids
                if sid in self.chars_by_id
            )
            if selected_names:
                base += f"\n\n**Selected:** {selected_names}"
            base += f"\n\n*Page {self.page + 1} of {max_pages} — use ← Prev / Next → to browse all characters.*"
        return base

    async def _on_select(self, interaction: discord.Interaction):
        self._update_selected_from_page(interaction.data.get("values", []))
        self._build_components()
        await interaction.response.edit_message(content=self._step_text(), view=self)

    async def _on_prev(self, interaction: discord.Interaction):
        self.page -= 1
        self._build_components()
        await interaction.response.edit_message(content=self._step_text(), view=self)

    async def _on_next(self, interaction: discord.Interaction):
        self.page += 1
        self._build_components()
        await interaction.response.edit_message(content=self._step_text(), view=self)

    async def _on_next_step(self, interaction: discord.Interaction):
        selected_chars = [
            self.chars_by_id[sid] for sid in self.selected_ids if sid in self.chars_by_id
        ]
        if not selected_chars:
            await interaction.response.send_message(
                "❌ Please select at least one character first.", ephemeral=True
            )
            return

        view = SignupPrioritySelectView(selected_chars, self.raid_id, self.signup_status)
        await interaction.response.edit_message(
            content=view._step_text(),
            embed=None,
            view=view,
        )


class NoteCharSelectView(discord.ui.View):
    """
    Shown when the player clicks "Add Note to Character" inside
    SignupPrioritySelectView.  Lets the player pick one character then open a
    modal to type a note.  After the modal is submitted the parent view is
    restored with the note stored.
    """

    def __init__(
        self,
        parent_view: SignupPrioritySelectView,
        parent_message: discord.Message,
    ):
        super().__init__(timeout=120)
        self.parent_view = parent_view
        self.parent_message = parent_message
        self.selected_name: str | None = None
        # Deduplicate selected_chars by character name so the player picks a
        # character (not a per-spec row) when adding a note.
        seen: set[str] = set()
        self.unique_chars: list[dict] = []
        for c in parent_view.selected_chars:
            key = c["char_name"].lower()
            if key not in seen:
                seen.add(key)
                self.unique_chars.append(c)
        self._build_components()

    def _build_components(self):
        self.clear_items()
        options = [
            discord.SelectOption(
                label=c["char_name"][:100],
                description=_char_display_description(c)[:100],
                value=c["char_name"].lower(),
                default=c["char_name"].lower() == self.selected_name,
                emoji="📝" if c["char_name"].lower() in self.parent_view.notes else None,
            )
            for c in self.unique_chars
        ]
        char_select = discord.ui.Select(
            placeholder="Select a character…",
            options=options,
            min_values=1,
            max_values=1,
            row=0,
        )
        char_select.callback = self._on_select
        self.add_item(char_select)

        write_btn = discord.ui.Button(
            label="Write Note",
            style=discord.ButtonStyle.primary,
            emoji="✏️",
            disabled=self.selected_name is None,
            row=1,
        )
        write_btn.callback = self._on_write_note
        self.add_item(write_btn)

        back_btn = discord.ui.Button(
            label="Back",
            style=discord.ButtonStyle.secondary,
            row=1,
        )
        back_btn.callback = self._on_back
        self.add_item(back_btn)

    async def _on_select(self, interaction: discord.Interaction):
        self.selected_name = interaction.data["values"][0]
        self._build_components()
        await interaction.response.edit_message(view=self)

    async def _on_write_note(self, interaction: discord.Interaction):
        char = next((c for c in self.unique_chars if c["char_name"].lower() == self.selected_name), None)
        if char is None:
            await interaction.response.send_message("❌ Could not find the selected character.", ephemeral=True)
            return
        existing_note = self.parent_view.notes.get(self.selected_name, "")
        modal = NoteModal(
            char=char,
            parent_view=self.parent_view,
            parent_message=self.parent_message,
            existing_note=existing_note,
        )
        await interaction.response.send_modal(modal)

    async def _on_back(self, interaction: discord.Interaction):
        self.parent_view._build_components()
        await interaction.response.edit_message(
            content=self.parent_view._step_text(),
            view=self.parent_view,
        )


class NoteModal(discord.ui.Modal):
    """Modal for entering or editing a character note during select-based sign-up."""

    note_input = discord.ui.TextInput(
        label="Note",
        style=discord.TextStyle.short,
        placeholder="Enter a note for this character (leave blank to clear)…",
        required=False,
        max_length=200,
    )

    def __init__(
        self,
        char: dict,
        parent_view: SignupPrioritySelectView,
        parent_message: discord.Message,
        existing_note: str = "",
    ):
        super().__init__(title=f"Note for {char['char_name'][:35]}")
        self.char = char
        self.parent_view = parent_view
        self.parent_message = parent_message
        self.note_input.default = existing_note

    async def on_submit(self, interaction: discord.Interaction):
        note = self.note_input.value.strip()
        name_key = self.char["char_name"].lower()
        if note:
            self.parent_view.notes[name_key] = note
        else:
            self.parent_view.notes.pop(name_key, None)
        # Restore the SignupPrioritySelectView with updated note content
        self.parent_view._build_components()
        try:
            await self.parent_message.edit(
                content=self.parent_view._step_text(),
                view=self.parent_view,
            )
        except Exception:
            logger.warning("Failed to edit parent message after note modal submission")
        action = "saved" if note else "cleared"
        await interaction.response.send_message(
            f"✅ Note {action} for **{self.char['char_name']}**.",
            ephemeral=True,
        )


class SignupView(discord.ui.View):
    """Persistent view attached to each raid sign-up message."""

    def __init__(self):
        super().__init__(timeout=None)  # persistent

    def _get_raid_id(self, interaction: discord.Interaction) -> Optional[int]:
        """Extract raid_id from the embed footer text."""
        try:
            if interaction.message and interaction.message.embeds:
                footer = interaction.message.embeds[0].footer.text or ""
                for part in footer.split():
                    if part.isdigit():
                        return int(part)
        except Exception:
            pass
        return None

    async def _start_signup_flow(
        self,
        interaction: discord.Interaction,
        signup_status: SignupStatus,
    ):
        """Open the two-step character sign-up flow for the given status."""
        raid_id = self._get_raid_id(interaction)
        if raid_id is None:
            await interaction.response.send_message(
                "❌ Could not determine raid ID from this message.", ephemeral=True
            )
            return

        loop = asyncio.get_event_loop()
        discord_user_id = interaction.user.id

        def _fetch():
            session = get_session()
            try:
                raid = session.get(Raid, raid_id)
                if raid is None:
                    return None, []
                chars = (
                    session.query(Character)
                    .filter_by(discord_user_id=discord_user_id, is_deleted=False)
                    .all()
                )
                return raid.status, _chars_to_dicts(chars)
            finally:
                session.close()

        status, char_dicts = await loop.run_in_executor(None, _fetch)

        if status is None:
            await interaction.response.send_message(
                "❌ Could not find this raid.", ephemeral=True
            )
            return

        if status != RaidStatus.open:
            await interaction.response.send_message(
                "❌ This raid is no longer accepting sign-ups.", ephemeral=True
            )
            return

        if not char_dicts:
            await interaction.response.send_message(
                "❌ You have no registered characters. Post a sign-up line or use `/addcharacter` first.",
                ephemeral=True,
            )
            return

        view = SignupCharacterSelectView(char_dicts, raid_id, signup_status)
        await interaction.response.send_message(
            view._step_text(),
            view=view,
            ephemeral=True,
        )

    @discord.ui.button(
        label="Sign Up",
        style=discord.ButtonStyle.success,
        custom_id="signup:multi",
        emoji="✅",
        row=0,
    )
    async def btn_signup(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self._start_signup_flow(interaction, SignupStatus.signed)

    @discord.ui.button(
        label="Tentative",
        style=discord.ButtonStyle.primary,
        custom_id="signup:tentative",
        emoji="❓",
        row=0,
    )
    async def btn_tentative(self, interaction: discord.Interaction, button: discord.ui.Button):
        await self._start_signup_flow(interaction, SignupStatus.tentative)

    @discord.ui.button(
        label="Sign Up on Website",
        style=discord.ButtonStyle.secondary,
        custom_id="signup:website",
        emoji="🌐",
        row=1,
    )
    async def btn_website(self, interaction: discord.Interaction, button: discord.ui.Button):
        raid_id = self._get_raid_id(interaction)
        if raid_id is None:
            await interaction.response.send_message(
                "❌ Could not determine raid ID from this message.", ephemeral=True
            )
            return

        loop = asyncio.get_event_loop()

        def _fetch_raid():
            session = get_session()
            try:
                raid = session.get(Raid, raid_id)
                if raid is None:
                    return None, None, None
                guild = session.get(BotGuild, raid.guild_id) if raid.guild_id else None
                subdomain = guild.subdomain if guild else None
                return raid.guild_id, raid.guild_raid_number, subdomain
            finally:
                session.close()

        guild_id, guild_raid_number, subdomain = await loop.run_in_executor(None, _fetch_raid)

        if BASE_DOMAIN and guild_raid_number:
            # Use subdomain URL: {subdomain or guild_id}.{BASE_DOMAIN}/raids/{guild_raid_number}
            slug = subdomain if subdomain else str(guild_id)
            protocol = "https" if "https" in WEB_BASE_URL else "http"
            url = f"{protocol}://{slug}.{BASE_DOMAIN}/raids/{guild_raid_number}"
        elif guild_id is not None and guild_raid_number:
            url = f"{WEB_BASE_URL.rstrip('/')}/raids/{guild_id}/{guild_raid_number}"
        else:
            url = f"{WEB_BASE_URL.rstrip('/')}/raids/{raid_id}"

        await interaction.response.send_message(
            f"🌐 Sign up for this raid on the website: {url}",
            ephemeral=True,
        )

    @discord.ui.button(
        label="Text Sign Up",
        style=discord.ButtonStyle.secondary,
        custom_id="signup:show_characters",
        emoji="📋",
        row=1,
    )
    async def btn_show_characters(self, interaction: discord.Interaction, button: discord.ui.Button):
        raid_id = self._get_raid_id(interaction)
        if raid_id is None:
            await interaction.response.send_message(
                "❌ Could not determine raid ID from this message.", ephemeral=True
            )
            return

        discord_user_id = interaction.user.id
        loop = asyncio.get_event_loop()

        def _fetch():
            session = get_session()
            try:
                raid = session.get(Raid, raid_id)
                chars = (
                    session.query(Character)
                    .filter_by(discord_user_id=discord_user_id, is_deleted=False)
                    .order_by(Character.char_name, Character.gearscore.desc())
                    .all()
                )
                if not raid:
                    return None, None, None, []
                return raid.id, raid.name, raid.discord_log_thread_id, _chars_to_dicts(chars)
            finally:
                session.close()

        r_id, r_name, r_log_id, char_dicts = await loop.run_in_executor(None, _fetch)

        if r_id is None:
            await interaction.response.send_message("❌ Raid not found.", ephemeral=True)
            return

        initial_text = ""
        if char_dicts:
            char_groups = _group_chars_by_name(char_dicts)
            lines = []
            for g in char_groups:
                parts = [g["char_name"], g["char_class"] or "Unknown"]
                if g["specs"]:
                    for spec, gs, _ in g["specs"]:
                        parts.append(spec)
                        parts.append(f"{gs:.0f}")
                line = " / ".join(parts)
                lines.append(line)
            initial_text = "\n".join(lines)

        await interaction.response.send_modal(
            TextSignupModal(r_id, r_name, r_log_id, initial_text=initial_text)
        )

    @discord.ui.button(
        label="Withdraw",
        style=discord.ButtonStyle.secondary,
        custom_id="signup:withdraw",
        emoji="❌",
        row=0,
    )
    async def btn_withdraw(self, interaction: discord.Interaction, button: discord.ui.Button):
        raid_id = self._get_raid_id(interaction)
        if raid_id is None:
            await interaction.response.send_message("❌ Could not determine raid.", ephemeral=True)
            return

        discord_user_id = interaction.user.id
        loop = asyncio.get_event_loop()

        def _withdraw():
            session = get_session()
            try:
                removed_count = (
                    session.query(Signup)
                    .filter_by(raid_id=raid_id, discord_user_id=discord_user_id)
                    .delete()
                )
                session.commit()
                return removed_count > 0
            finally:
                session.close()

        removed = await loop.run_in_executor(None, _withdraw)

        if removed:
            await interaction.response.send_message("✅ Withdrawn from the raid.", ephemeral=True)
            log_message = f"❌ {interaction.user.mention} withdrew from the raid."
            await _post_to_raid_log(
                interaction.client,
                raid_id,
                log_message,
                discord_user_id=interaction.user.id,
            )
            await update_raid_embed(interaction.client, raid_id)
        else:
            await interaction.response.send_message(
                "You were not signed up for this raid.", ephemeral=True
            )


class SignupCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    # ── DM handler: register characters only ──────────────────────────────
    async def _handle_dm_signup(self, message: discord.Message):
        """
        Handle character registration via DM.

        Parses character lines in the same format as the channel parser but
        only registers the character(s) in the database — it does not sign the
        player up for any specific raid.
        """
        content = message.content
        # Silently ignore DMs that contain no character sign-up lines
        if not any(
            _CHAR_LINE_RE.match(line.strip())
            for line in content.splitlines()
            if line.strip()
        ):
            return

        random_lines = _find_random_text_lines(content)
        parsed, parse_errors = _parse_character_lines(content)

        all_errors: list[str] = []
        if random_lines:
            quoted = "\n".join(f"> {line}" for line in random_lines[:_MAX_RANDOM_LINES_IN_ERROR])
            all_errors.append(
                "Your message contains text that is not a character sign-up line:\n"
                + quoted
                + "\nPlease post **only** your character sign-up lines."
            )
        all_errors.extend(parse_errors)

        if all_errors or not parsed:
            if not all_errors:
                all_errors.append(
                    "No valid sign-up lines could be parsed. "
                    "Expected format: `CharName / Class / Spec / GS`"
                )
            error_text = "❌ Character registration failed:\n" + "\n".join(all_errors)
            try:
                await message.channel.send(error_text)
            except Exception:
                pass
            return

        discord_user_id = message.author.id
        loop = asyncio.get_event_loop()

        def _register():
            session = get_session()
            try:
                _upsert_discord_user(session, message.author)
                char_spec_info: dict[str, dict] = {}
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
                    char.gearscore = entry["gearscore"]
                    char.is_deleted = False
                    char.last_updated = datetime.datetime.now(datetime.timezone.utc)
                    session.flush()

                    key = entry["char_name"].lower()
                    if key not in char_spec_info:
                        char_spec_info[key] = {
                            "char_name": entry["char_name"],
                            "char_class": entry["char_class"],
                            "specs": [],
                        }
                    char_spec_info[key]["specs"].append(
                        {
                            "spec": entry["spec"],
                            "gearscore": entry["gearscore"],
                        }
                    )
                session.commit()

                summaries = []
                for data in char_spec_info.values():
                    spec_parts = [
                        f"{s['spec']} GS {format_gs(s['gearscore'])}" for s in data["specs"]
                    ]
                    summaries.append(
                        f"• **{data['char_name']}** ({data['char_class']}) – {' / '.join(spec_parts)}"
                    )
                return summaries
            finally:
                session.close()

        try:
            summaries = await loop.run_in_executor(None, _register)
        except Exception:
            logger.exception("Failed to process DM character registration from %s", discord_user_id)
            try:
                await message.channel.send(
                    "❌ An error occurred while registering your character(s). Please try again later."
                )
            except Exception:
                pass
            return

        reply = (
            "✅ Character(s) registered successfully:\n"
            + "\n".join(summaries)
            + "\n\n⚠️ **Note:** This only registered your character(s) — "
            "it did **not** sign you up for any raid. "
            "Use the **✅ Sign Up** button on the raid message to sign up."
        )
        try:
            await message.channel.send(reply)
        except Exception:
            pass

    # ── on_message: character list parser ─────────────────────────────────
    @commands.Cog.listener()
    async def on_message(self, message: discord.Message):
        """
        Parse character sign-up lines posted in raid channels.

        Format (one character per line)::

            CharName / CharClass / Spec1 / GS1 [/ Spec2 / GS2 ...] [⭐ or ❌]

        ⭐  = priority character (maps to prio_character signup type)
        ❌  = saved character (ID-locked; marks signup as is_saved=True)

        Characters with multiple specs produce one Character row and one
        Signup per spec, keyed on (discord_user_id, char_name, spec).

        The bot only acts in channels that have an active (open) raid.
        It saves/updates the character(s) in the DB and auto-signs the
        player up for the raid.  A summary reply is sent to the channel.
        """
        # Ignore bot messages
        if message.author.bot:
            return

        # Handle DMs: register characters only (no raid sign-up)
        if not message.guild:
            await self._handle_dm_signup(message)
            return

        # Quick pre-check: does the message contain at least one potential
        # character sign-up line?  If not, ignore silently (normal chat).
        content = message.content
        if not any(
            _CHAR_LINE_RE.match(line.strip())
            for line in content.splitlines()
            if line.strip()
        ):
            return

        loop = asyncio.get_event_loop()

        # If the message is in a thread, use the parent channel to look up the raid.
        if isinstance(message.channel, discord.Thread):
            raid_channel_id = message.channel.parent_id
        else:
            raid_channel_id = message.channel.id

        # Find an open raid in this channel (or parent channel if in a thread)
        def _find_raid():
            session = get_session()
            try:
                raid = (
                    session.query(Raid)
                    .filter_by(discord_channel_id=raid_channel_id, status=RaidStatus.open)
                    .order_by(Raid.id.desc())
                    .first()
                )
                if raid:
                    return {
                        "id": raid.id,
                        "name": raid.name,
                        "discord_log_thread_id": raid.discord_log_thread_id,
                    }
                return None
            finally:
                session.close()

        raid_info = await loop.run_in_executor(None, _find_raid)
        if not raid_info:
            return  # Not a raid channel with an open raid; ignore silently

        await process_text_signup(
            self.bot,
            message.author,
            content,
            raid_info["id"],
            raid_info["name"],
            raid_info.get("discord_log_thread_id"),
            message.channel,
            message_to_delete=message,
        )


async def setup(bot: commands.Bot):
    await bot.add_cog(SignupCog(bot))
