from __future__ import annotations

import asyncio
import datetime
import logging
import re
from typing import Optional

import discord

from bot.class_utils import normalize_class
from bot.cogs.signup import format_gs, parse_gs
from bot.config import WEB_BASE_URL
from bot.db import get_session
from bot.role_utils import get_role_from_spec
from bot.wow import REALMS, WOW_CLASSES
from db.models import Character

from .edit_flow import CharacterEditView, build_edit_picker_embed, fetch_editable_characters

logger = logging.getLogger(__name__)

_CHARACTER_NAME_RE = re.compile(r"^[A-Za-z]{1,12}$")


def build_character_guide_url(guild_id: int) -> str:
    """Return the authenticated, guild-scoped website onboarding URL."""
    return f"{WEB_BASE_URL.rstrip('/')}/help/add-characters/{guild_id}"


def validate_character_details(name: str, realm: str, gearscore: str) -> tuple[str, str, float]:
    """Validate and normalize the free-text fields collected by the Discord wizard."""
    normalized_name = name.strip().capitalize()
    if not _CHARACTER_NAME_RE.fullmatch(normalized_name):
        raise ValueError("Character names must contain 1–12 letters only.")

    normalized_realm = realm.strip().title() or REALMS[0]
    try:
        normalized_gearscore = parse_gs(gearscore)
    except ValueError as exc:
        raise ValueError("Gearscore must look like `6200`, `6.2k`, `6.2`, or `BiS`.") from exc

    return normalized_name, normalized_realm, normalized_gearscore


def _upsert_guided_character(
    *,
    guild_id: int,
    discord_user_id: int,
    name: str,
    realm: str,
    char_class: str,
    spec: str,
    gearscore: float,
    top_role: Optional[str],
) -> None:
    session = get_session()
    try:
        character = (
            session.query(Character)
            .filter_by(
                guild_id=guild_id,
                discord_user_id=discord_user_id,
                char_name=name,
                realm=realm,
                spec=spec,
            )
            .first()
        )
        if character is None:
            character = Character(
                guild_id=guild_id,
                discord_user_id=discord_user_id,
                char_name=name,
                realm=realm,
                spec=spec,
            )
            session.add(character)

        canonical_class = normalize_class(char_class)
        character.char_class = canonical_class
        character.role = get_role_from_spec(canonical_class, spec)
        character.gearscore = gearscore
        character.discord_role = top_role
        character.membership_status = "active"
        character.is_deleted = False
        character.last_updated = datetime.datetime.now(datetime.timezone.utc)

        session.query(Character).filter_by(
            guild_id=guild_id,
            discord_user_id=discord_user_id,
        ).update(
            {
                "discord_role": top_role,
                "membership_status": "active",
                "last_updated": datetime.datetime.now(datetime.timezone.utc),
            }
        )
        session.commit()
    finally:
        session.close()


def _class_embed(guild_name: str) -> discord.Embed:
    embed = discord.Embed(
        title="⚔️ Let's add your character",
        description=(
            f"I'll guide you through adding a character to **{guild_name}**.\n\n"
            "**Step 1 of 3:** Choose the character's class."
        ),
        color=discord.Color.blurple(),
    )
    embed.set_footer(text="Only you can use these controls. This guide expires in 10 minutes.")
    return embed


def _method_embed(guild_name: str) -> discord.Embed:
    embed = discord.Embed(
        title="⚔️ How would you like to manage your characters?",
        description=(
            f"You're managing characters for **{guild_name}**. Choose what you want to do:\n\n"
            "🧭 **Guided setup** — add characters individually with class and spec menus\n"
            "📝 **Add all at once** — paste your whole character list in one message\n"
            "✏️ **Edit existing** — choose a saved character and update its details"
        ),
        color=discord.Color.blurple(),
    )
    embed.add_field(
        name="Have several characters?",
        value=(
            "The text method can register multiple characters and multiple specs at the same time."
        ),
        inline=False,
    )
    embed.set_footer(text="Only you can use these controls. This guide expires in 10 minutes.")
    return embed


