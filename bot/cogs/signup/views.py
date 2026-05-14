from __future__ import annotations

import asyncio
import logging
from typing import Optional

import discord

from bot.db import get_session
from db.models import Raid, Signup, SignupType, SignupStatus
from .parser import format_gs
from .char_helpers import _char_label, _char_display_description
from .process import process_text_signup, _upsert_discord_user
from .log_thread import _post_to_raid_log, format_user_raid_log_message
from .embed import update_raid_embed

logger = logging.getLogger(__name__)

_SELECT_PAGE_SIZE = 25


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
        log_message = format_user_raid_log_message(
            raid_id=raid_id,
            discord_user_id=interaction.user.id,
            user_mention=interaction.user.mention,
            emoji=log_emoji,
            action=log_action,
            raid_name=raid_name,
            detail_lines=bullets,
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
