from __future__ import annotations

import asyncio
import datetime
import logging
import re
from dataclasses import dataclass

import discord

from bot.class_utils import normalize_class
from bot.cogs.signup import format_gs, parse_gs
from bot.db import get_session
from bot.role_utils import get_role_from_spec
from bot.wow import WOW_CLASSES
from db.models import Character

logger = logging.getLogger(__name__)

_CHARACTER_NAME_RE = re.compile(r"^[A-Za-z]{1,12}$")
_MAX_SPECS = 6


class CharacterEditError(ValueError):
    """A user-facing validation or lookup error raised by the edit flow."""


@dataclass(frozen=True)
class EditableSpec:
    name: str
    gearscore: float


@dataclass(frozen=True)
class EditableCharacter:
    """One character, including all of its active specialization rows."""

    id: int
    char_name: str
    realm: str
    char_class: str
    specs: tuple[EditableSpec, ...]


def _to_editable(characters: list[Character]) -> EditableCharacter:
    anchor = characters[0]
    return EditableCharacter(
        id=anchor.id,
        char_name=anchor.char_name,
        realm=anchor.realm or "Icecrown",
        char_class=anchor.char_class or "",
        specs=tuple(
            EditableSpec(
                name=character.spec or "",
                gearscore=float(character.gearscore or 0),
            )
            for character in characters
        ),
    )


def _group_characters(characters: list[Character]) -> list[EditableCharacter]:
    grouped: dict[tuple[str, str], list[Character]] = {}
    for character in characters:
        key = (character.char_name.casefold(), (character.realm or "Icecrown").casefold())
        grouped.setdefault(key, []).append(character)
    return [_to_editable(group) for group in grouped.values()]


def fetch_editable_characters(guild_id: int, discord_user_id: int) -> list[EditableCharacter]:
    """Return active characters grouped by name and realm for the picker."""
    session = get_session()
    try:
        characters = (
            session.query(Character)
            .filter_by(
                guild_id=guild_id,
                discord_user_id=discord_user_id,
                is_deleted=False,
            )
            .order_by(Character.char_name, Character.realm, Character.spec, Character.id)
            .all()
        )
        return _group_characters(characters)
    finally:
        session.close()


def fetch_editable_character(
    character_id: int,
    guild_id: int,
    discord_user_id: int,
) -> EditableCharacter | None:
    """Return the whole character group containing an owned anchor row."""
    session = get_session()
    try:
        anchor = (
            session.query(Character)
            .filter_by(
                id=character_id,
                guild_id=guild_id,
                discord_user_id=discord_user_id,
                is_deleted=False,
            )
            .first()
        )
        if anchor is None:
            return None
        characters = (
            session.query(Character)
            .filter_by(
                guild_id=guild_id,
                discord_user_id=discord_user_id,
                char_name=anchor.char_name,
                realm=anchor.realm,
                is_deleted=False,
            )
            .order_by(Character.spec, Character.id)
            .all()
        )
        return _to_editable(characters)
    finally:
        session.close()


def _normalize_edit_fields(
    *,
    name: str,
    char_class: str,
    spec_gearscores: str,
) -> tuple[str, str, list[EditableSpec]]:
    normalized_name = name.strip().capitalize()
    if not _CHARACTER_NAME_RE.fullmatch(normalized_name):
        raise CharacterEditError("Character names must contain 1–12 letters only.")

    normalized_class = normalize_class(char_class)
    if normalized_class not in WOW_CLASSES:
        raise CharacterEditError("Choose a valid WoW class.")

    known_specs = {
        known_spec.casefold(): known_spec for known_spec in WOW_CLASSES[normalized_class]["specs"]
    }
    normalized_specs: list[EditableSpec] = []
    seen_specs: set[str] = set()

    for line_number, raw_line in enumerate(spec_gearscores.splitlines(), start=1):
        line = raw_line.strip()
        if not line:
            continue
        parts = [part.strip() for part in line.split("/")]
        if len(parts) != 2 or not all(parts):
            raise CharacterEditError(f"Line {line_number} must use `Specialization / Gearscore`.")

        requested_spec, requested_gearscore = parts
        normalized_spec = known_specs.get(requested_spec.casefold())
        if normalized_spec is None:
            raise CharacterEditError(
                f"Line {line_number}: choose a valid {normalized_class} specialization."
            )
        spec_key = normalized_spec.casefold()
        if spec_key in seen_specs:
            raise CharacterEditError(f"{normalized_spec} is listed more than once.")

        try:
            normalized_gearscore = parse_gs(requested_gearscore)
        except ValueError as exc:
            raise CharacterEditError(
                f"Line {line_number}: gearscore must look like `6200`, `6.2k`, `6.2`, or `BiS`."
            ) from exc

        seen_specs.add(spec_key)
        normalized_specs.append(EditableSpec(normalized_spec, normalized_gearscore))

    if not normalized_specs:
        raise CharacterEditError("Add at least one `Specialization / Gearscore` line.")
    if len(normalized_specs) > _MAX_SPECS:
        raise CharacterEditError(f"A character can have at most {_MAX_SPECS} specializations.")

    return normalized_name, normalized_class, normalized_specs


