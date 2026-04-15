from __future__ import annotations

import asyncio
import datetime
import logging
import re
from typing import Optional

import discord
from discord.ext import commands

from bot.config import WEB_BASE_URL
from bot.db import get_session
from bot.class_utils import normalize_class, KNOWN_CLASSES
from db.models import Character, DiscordUser, Raid, RaidStatus, Signup, SignupStatus, SignupType

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

# Keywords that mark a text sign-up as tentative when placed on the first non-empty line.
_TENTATIVE_KEYWORDS = frozenset({"tentative", "maybe"})


def _is_tentative_message(text: str) -> bool:
    """Return True if the first non-empty line of *text* is a tentative keyword."""
    for line in text.splitlines():
        stripped = line.strip().lower()
        if stripped:
            return stripped in _TENTATIVE_KEYWORDS
    return False


def parse_gs(raw: str) -> float:
    """Parse a gearscore string into a float.

    Accepts full numbers (``"6200"``), decimal shorthand (``"6.2"`` → 6200),
    and the explicit *k* suffix (``"6.2k"`` → 6200).  Values already in the
    thousands are returned unchanged.  Any commas are treated as decimal
    separators (e.g. ``"6,2"`` → 6200).  Values below 1000 are auto-scaled
    by 1000, so ``"999"`` → 999000 — use the full number for sub-1000 scores.
    """
    cleaned = raw.strip().replace(",", ".")
    if cleaned.lower().endswith("k"):
        return float(cleaned[:-1]) * 1000
    value = float(cleaned)
    if value < 1000:
        value *= 1000
    return value


def _parse_gs_and_note(gs_raw: str) -> tuple[float, str]:
    """Parse a GS segment, returning ``(gearscore, note)``.

    Star markers (⭐ ★) are stripped before parsing.  Any text that follows
    the numeric GS value (after stripping stars and whitespace) is returned
    as the note.  Raises ``ValueError`` if no valid GS number is found.
    """
    cleaned = gs_raw.replace("⭐", "").replace("★", "").strip()
    m = _GS_NOTE_RE.match(cleaned)
    if not m:
        raise ValueError(f"Cannot parse GS from {gs_raw!r}")
    gs = parse_gs(m.group(1))
    note = (m.group(2) or "").strip()
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
        if not line or not _CHAR_LINE_RE.match(line):
            continue

        is_saved = "❌" in line or "✗" in line

        # Strip only saved markers before splitting; keep star markers in place
        # so we can detect per-spec priority later.
        clean = line.replace("❌", "").replace("✗", "").strip()

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

        # Note for this line — accumulated from any GS segment that has trailing text.
        line_note = ""

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
        value=raid["date"].strftime("%Y-%m-%d %H:%M UTC"),
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


async def _post_to_raid_log(bot: discord.Client, raid_id: int, log_message: str):
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
        logger.warning(f"Failed to post to raid log thread {thread_id}: {e}")


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
    return f"{spec_or_class} – GS {char['gearscore']:.0f}"


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


class SignupPrioritySelectView(discord.ui.View):
    """
    Step 2 of the sign-up flow.

    For normal sign-ups: lets players optionally mark characters as priority, then confirms.
    For tentative sign-ups: skips priority and just shows a confirm button.
    """

    def __init__(self, selected_chars: list[dict], raid_id: int, signup_status: SignupStatus = SignupStatus.signed):
        super().__init__(timeout=120)
        self.raid_id = raid_id
        self.selected_chars = selected_chars
        self.signup_status = signup_status
        self.priority_select: discord.ui.Select | None = None

        if signup_status == SignupStatus.signed:
            options = [
                discord.SelectOption(
                    label=_char_label(c)[:100],
                    description=_char_display_description(c)[:100],
                    value=str(c["id"]),
                )
                for c in selected_chars[:25]
            ]
            self.priority_select = discord.ui.Select(
                placeholder="Mark preferred characters (optional)…",
                options=options,
                min_values=0,
                max_values=len(options),
                row=0,
            )
            self.priority_select.callback = self._on_priority_select
            self.add_item(self.priority_select)

        is_tentative = signup_status == SignupStatus.tentative
        confirm_btn = discord.ui.Button(
            label="Confirm Tentative Sign Up" if is_tentative else "Confirm Sign Up",
            style=discord.ButtonStyle.primary if is_tentative else discord.ButtonStyle.success,
            emoji="❓" if is_tentative else "✅",
            row=1,
        )
        confirm_btn.callback = self.confirm
        self.add_item(confirm_btn)

    async def _on_priority_select(self, interaction: discord.Interaction):
        """Acknowledge the select interaction; values are read when Confirm is pressed."""
        await interaction.response.defer()

    async def confirm(self, interaction: discord.Interaction):
        priority_ids = {int(v) for v in (self.priority_select.values or [])}
        discord_user_id = interaction.user.id
        raid_id = self.raid_id
        signup_status = self.signup_status
        loop = asyncio.get_event_loop()

        def _upsert_all():
            session = get_session()
            try:
                _upsert_discord_user(session, interaction.user)
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
                    if existing:
                        existing.signup_type = signup_type
                        existing.status = signup_status
                    else:
                        session.add(
                            Signup(
                                raid_id=raid_id,
                                discord_user_id=discord_user_id,
                                character_id=char["id"],
                                signup_type=signup_type,
                                status=signup_status,
                            )
                        )
                session.commit()
            finally:
                session.close()

        await loop.run_in_executor(None, _upsert_all)

        is_tentative = signup_status == SignupStatus.tentative
        if is_tentative:
            lines = [
                f"• **{_char_label(c)}**"
                for c in self.selected_chars
            ]
            reply_prefix = "❓ Tentatively signed up for the raid:"
            log_emoji = "❓"
            log_action = "tentatively signed up"
        else:
            lines = [
                f"• **{_char_label(c)}**" + (" ⭐ preferred" if c["id"] in priority_ids else "")
                for c in self.selected_chars
            ]
            reply_prefix = "✅ Signed up for the raid:"
            log_emoji = "✅"
            log_action = "signed up"

        await interaction.response.edit_message(
            content=f"{reply_prefix}\n" + "\n".join(lines),
            view=None,
        )

        log_message = (
            f"{log_emoji} {interaction.user.mention} {log_action} with: "
            + ", ".join(f"**{_char_label(c)}**" for c in self.selected_chars)
        )
        await _post_to_raid_log(interaction.client, raid_id, log_message)
        await update_raid_embed(interaction.client, raid_id)


