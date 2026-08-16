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


class CharacterEditError(ValueError):
    """A user-facing validation or lookup error raised by the edit flow."""


@dataclass(frozen=True)
class EditableCharacter:
    id: int
    char_name: str
    realm: str
    char_class: str
    spec: str
    gearscore: float


def _to_editable(character: Character) -> EditableCharacter:
    return EditableCharacter(
        id=character.id,
        char_name=character.char_name,
        realm=character.realm or "Icecrown",
        char_class=character.char_class or "",
        spec=character.spec or "",
        gearscore=float(character.gearscore or 0),
    )


def fetch_editable_characters(guild_id: int, discord_user_id: int) -> list[EditableCharacter]:
    """Return the active character rows a user may edit in a guild."""
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
        return [_to_editable(character) for character in characters]
    finally:
        session.close()


def fetch_editable_character(
    character_id: int,
    guild_id: int,
    discord_user_id: int,
) -> EditableCharacter | None:
    """Return one currently editable row after enforcing guild and user ownership."""
    session = get_session()
    try:
        character = (
            session.query(Character)
            .filter_by(
                id=character_id,
                guild_id=guild_id,
                discord_user_id=discord_user_id,
                is_deleted=False,
            )
            .first()
        )
        return _to_editable(character) if character is not None else None
    finally:
        session.close()


def _normalize_edit_fields(
    *,
    name: str,
    realm: str,
    char_class: str,
    spec: str,
    gearscore: str,
) -> tuple[str, str, str, str, float]:
    normalized_name = name.strip().capitalize()
    if not _CHARACTER_NAME_RE.fullmatch(normalized_name):
        raise CharacterEditError("Character names must contain 1–12 letters only.")

    normalized_realm = realm.strip().title()
    if not normalized_realm:
        raise CharacterEditError("Realm cannot be empty.")

    normalized_class = normalize_class(char_class)
    if normalized_class not in WOW_CLASSES:
        raise CharacterEditError("Choose a valid WoW class.")

    requested_spec = spec.strip()
    normalized_spec = next(
        (
            known_spec
            for known_spec in WOW_CLASSES[normalized_class]["specs"]
            if known_spec.casefold() == requested_spec.casefold()
        ),
        None,
    )
    if normalized_spec is None:
        raise CharacterEditError(f"Choose a valid {normalized_class} specialization.")

    try:
        normalized_gearscore = parse_gs(gearscore)
    except ValueError as exc:
        raise CharacterEditError(
            "Gearscore must look like `6200`, `6.2k`, `6.2`, or `BiS`."
        ) from exc

    return (
        normalized_name,
        normalized_realm,
        normalized_class,
        normalized_spec,
        normalized_gearscore,
    )