def update_character_from_flow(
    *,
    character_id: int,
    guild_id: int,
    discord_user_id: int,
    name: str,
    char_class: str,
    spec_gearscores: str,
) -> EditableCharacter:
    """Update one character and reconcile all of its specialization rows."""
    normalized_name, normalized_class, requested_specs = _normalize_edit_fields(
        name=name,
        char_class=char_class,
        spec_gearscores=spec_gearscores,
    )

    session = get_session()
    try:
        anchor = (
            session.query(Character)
            .filter_by(
                id=character_id,
                guild_id=guild_id,
                discord_user_id=discord_user_id,
                is_deleted=False,
            )
            .first()
        )
        if anchor is None:
            raise CharacterEditError("That character no longer exists or is not yours.")

        character_rows = (
            session.query(Character)
            .filter_by(
                guild_id=guild_id,
                discord_user_id=discord_user_id,
                char_name=anchor.char_name,
                realm=anchor.realm,
                is_deleted=False,
            )
            .order_by(Character.id)
            .all()
        )
        row_ids = [row.id for row in character_rows]

        conflicting_group = (
            session.query(Character.id)
            .filter(
                Character.guild_id == guild_id,
                Character.discord_user_id == discord_user_id,
                Character.char_name.ilike(normalized_name),
                Character.realm == anchor.realm,
                Character.is_deleted == False,  # noqa: E712
                Character.id.notin_(row_ids),
            )
            .first()
        )
        if conflicting_group is not None:
            raise CharacterEditError(
                f"You already have another character named {normalized_name} on {anchor.realm}."
            )

        rows_by_spec = {(row.spec or "").casefold(): row for row in character_rows}
        requested_keys = {spec.name.casefold() for spec in requested_specs}
        now = datetime.datetime.now(datetime.timezone.utc)
        updated_rows: list[Character] = []

        for requested in requested_specs:
            row = rows_by_spec.get(requested.name.casefold())
            if row is None:
                row = Character(
                    guild_id=guild_id,
                    discord_user_id=discord_user_id,
                    realm=anchor.realm,
                    prof_1=anchor.prof_1,
                    prof_2=anchor.prof_2,
                    sfs_count=anchor.sfs_count,
                    val_count=anchor.val_count,
                    membership_status=anchor.membership_status,
                    discord_role=anchor.discord_role,
                )
                session.add(row)
            row.char_name = normalized_name
            row.char_class = normalized_class
            row.spec = requested.name
            row.gearscore = requested.gearscore
            row.role = get_role_from_spec(normalized_class, requested.name)
            row.is_deleted = False
            row.last_updated = now
            updated_rows.append(row)

        for row in character_rows:
            if (row.spec or "").casefold() not in requested_keys:
                row.is_deleted = True
                row.last_updated = now

        session.flush()
        result = _to_editable(updated_rows)
        session.commit()
        return result
    except CharacterEditError:
        session.rollback()
        raise
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


class _CharacterSelect(discord.ui.Select):
    def __init__(self, characters: list[EditableCharacter]):
        options = []
        for character in characters[:25]:
            spec_summary = ", ".join(spec.name for spec in character.specs) or "No specs"
            options.append(
                discord.SelectOption(
                    label=character.char_name[:100],
                    value=str(character.id),
                    description=(
                        f"{character.char_class or 'Unknown class'} · "
                        f"{character.realm} · {spec_summary}"
                    )[:100],
                    emoji="✏️",
                )
            )
        super().__init__(
            placeholder="Choose a character to edit…",
            min_values=1,
            max_values=1,
            options=options,
        )

    async def callback(self, interaction: discord.Interaction) -> None:
        view = self.view
        if not isinstance(view, CharacterEditView):
            return
        selected_id = int(self.values[0])
        try:
            character = await asyncio.get_running_loop().run_in_executor(
                None,
                fetch_editable_character,
                selected_id,
                view.guild_id,
                view.user_id,
            )
        except Exception:
            logger.exception(
                "Failed to load character %s for user %s in guild %s",
                selected_id,
                view.user_id,
                view.guild_id,
            )
            await interaction.response.send_message(
                "❌ I couldn't load that character. Please try again later.",
                ephemeral=True,
            )
            return
        if character is None:
            await interaction.response.send_message(
                "❌ That character is no longer available. Run `/my_characters` again.",
                ephemeral=True,
            )
            return
        await interaction.response.send_modal(
            EditCharacterModal(
                user_id=view.user_id,
                guild_id=view.guild_id,
                character=character,
            )
        )