def _bulk_text_embed(guild_name: str) -> discord.Embed:
    embed = discord.Embed(
        title="📝 Add all your characters at once",
        description=(
            "Send me a **new DM message** with one character per line. Use this order:\n\n"
            "`Name / Class / Spec / Gearscore`\n\n"
            "For another spec on the same character, add another `Spec / Gearscore` pair.\n\n"
            "**Example**\n"
            "```\n"
            "Shamilly / Shaman / Enhancement / 6400 / Restoration / 6500\n"
            "Tethakai / Shaman / Restoration / 6000\n"
            "Cybelais / Druid / Feral (Cat) / 6000\n"
            "Ilandia / Paladin / Protection / 5700\n"
            "```\n"
            "Send only the character lines—I'll validate and save the whole list automatically."
        ),
        color=discord.Color.blurple(),
    )
    embed.set_footer(
        text=(
            f"Characters will be added to {guild_name}. "
            "If we share multiple servers, I'll ask you to confirm the server."
        )
    )
    return embed


def _spec_embed(guild_name: str, char_class: str) -> discord.Embed:
    embed = discord.Embed(
        title="⚔️ Let's add your character",
        description=(
            f"Adding a character to **{guild_name}**.\n\n"
            f"✅ Class: **{char_class}**\n"
            "**Step 2 of 3:** Choose the character's specialization."
        ),
        color=discord.Color.blurple(),
    )
    embed.set_footer(text="You can go back if you picked the wrong class.")
    return embed