class SignupCharacterSelectView(discord.ui.View):
    """
    Step 1 of the sign-up flow.

    Shows the player's individual character specs in a multi-select so they
    can choose exactly which spec(s) to sign up with.  After selecting,
    transitions to SignupPrioritySelectView.
    """

    def __init__(self, char_dicts: list[dict], raid_id: int, signup_status: SignupStatus = SignupStatus.signed):
        super().__init__(timeout=120)
        self.raid_id = raid_id
        self.char_dicts = char_dicts
        self.chars_by_id = {c["id"]: c for c in char_dicts}
        self.signup_status = signup_status

        options = []
        for c in char_dicts[:25]:
            label = _char_label(c)[:100]
            description = _char_display_description(c)[:100]
            options.append(
                discord.SelectOption(
                    label=label,
                    description=description,
                    value=str(c["id"]),
                )
            )

        self.char_select = discord.ui.Select(
            placeholder="Choose spec(s) to sign up with…",
            options=options,
            min_values=1,
            max_values=len(options),
            row=0,
        )
        self.char_select.callback = self._on_select
        self.add_item(self.char_select)

    async def _on_select(self, interaction: discord.Interaction):
        selected_ids = {int(v) for v in interaction.data["values"]}
        selected_chars = [
            self.chars_by_id[sid] for sid in selected_ids if sid in self.chars_by_id
        ]

        names = ", ".join(_char_label(c) for c in selected_chars)
        is_tentative = self.signup_status == SignupStatus.tentative
        view = SignupPrioritySelectView(selected_chars, self.raid_id, self.signup_status)
        if is_tentative:
            next_step_text = f"Selected: {names}\n\nClick **Confirm Tentative Sign Up** to sign up tentatively."
        else:
            next_step_text = (
                f"Selected: {names}\n\n"
                "Optionally mark any as **preferred** below, then click **Confirm Sign Up**."
            )
        await interaction.response.edit_message(
            content=next_step_text,
            embed=None,
            view=view,
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
        is_tentative = signup_status == SignupStatus.tentative
        await interaction.response.send_message(
            "**Step 1 of 2:** Select the spec(s) you want to sign up tentatively with:"
            if is_tentative else
            "**Step 1 of 2:** Select the spec(s) you want to sign up with:",
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
                    return None, None
                return raid.guild_id, raid.guild_raid_number
            finally:
                session.close()

        guild_id, guild_raid_number = await loop.run_in_executor(None, _fetch_raid)

        if guild_id is not None and guild_raid_number:
            url = f"{WEB_BASE_URL.rstrip('/')}/raids/{guild_id}/{guild_raid_number}"
        else:
            url = f"{WEB_BASE_URL.rstrip('/')}/raids/{raid_id}"

        await interaction.response.send_message(
            f"🌐 Sign up for this raid on the website: {url}",
            ephemeral=True,
        )

    @discord.ui.button(
        label="Show Characters",
        style=discord.ButtonStyle.secondary,
        custom_id="signup:show_characters",
        emoji="📋",
        row=1,
    )
    async def btn_show_characters(self, interaction: discord.Interaction, button: discord.ui.Button):
        discord_user_id = interaction.user.id
        loop = asyncio.get_event_loop()

        def _fetch():
            session = get_session()
            try:
                chars = (
                    session.query(Character)
                    .filter_by(discord_user_id=discord_user_id, is_deleted=False)
                    .order_by(Character.char_name, Character.gearscore.desc())
                    .all()
                )
                return _chars_to_dicts(chars)
            finally:
                session.close()

        char_dicts = await loop.run_in_executor(None, _fetch)

        if not char_dicts:
            await interaction.response.send_message(
                "You have no registered characters. Use `/addcharacter` to add one.",
                ephemeral=True,
            )
            return

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

        codeblock = "```\n" + "\n".join(lines) + "\n```"
        await interaction.response.send_message(codeblock, ephemeral=True)

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
            await _post_to_raid_log(interaction.client, raid_id, log_message)
            await update_raid_embed(interaction.client, raid_id)
        else:
            await interaction.response.send_message(
                "You were not signed up for this raid.", ephemeral=True
            )


class SignupCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

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
        # Ignore bot messages and DMs
        if message.author.bot or not message.guild:
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

        # ── Strict validation ────────────────────────────────────────────────
        # Now that we know this is a raid channel, validate the full message.

        # 1. Check for non-signup lines mixed in with character lines.
        random_lines = _find_random_text_lines(content)

        # 2. Parse character lines with strict name + class validation.
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
            try:
                await message.delete()
            except Exception:
                pass
            if not all_errors:
                all_errors.append(
                    "No valid sign-up lines could be parsed. "
                    "Expected format: `CharName / Class / Spec / GS`"
                )
            error_text = (
                f"❌ {message.author.mention} Sign-up rejected:\n"
                + "\n".join(all_errors)
            )
            try:
                await message.channel.send(error_text)
            except Exception:
                pass
            return
        # ── end validation ───────────────────────────────────────────────────

        discord_user_id = message.author.id
        raid_id = raid_info["id"]

        def _save_and_signup():
            session = get_session()
            try:
                _upsert_discord_user(session, message.author)

                # Remove ALL existing signups for this user+raid so the new message
                # fully overwrites the old sign-up instead of merging with it.
                session.query(Signup).filter_by(
                    raid_id=raid_id,
                    discord_user_id=discord_user_id,
                ).delete()

                # Accumulate spec info per char_name for grouped summary display
                char_spec_info: dict[str, dict] = {}
                for entry in parsed:
                    # Upsert character keyed on (discord_user_id, char_name, spec)
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
                    char.last_updated = datetime.datetime.now(datetime.timezone.utc)
                    session.flush()

                    # Upsert signup (one per character row per raid)
                    signup_type = (
                        SignupType.prio_character if entry["is_prio"] else SignupType.fill
                    )
                    existing = (
                        session.query(Signup)
                        .filter_by(raid_id=raid_id, discord_user_id=discord_user_id, character_id=char.id)
                        .first()
                    )
                    if existing:
                        existing.signup_type = signup_type
                        existing.status = signup_status
                        existing.is_saved = entry["is_saved"]
                        existing.note = entry.get("note") or None
                    else:
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

                    # Collect spec data for grouped summary
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

                # Build summaries grouped by character name
                summaries = []
                for data in char_spec_info.values():
                    spec_parts = []
                    for s in data["specs"]:
                        star = " ⭐" if s["is_prio"] else ""
                        spec_parts.append(f"{s['spec']}{star} GS {s['gearscore']:.0f}")
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
            summaries = await loop.run_in_executor(None, _save_and_signup)
        except Exception:
            logger.exception("Failed to process chat character sign-up from %s", discord_user_id)
            return

        if signup_status == SignupStatus.tentative:
            log_message = (
                f"❓ {message.author.mention} tentatively signed up for **{raid_info['name']}**:\n"
                + "\n".join(summaries)
            )
        else:
            log_message = (
                f"✅ {message.author.mention} signed up for **{raid_info['name']}**:\n"
                + "\n".join(summaries)
            )

        # Delete the user's message to keep the channel clean
        try:
            await message.delete()
        except Exception:
            pass

        # Post sign-up summary to the log thread; fall back to channel if no thread exists
        log_thread_id = raid_info.get("discord_log_thread_id")
        if log_thread_id:
            try:
                thread = self.bot.get_channel(log_thread_id)
                if thread is None:
                    thread = await self.bot.fetch_channel(log_thread_id)
                await thread.send(log_message)
            except Exception:
                logger.warning("Failed to post to log thread, falling back to channel")
                try:
                    await message.channel.send(log_message)
                except Exception:
                    pass
        else:
            try:
                await message.channel.send(log_message)
            except Exception:
                pass

        # Refresh the raid embed
        await update_raid_embed(self.bot, raid_id)


async def setup(bot: commands.Bot):
    await bot.add_cog(SignupCog(bot))