def update_character_from_flow(
    *,
    character_id: int,
    guild_id: int,
    discord_user_id: int,
    name: str,
    realm: str,
    char_class: str,
    spec: str,
    gearscore: str,
) -> EditableCharacter:
    """Update one spec row while propagating shared character details to its other specs."""
    (
        normalized_name,
        normalized_realm,
        normalized_class,
        normalized_spec,
        normalized_gearscore,
    ) = _normalize_edit_fields(
        name=name,
        realm=realm,
        char_class=char_class,
        spec=spec,
        gearscore=gearscore,
    )

    session = get_session()
    try:
        character = (
            session.query(Character)
            .filter_by(
                id=character_id,
                guild_id=guild_id,
                discord_user_id=discord_user_id,
                is_deleted=False,
            )
            .first()
        )
        if character is None:
            raise CharacterEditError("That character no longer exists or is not yours.")

        old_name = character.char_name
        old_realm = character.realm
        character_rows = (
            session.query(Character)
            .filter_by(
                guild_id=guild_id,
                discord_user_id=discord_user_id,
                char_name=old_name,
                realm=old_realm,
                is_deleted=False,
            )
            .all()
        )
        row_ids = [row.id for row in character_rows]

        conflicting_group = (
            session.query(Character.id)
            .filter(
                Character.guild_id == guild_id,
                Character.discord_user_id == discord_user_id,
                Character.char_name == normalized_name,
                Character.realm == normalized_realm,
                Character.is_deleted == False,  # noqa: E712
                Character.id.notin_(row_ids),
            )
            .first()
        )
        if conflicting_group is not None:
            raise CharacterEditError(
                f"You already have another character named {normalized_name} on {normalized_realm}."
            )

        duplicate_spec = next(
            (
                row
                for row in character_rows
                if row.id != character.id
                and (row.spec or "").casefold() == normalized_spec.casefold()
            ),
            None,
        )
        if duplicate_spec is not None:
            raise CharacterEditError(f"{normalized_name} already has a {normalized_spec} entry.")

        valid_specs = {
            known_spec.casefold() for known_spec in WOW_CLASSES[normalized_class]["specs"]
        }
        incompatible_specs = [
            row.spec
            for row in character_rows
            if row.id != character.id and (row.spec or "").casefold() not in valid_specs
        ]
        if incompatible_specs:
            formatted_specs = ", ".join(str(existing_spec) for existing_spec in incompatible_specs)
            raise CharacterEditError(
                f"The new class does not support your other spec(s): {formatted_specs}. "
                "Edit or remove those entries first."
            )

        character.spec = normalized_spec
        character.gearscore = normalized_gearscore
        now = datetime.datetime.now(datetime.timezone.utc)
        for row in character_rows:
            row.char_name = normalized_name
            row.realm = normalized_realm
            row.char_class = normalized_class
            row.role = get_role_from_spec(normalized_class, row.spec)
            row.last_updated = now

        session.commit()
        return _to_editable(character)
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
            spec = character.spec or "No spec"
            label = f"{character.char_name} · {spec}"[:100]
            description = (
                f"{character.char_class or 'Unknown class'} · "
                f"{character.realm} · GS {format_gs(character.gearscore)}"
            )[:100]
            options.append(
                discord.SelectOption(
                    label=label,
                    value=str(character.id),
                    description=description,
                    emoji="✏️",
                )
            )
        super().__init__(
            placeholder="Choose a character and spec to edit…",
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
        self.realm = discord.ui.TextInput(
            label="Realm",
            default=character.realm,
            min_length=1,
            max_length=50,
        )
        self.char_class = discord.ui.TextInput(
            label="Class",
            default=character.char_class,
            min_length=1,
            max_length=50,
        )
        self.spec = discord.ui.TextInput(
            label="Specialization",
            default=character.spec,
            min_length=1,
            max_length=100,
        )
        self.gearscore = discord.ui.TextInput(
            label="Gearscore",
            default=format_gs(character.gearscore),
            min_length=1,
            max_length=10,
        )
        self.add_item(self.character_name)
        self.add_item(self.realm)
        self.add_item(self.char_class)
        self.add_item(self.spec)
        self.add_item(self.gearscore)

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
                    realm=self.realm.value,
                    char_class=self.char_class.value,
                    spec=self.spec.value,
                    gearscore=self.gearscore.value,
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

        embed = discord.Embed(
            title=f"✅ {updated.char_name} updated!",
            description=(
                f"**Realm:** {updated.realm}\n"
                f"**Class:** {updated.char_class}\n"
                f"**Spec:** {updated.spec}\n"
                f"**Gearscore:** {format_gs(updated.gearscore)}"
            ),
            color=discord.Color.green(),
        )
        embed.set_footer(text="Use /my_characters to review or edit another entry.")
        await interaction.followup.send(embed=embed, ephemeral=True)


def build_edit_picker_embed(guild_name: str, character_count: int) -> discord.Embed:
    description = (
        f"Choose the character and specialization you want to update for **{guild_name}**. "
        "The form will be filled with the current details."
    )
    if character_count > 25:
        description += "\n\nOnly the first 25 entries are shown."
    embed = discord.Embed(
        title="✏️ Edit a character",
        description=description,
        color=discord.Color.blurple(),
    )
    embed.set_footer(text="Only you can use this editor. It expires in 10 minutes.")
    return embed