class _OwnedView(discord.ui.View):
    def __init__(self, user_id: int, *, timeout: float = 600):
        super().__init__(timeout=timeout)
        self.user_id = user_id
        self.message: discord.Message | None = None

    async def interaction_check(self, interaction: discord.Interaction) -> bool:
        if interaction.user.id == self.user_id:
            return True
        await interaction.response.send_message(
            "This character guide belongs to someone else.", ephemeral=True
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


class _ClassSelect(discord.ui.Select):
    def __init__(self):
        options = [discord.SelectOption(label=class_name, emoji="⚔️") for class_name in WOW_CLASSES]
        super().__init__(placeholder="Choose a class…", min_values=1, max_values=1, options=options)

    async def callback(self, interaction: discord.Interaction) -> None:
        view = self.view
        if not isinstance(view, GuidedClassView):
            return
        next_view = GuidedSpecView(
            user_id=view.user_id,
            guild_id=view.guild_id,
            guild_name=view.guild_name,
            char_class=self.values[0],
            top_role=view.top_role,
        )
        next_view.message = interaction.message
        await interaction.response.edit_message(
            embed=_spec_embed(view.guild_name, self.values[0]), view=next_view
        )


class DiscordMethodView(_OwnedView):
    def __init__(
        self,
        *,
        user_id: int,
        guild_id: int,
        guild_name: str,
        top_role: Optional[str],
    ):
        super().__init__(user_id)
        self.guild_id = guild_id
        self.guild_name = guild_name
        self.top_role = top_role

    @discord.ui.button(
        label="Continue with individual characters",
        style=discord.ButtonStyle.primary,
        emoji="🧭",
    )
    async def individual(
        self, interaction: discord.Interaction, _button: discord.ui.Button
    ) -> None:
        next_view = GuidedClassView(
            user_id=self.user_id,
            guild_id=self.guild_id,
            guild_name=self.guild_name,
            top_role=self.top_role,
        )
        next_view.message = interaction.message
        await interaction.response.edit_message(embed=_class_embed(self.guild_name), view=next_view)

    @discord.ui.button(
        label="Add all characters at once using text",
        style=discord.ButtonStyle.secondary,
        emoji="📝",
    )
    async def bulk_text(self, interaction: discord.Interaction, _button: discord.ui.Button) -> None:
        next_view = BulkTextHelpView(
            user_id=self.user_id,
            guild_id=self.guild_id,
            guild_name=self.guild_name,
            top_role=self.top_role,
        )
        next_view.message = interaction.message
        await interaction.response.edit_message(
            embed=_bulk_text_embed(self.guild_name), view=next_view
        )

    @discord.ui.button(
        label="Edit existing characters",
        style=discord.ButtonStyle.secondary,
        emoji="✏️",
    )
    async def edit_existing(
        self, interaction: discord.Interaction, _button: discord.ui.Button
    ) -> None:
        await interaction.response.defer()
        try:
            characters = await asyncio.get_running_loop().run_in_executor(
                None,
                fetch_editable_characters,
                self.guild_id,
                self.user_id,
            )
        except Exception:
            logger.exception(
                "Failed to load editable characters for user %s in guild %s",
                self.user_id,
                self.guild_id,
            )
            await interaction.followup.send(
                "❌ I couldn't load your characters. Please try again later."
            )
            return

        if not characters:
            await interaction.followup.send(
                "You don't have any characters to edit yet. Add one first."
            )
            return

        next_view = CharacterEditView(
            user_id=self.user_id,
            guild_id=self.guild_id,
            characters=characters,
        )
        next_view.message = interaction.message
        await interaction.edit_original_response(
            embed=build_edit_picker_embed(self.guild_name, len(characters)),
            view=next_view,
        )


class GuidedClassView(_OwnedView):
    def __init__(
        self,
        *,
        user_id: int,
        guild_id: int,
        guild_name: str,
        top_role: Optional[str],
    ):
        super().__init__(user_id)
        self.guild_id = guild_id
        self.guild_name = guild_name
        self.top_role = top_role
        self.add_item(_ClassSelect())

    @discord.ui.button(label="Back to methods", style=discord.ButtonStyle.secondary, emoji="⬅️")
    async def back_to_methods(
        self, interaction: discord.Interaction, _button: discord.ui.Button
    ) -> None:
        previous_view = DiscordMethodView(
            user_id=self.user_id,
            guild_id=self.guild_id,
            guild_name=self.guild_name,
            top_role=self.top_role,
        )
        previous_view.message = interaction.message
        await interaction.response.edit_message(
            embed=_method_embed(self.guild_name), view=previous_view
        )


class BulkTextHelpView(_OwnedView):
    def __init__(
        self,
        *,
        user_id: int,
        guild_id: int,
        guild_name: str,
        top_role: Optional[str],
    ):
        super().__init__(user_id)
        self.guild_id = guild_id
        self.guild_name = guild_name
        self.top_role = top_role

    @discord.ui.button(label="Back to methods", style=discord.ButtonStyle.secondary, emoji="⬅️")
    async def back_to_methods(
        self, interaction: discord.Interaction, _button: discord.ui.Button
    ) -> None:
        previous_view = DiscordMethodView(
            user_id=self.user_id,
            guild_id=self.guild_id,
            guild_name=self.guild_name,
            top_role=self.top_role,
        )
        previous_view.message = interaction.message
        await interaction.response.edit_message(
            embed=_method_embed(self.guild_name), view=previous_view
        )


class _SpecSelect(discord.ui.Select):
    def __init__(self, char_class: str):
        specs = WOW_CLASSES[char_class]["specs"]
        options = [discord.SelectOption(label=spec_name) for spec_name in specs]
        super().__init__(placeholder="Choose a specialization…", options=options)

    async def callback(self, interaction: discord.Interaction) -> None:
        view = self.view
        if not isinstance(view, GuidedSpecView):
            return
        await interaction.response.send_modal(
            CharacterDetailsModal(
                user_id=view.user_id,
                guild_id=view.guild_id,
                guild_name=view.guild_name,
                char_class=view.char_class,
                spec=self.values[0],
                top_role=view.top_role,
                source_message=interaction.message,
            )
        )


class GuidedSpecView(_OwnedView):
    def __init__(
        self,
        *,
        user_id: int,
        guild_id: int,
        guild_name: str,
        char_class: str,
        top_role: Optional[str],
    ):
        super().__init__(user_id)
        self.guild_id = guild_id
        self.guild_name = guild_name
        self.char_class = char_class
        self.top_role = top_role
        self.add_item(_SpecSelect(char_class))

    @discord.ui.button(label="Back to classes", style=discord.ButtonStyle.secondary, emoji="⬅️")
    async def back(self, interaction: discord.Interaction, _button: discord.ui.Button) -> None:
        previous_view = GuidedClassView(
            user_id=self.user_id,
            guild_id=self.guild_id,
            guild_name=self.guild_name,
            top_role=self.top_role,
        )
        previous_view.message = interaction.message
        await interaction.response.edit_message(
            embed=_class_embed(self.guild_name), view=previous_view
        )


class CharacterDetailsModal(discord.ui.Modal):
    def __init__(
        self,
        *,
        user_id: int,
        guild_id: int,
        guild_name: str,
        char_class: str,
        spec: str,
        top_role: Optional[str],
        source_message: discord.Message | None,
    ):
        super().__init__(title="Step 3 of 3 · Character details", timeout=600)
        self.user_id = user_id
        self.guild_id = guild_id
        self.guild_name = guild_name
        self.char_class = char_class
        self.spec = spec
        self.top_role = top_role
        self.source_message = source_message

        self.character_name = discord.ui.TextInput(
            label="Character name",
            placeholder="Letters only, e.g. Arthas",
            min_length=1,
            max_length=12,
        )
        self.realm = discord.ui.TextInput(
            label="Realm",
            default=REALMS[0],
            placeholder="e.g. Icecrown",
            max_length=50,
        )
        self.gearscore = discord.ui.TextInput(
            label="Gearscore",
            placeholder="e.g. 6200, 6.2k, or BiS",
            max_length=10,
        )
        self.add_item(self.character_name)
        self.add_item(self.realm)
        self.add_item(self.gearscore)

    async def on_submit(self, interaction: discord.Interaction) -> None:
        if interaction.user.id != self.user_id:
            await interaction.response.send_message(
                "This character guide belongs to someone else.", ephemeral=True
            )
            return

        try:
            name, realm, gearscore = validate_character_details(
                self.character_name.value,
                self.realm.value,
                self.gearscore.value,
            )
        except ValueError as exc:
            await interaction.response.send_message(f"❌ {exc}", ephemeral=True)
            return

        await interaction.response.defer(thinking=True)
        try:
            await asyncio.get_running_loop().run_in_executor(
                None,
                lambda: _upsert_guided_character(
                    guild_id=self.guild_id,
                    discord_user_id=self.user_id,
                    name=name,
                    realm=realm,
                    char_class=self.char_class,
                    spec=self.spec,
                    gearscore=gearscore,
                    top_role=self.top_role,
                ),
            )
        except Exception:
            logger.exception(
                "Failed to save guided character for user %s in guild %s",
                self.user_id,
                self.guild_id,
            )
            await interaction.followup.send(
                "❌ I couldn't save that character. Please try again later."
            )
            return

        if self.source_message is not None:
            try:
                await self.source_message.edit(
                    embed=discord.Embed(
                        title="✅ Details received",
                        description="Your character has been saved below.",
                        color=discord.Color.green(),
                    ),
                    view=None,
                )
            except (discord.HTTPException, discord.NotFound):
                pass

        embed = discord.Embed(
            title=f"✅ {name}-{realm} added!",
            description=(
                f"**Class:** {self.char_class}\n"
                f"**Spec:** {self.spec}\n"
                f"**Gearscore:** {format_gs(gearscore)}"
            ),
            color=discord.Color.green(),
        )
        embed.set_footer(text=f"Saved to {self.guild_name}")
        finish_view = GuidedFinishView(
            user_id=self.user_id,
            guild_id=self.guild_id,
            guild_name=self.guild_name,
            top_role=self.top_role,
        )
        message = await interaction.followup.send(embed=embed, view=finish_view, wait=True)
        finish_view.message = message


class GuidedFinishView(_OwnedView):
    def __init__(
        self,
        *,
        user_id: int,
        guild_id: int,
        guild_name: str,
        top_role: Optional[str],
    ):
        super().__init__(user_id)
        self.guild_id = guild_id
        self.guild_name = guild_name
        self.top_role = top_role

    @discord.ui.button(label="Add another", style=discord.ButtonStyle.primary, emoji="➕")
    async def add_another(
        self, interaction: discord.Interaction, _button: discord.ui.Button
    ) -> None:
        next_view = GuidedClassView(
            user_id=self.user_id,
            guild_id=self.guild_id,
            guild_name=self.guild_name,
            top_role=self.top_role,
        )
        next_view.message = interaction.message
        await interaction.response.edit_message(embed=_class_embed(self.guild_name), view=next_view)

    @discord.ui.button(label="I'm finished", style=discord.ButtonStyle.success, emoji="✅")
    async def finish(self, interaction: discord.Interaction, _button: discord.ui.Button) -> None:
        embed = discord.Embed(
            title="✅ You're all set!",
            description=(
                f"Your characters are ready for **{self.guild_name}** raid sign-ups. "
                "Use `/my_characters` in the server whenever you want to review them."
            ),
            color=discord.Color.green(),
        )
        await interaction.response.edit_message(embed=embed, view=None)
        self.stop()


class WebsiteLinkView(discord.ui.View):
    def __init__(self, url: str):
        super().__init__(timeout=600)
        self.add_item(
            discord.ui.Button(
                label="Open guided website form",
                style=discord.ButtonStyle.link,
                emoji="🌐",
                url=url,
            )
        )


class HelpNoobsChoiceView(discord.ui.View):
    """Reusable public launcher; each click starts a private flow for that member."""

    def __init__(self):
        super().__init__(timeout=None)

    @staticmethod
    async def _member_context(
        interaction: discord.Interaction,
    ) -> tuple[discord.Member, discord.Guild] | None:
        if interaction.guild is None or not isinstance(interaction.user, discord.Member):
            await interaction.response.send_message(
                "❌ This character guide must be opened from its server message.",
                ephemeral=True,
            )
            return None
        return interaction.user, interaction.guild

    @discord.ui.button(
        label="Guide me in Discord",
        style=discord.ButtonStyle.primary,
        emoji="💬",
        custom_id="helpnoobs:discord",
    )
    async def discord_guide(
        self, interaction: discord.Interaction, _button: discord.ui.Button
    ) -> None:
        context = await self._member_context(interaction)
        if context is None:
            return
        member, guild = context
        await interaction.response.defer(ephemeral=True, thinking=True)
        guide_view = DiscordMethodView(
            user_id=member.id,
            guild_id=guild.id,
            guild_name=guild.name,
            top_role=member.top_role.name if member.roles[1:] else None,
        )
        try:
            dm_message = await member.send(embed=_method_embed(guild.name), view=guide_view)
        except discord.Forbidden:
            await interaction.followup.send(
                "❌ I couldn't open a DM with you. Enable direct messages for this server, "
                "then press **Guide me in Discord** again.",
                ephemeral=True,
            )
            return
        except discord.HTTPException:
            logger.exception("Failed to open guided character DM for user %s", member.id)
            await interaction.followup.send(
                "❌ I couldn't open the character guide. Please try again.", ephemeral=True
            )
            return

        guide_view.message = dm_message
        await interaction.followup.send(
            "✅ I've opened the character guide in your DMs.", ephemeral=True
        )

    @discord.ui.button(
        label="Use the website",
        style=discord.ButtonStyle.secondary,
        emoji="🌐",
        custom_id="helpnoobs:website",
    )
    async def website_guide(
        self, interaction: discord.Interaction, _button: discord.ui.Button
    ) -> None:
        context = await self._member_context(interaction)
        if context is None:
            return
        _member, guild = context
        embed = discord.Embed(
            title="🌐 Continue on the website",
            description=(
                f"Open the private setup link below. After signing in with Discord, "
                f"you'll be guided through adding characters to **{guild.name}**."
            ),
            color=discord.Color.blurple(),
        )
        await interaction.response.send_message(
            embed=embed,
            view=WebsiteLinkView(build_character_guide_url(guild.id)),
            ephemeral=True,
        )