class CharacterEditView(discord.ui.View):
    """Owned character picker shared by the list and guided Discord flows."""

    def __init__(
        self,
        *,
        user_id: int,
        guild_id: int,
        characters: list[EditableCharacter],
        timeout: float = 600,
    ):
        super().__init__(timeout=timeout)
        self.user_id = user_id
        self.guild_id = guild_id
        self.characters = characters
        self.message: discord.Message | None = None
        self.add_item(_CharacterSelect(characters))

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        if interaction.user.id == self.user_id:
            return True
        await interaction.response.send_message(
            "This character editor belongs to someone else.", ephemeral=True
        )
        return False

    async def on_timeout(self) -> None:
        for item in self.children:
            item.disabled = True
        if self.message is not None:
            try:
                await self.message.edit(view=self)
            except (discord.HTTPException, discord.NotFound):
                pass


class EditCharacterModal(discord.ui.Modal):
    def __init__(
        self,
        *,
        user_id: int,
        guild_id: int,
        character: EditableCharacter,
    ):
        super().__init__(title=f"Edit {character.char_name}"[:45], timeout=600)
        self.user_id = user_id
        self.guild_id = guild_id
        self.character_id = character.id

        self.character_name = discord.ui.TextInput(
            label="Character name",
            default=character.char_name,
            min_length=1,
            max_length=12,
        )
        self.char_class = discord.ui.TextInput(
            label="Class",
            default=character.char_class,
            min_length=1,
            max_length=50,
        )
        self.spec_gearscores = discord.ui.TextInput(
            label="Specializations and gearscores",
            style=discord.TextStyle.paragraph,
            default="\n".join(
                f"{spec.name} / {format_gs(spec.gearscore)}" for spec in character.specs
            ),
            placeholder="Holy / 6200\nProtection / 6100",
            min_length=1,
            max_length=1000,
        )
        self.add_item(self.character_name)
        self.add_item(self.char_class)
        self.add_item(self.spec_gearscores)

    async def on_submit(self, interaction: discord.Interaction) -> None:
        if interaction.user.id != self.user_id:
            await interaction.response.send_message(
                "This character editor belongs to someone else.", ephemeral=True
            )
            return

        await interaction.response.defer(ephemeral=True, thinking=True)
        try:
            updated = await asyncio.get_running_loop().run_in_executor(
                None,
                lambda: update_character_from_flow(
                    character_id=self.character_id,
                    guild_id=self.guild_id,
                    discord_user_id=self.user_id,
                    name=self.character_name.value,
                    char_class=self.char_class.value,
                    spec_gearscores=self.spec_gearscores.value,
                ),
            )
        except CharacterEditError as exc:
            await interaction.followup.send(f"❌ {exc}", ephemeral=True)
            return
        except Exception:
            logger.exception(
                "Failed to edit character %s for user %s in guild %s",
                self.character_id,
                self.user_id,
                self.guild_id,
            )
            await interaction.followup.send(
                "❌ I couldn't update that character. Please try again later.",
                ephemeral=True,
            )
            return

        spec_lines = "\n".join(
            f"**{spec.name}:** {format_gs(spec.gearscore)}" for spec in updated.specs
        )
        embed = discord.Embed(
            title=f"✅ {updated.char_name} updated!",
            description=(
                f"**Class:** {updated.char_class}\n**Realm:** {updated.realm}\n{spec_lines}"
            ),
            color=discord.Color.green(),
        )
        embed.set_footer(text="Use /my_characters to review or edit another character.")
        await interaction.followup.send(embed=embed, ephemeral=True)


def build_edit_picker_embed(guild_name: str, character_count: int) -> discord.Embed:
    description = (
        f"Choose the character you want to update for **{guild_name}**. "
        "The form will be filled with its current name, class, specializations, and gearscores."
    )
    if character_count > 25:
        description += "\n\nOnly the first 25 characters are shown."
    embed = discord.Embed(
        title="✏️ Edit a character",
        description=description,
        color=discord.Color.blurple(),
    )
    embed.set_footer(text="Only you can use this editor. It expires in 10 minutes.")
    return embed
