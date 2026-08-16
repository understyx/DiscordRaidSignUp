from __future__ import annotations

import asyncio
import datetime
import logging
from typing import Optional

import discord
from discord import app_commands
from discord.ext import commands

from bot.class_utils import normalize_class
from bot.cogs.raid import is_officer
from bot.cogs.signup import format_gs, parse_gs
from bot.cogs.signup.parser import _parse_character_lines
from bot.db import get_session
from bot.discord_utils import get_top_role_name
from bot.role_utils import get_role_from_spec
from db.models import Character, CharacterSuggestion, SuggestionStatus

from .edit_flow import CharacterEditView, fetch_editable_characters
from .helpnoobs import HelpNoobsChoiceView

logger = logging.getLogger(__name__)


def get_mutual_guilds(bot: commands.Bot, user_id: int) -> list[discord.Guild]:
    """Return all guilds where the bot is present AND the given user is a member."""
    return [guild for guild in bot.guilds if guild.get_member(user_id) is not None]


def _build_success_embed(
    char_spec_info: dict,
    guild_name: str | None = None,
) -> discord.Embed:
    """Build the success embed shown after characters are saved."""
    lines = []
    for data in char_spec_info.values():
        spec_parts = [f"{s['spec']} GS {format_gs(s['gearscore'])}" for s in data["specs"]]
        lines.append(f"• **{data['char_name']}** ({data['char_class']}) – {' / '.join(spec_parts)}")
    title = "✅ Character(s) added!"
    if guild_name:
        title += f" → {guild_name}"
    embed = discord.Embed(
        title=title,
        description="\n".join(lines),
        color=discord.Color.green(),
    )
    embed.set_footer(text="Use /my_characters to see all your characters.")
    return embed


def _upsert_parsed_characters(
    parsed: list[dict],
    guild_id: int,
    discord_user_id: int,
    top_role: Optional[str],
) -> dict[str, dict]:
    """Persist parsed character entries to DB. Returns char_spec_info dict."""
    session = get_session()
    try:
        char_spec_info: dict[str, dict] = {}
        for entry in parsed:
            char = (
                session.query(Character)
                .filter_by(
                    guild_id=guild_id,
                    discord_user_id=discord_user_id,
                    char_name=entry["char_name"],
                    spec=entry["spec"],
                )
                .first()
            )
            if char is None:
                char = Character(
                    guild_id=guild_id,
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
            guild_id=guild_id,
            discord_user_id=discord_user_id,
        ).update(
            {
                "discord_role": top_role,
                "membership_status": "active",
                "last_updated": datetime.datetime.now(datetime.timezone.utc),
            }
        )

        for entry in parsed:
            key = entry["char_name"].lower()
            if key not in char_spec_info:
                char_spec_info[key] = {
                    "char_name": entry["char_name"],
                    "char_class": entry["char_class"],
                    "specs": [],
                }
            char_spec_info[key]["specs"].append(
                {"spec": entry["spec"], "gearscore": entry["gearscore"]}
            )

        session.commit()
        return char_spec_info
    finally:
        session.close()


class GuildButton(discord.ui.Button):
    """A button representing one guild for the DM guild-picker flow."""

    def __init__(
        self,
        guild: discord.Guild,
        parsed: list[dict],
        discord_user_id: int,
        top_role: Optional[str],
    ):
        super().__init__(
            label=guild.name,
            style=discord.ButtonStyle.primary,
            emoji="🏰",
        )
        self.guild = guild
        self.parsed = parsed
        self.discord_user_id = discord_user_id
        self.top_role = top_role

    async def callback(self, interaction: discord.Interaction) -> None:
        # Disable all buttons immediately to prevent double-clicks
        for item in self.view.children:
            item.disabled = True
        await interaction.response.defer()

        loop = asyncio.get_event_loop()
        try:
            char_spec_info = await loop.run_in_executor(
                None,
                _upsert_parsed_characters,
                self.parsed,
                self.guild.id,
                self.discord_user_id,
                self.top_role,
            )
        except Exception:
            logger.exception(
                "Failed to save characters for user %s in guild %s",
                self.discord_user_id,
                self.guild.id,
            )
            await interaction.edit_original_response(
                content="❌ An error occurred while saving your character(s). Please try again later.",
                embed=None,
                view=None,
            )
            return

        embed = _build_success_embed(char_spec_info, guild_name=self.guild.name)
        await interaction.edit_original_response(content=None, embed=embed, view=None)


class GuildPickerView(discord.ui.View):
    """Shown in DMs when the user belongs to multiple bot-managed guilds."""

    def __init__(
        self,
        guilds: list[discord.Guild],
        parsed: list[dict],
        discord_user_id: int,
        top_role: Optional[str],
    ):
        super().__init__(timeout=120)
        for guild in guilds[:25]:  # Discord hard-cap: 25 components per message
            self.add_item(
                GuildButton(
                    guild=guild,
                    parsed=parsed,
                    discord_user_id=discord_user_id,
                    top_role=top_role,
                )
            )

    async def on_timeout(self) -> None:
        # Disable all buttons when the view times out
        for item in self.children:
            item.disabled = True


class AddCharactersModal(discord.ui.Modal, title="Add Characters"):
    characters = discord.ui.TextInput(
        label="Character Sign-up Lines",
        style=discord.TextStyle.paragraph,
        placeholder="CharName / Class / Spec / GS [/ Spec2 / GS2] — one character per line",
        required=True,
        max_length=2000,
    )

    async def on_submit(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True, thinking=True)
        discord_user_id = interaction.user.id
        guild_id = interaction.guild_id
        loop = asyncio.get_event_loop()

        parsed, parse_errors = _parse_character_lines(self.characters.value)

        if parse_errors or not parsed:
            if not parse_errors:
                parse_errors.append(
                    "No valid character lines found. "
                    "Expected format: `CharName / Class / Spec / GS`"
                )
            error_text = "❌ Failed to parse character(s):\n" + "\n".join(parse_errors)
            await interaction.followup.send(error_text, ephemeral=True)
            return

        top_role = (
            get_top_role_name(interaction.user)
            if isinstance(interaction.user, discord.Member)
            else None
        )

        # ── DM context: no guild_id on the interaction ─────────────────────
        if guild_id is None:
            # We need the bot instance; walk up through the cog if available,
            # otherwise fall back via the client stored on the interaction.
            bot = interaction.client
            mutual_guilds = get_mutual_guilds(bot, discord_user_id)

            if not mutual_guilds:
                await interaction.followup.send(
                    "❌ You don't appear to be a member of any server managed by this bot. "
                    "Please join a server first, then try again.",
                    ephemeral=True,
                )
                return

            if len(mutual_guilds) == 1:
                # Auto-pick the only guild — no prompt needed
                guild_id = mutual_guilds[0].id
                # Fall through to the normal save path below
            else:
                # Multiple guilds: show picker embed with buttons
                embed = discord.Embed(
                    title="🏰 Which server should these characters be added to?",
                    description=(
                        "You're adding characters via DM. "
                        "Pick the server you'd like to associate them with:"
                    ),
                    color=discord.Color.blurple(),
                )
                embed.set_footer(text="This prompt expires in 2 minutes.")
                view = GuildPickerView(
                    guilds=mutual_guilds,
                    parsed=parsed,
                    discord_user_id=discord_user_id,
                    top_role=top_role,
                )
                await interaction.followup.send(embed=embed, view=view, ephemeral=True)
                return
        # ── End DM branch ───────────────────────────────────────────────────

        try:
            char_spec_info = await loop.run_in_executor(
                None,
                _upsert_parsed_characters,
                parsed,
                guild_id,
                discord_user_id,
                top_role,
            )
        except Exception:
            logger.exception("Failed to save characters for user %s", discord_user_id)
            await interaction.followup.send(
                "❌ An error occurred while saving your character(s). Please try again later.",
                ephemeral=True,
            )
            return

        embed = _build_success_embed(char_spec_info)
        try:
            editable_characters = await loop.run_in_executor(
                None,
                fetch_editable_characters,
                guild_id,
                discord_user_id,
            )
        except Exception:
            logger.exception(
                "Failed to load character editor for user %s in guild %s",
                discord_user_id,
                guild_id,
            )
            editable_characters = []

        view = None
        if editable_characters:
            view = CharacterEditView(
                user_id=discord_user_id,
                guild_id=guild_id,
                characters=editable_characters,
            )
            embed.set_footer(text="Choose a character below to edit it.")

        message = await interaction.followup.send(
            embed=embed,
            view=view,
            ephemeral=True,
            wait=True,
        )
        if view is not None:
            view.message = message


class CharacterCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    # ── /helpnoobs ────────────────────────────────────────────────────────
    @app_commands.command(
        name="helpnoobs",
        description="Post the guided character management launcher (Officer only).",
    )
    @app_commands.guild_only()
    @is_officer()
    async def helpnoobs(self, interaction: discord.Interaction):
        embed = discord.Embed(
            title="👋 Need help managing your characters?",
            description=(
                "Choose where you'd like to add or edit them. Your answers will stay private.\n\n"
                "💬 **Discord** — use a guided flow in a DM with me\n"
                "🌐 **Website** — manage them in your browser"
            ),
            color=discord.Color.blurple(),
        )
        embed.set_footer(text="Anyone in this server can use these buttons.")
        await interaction.response.send_message(embed=embed, view=HelpNoobsChoiceView())

    @helpnoobs.error
    async def helpnoobs_error(
        self, interaction: discord.Interaction, error: app_commands.AppCommandError
    ) -> None:
        if isinstance(error, app_commands.CheckFailure):
            await interaction.response.send_message(
                "❌ You do not have permission to post the character setup guide.",
                ephemeral=True,
            )
            return
        raise error

    # ── /addcharacters ─────────────────────────────────────────────────────
    @app_commands.command(
        name="addcharacters",
        description="Add one or more characters via a text form.",
    )
    async def addcharacters(self, interaction: discord.Interaction):
        await interaction.response.send_modal(AddCharactersModal())

    # ── /addcharacter ──────────────────────────────────────────────────────
    @app_commands.command(
        name="addcharacter",
        description="Manually add a character with spec and gearscore (no armory needed).",
    )
    @app_commands.guild_only()
    @app_commands.describe(
        name="Character name",
        char_class="WoW class (e.g. Death Knight, Druid, Paladin…)",
        spec1="First (or only) spec",
        gs1="Gearscore for spec 1",
        spec2="Second spec (optional)",
        gs2="Gearscore for spec 2 (optional)",
        spec3="Third spec (optional)",
        gs3="Gearscore for spec 3 (optional)",
        spec4="Fourth spec (optional)",
        gs4="Gearscore for spec 4 (optional)",
        spec5="Fifth spec (optional)",
        gs5="Gearscore for spec 5 (optional)",
        spec6="Sixth spec (optional)",
        gs6="Gearscore for spec 6 (optional)",
        realm="Realm name (default: Icecrown)",
    )
    async def addcharacter(
        self,
        interaction: discord.Interaction,
        name: str,
        char_class: str,
        spec1: str,
        gs1: str,
        spec2: Optional[str] = None,
        gs2: Optional[str] = None,
        spec3: Optional[str] = None,
        gs3: Optional[str] = None,
        spec4: Optional[str] = None,
        gs4: Optional[str] = None,
        spec5: Optional[str] = None,
        gs5: Optional[str] = None,
        spec6: Optional[str] = None,
        gs6: Optional[str] = None,
        prof1: Optional[str] = None,
        prof2: Optional[str] = None,
        realm: str = "Icecrown",
    ):
        if not interaction.guild_id:
            await interaction.response.send_message(
                "❌ This command can only be used inside a server.", ephemeral=True
            )
            return

        await interaction.response.defer(ephemeral=True, thinking=True)
        discord_user_id = interaction.user.id
        guild_id = interaction.guild_id
        loop = asyncio.get_event_loop()

        try:
            parsed_gs1 = parse_gs(gs1)
        except ValueError:
            await interaction.followup.send(
                f"❌ Invalid gearscore: `{gs1}`. Use a number like `6200`, `6.2k`, `6.2` (auto-scaled to 6200), or `BiS`.",
                ephemeral=True,
            )
            return

        specs: list[tuple[str, float]] = [(spec1.strip(), parsed_gs1)]
        if spec2 and gs2 is not None:
            try:
                specs.append((spec2.strip(), parse_gs(gs2)))
            except ValueError:
                await interaction.followup.send(
                    f"❌ Invalid gearscore for spec 2: `{gs2}`.", ephemeral=True
                )
                return
        if spec3 and gs3 is not None:
            try:
                specs.append((spec3.strip(), parse_gs(gs3)))
            except ValueError:
                await interaction.followup.send(
                    f"❌ Invalid gearscore for spec 3: `{gs3}`.", ephemeral=True
                )
                return
        if spec4 and gs4 is not None:
            try:
                specs.append((spec4.strip(), parse_gs(gs4)))
            except ValueError:
                await interaction.followup.send(
                    f"❌ Invalid gearscore for spec 4: `{gs4}`.", ephemeral=True
                )
                return
        if spec5 and gs5 is not None:
            try:
                specs.append((spec5.strip(), parse_gs(gs5)))
            except ValueError:
                await interaction.followup.send(
                    f"❌ Invalid gearscore for spec 5: `{gs5}`.", ephemeral=True
                )
                return
        if spec6 and gs6 is not None:
            try:
                specs.append((spec6.strip(), parse_gs(gs6)))
            except ValueError:
                await interaction.followup.send(
                    f"❌ Invalid gearscore for spec 6: `{gs6}`.", ephemeral=True
                )
                return

        def _upsert_all(top_role: Optional[str]):
            session = get_session()
            try:
                saved_ids = []
                for spec, gs in specs:
                    char = (
                        session.query(Character)
                        .filter_by(
                            guild_id=guild_id,
                            discord_user_id=discord_user_id,
                            char_name=name.capitalize(),
                            realm=realm.capitalize(),
                            spec=spec,
                        )
                        .first()
                    )
                    if char is None:
                        char = Character(
                            guild_id=guild_id,
                            discord_user_id=discord_user_id,
                            char_name=name.capitalize(),
                            realm=realm.capitalize(),
                            spec=spec,
                        )
                        session.add(char)

                    char.gearscore = gs
                    canonical_class = normalize_class(char_class)
                    char.char_class = canonical_class
                    char.role = get_role_from_spec(canonical_class, spec)
                    char.prof_1 = prof1
                    char.prof_2 = prof2
                    char.is_deleted = False
                    char.last_updated = datetime.datetime.now(datetime.timezone.utc)
                    session.flush()
                    saved_ids.append(char.id)

                # Update ALL characters for this user in this guild with the latest Discord info
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
                return saved_ids
            finally:
                session.close()

        top_role = (
            get_top_role_name(interaction.user)
            if isinstance(interaction.user, discord.Member)
            else None
        )
        await loop.run_in_executor(None, _upsert_all, top_role)

        canonical_class = normalize_class(char_class)
        lines = [f"• **{spec}** – GS {gs:.0f}" for spec, gs in specs]
        embed = discord.Embed(
            title=f"✅ {name.capitalize()}-{realm.capitalize()} added!",
            description=f"**Class:** {canonical_class}\n" + "\n".join(lines),
            color=discord.Color.green(),
        )
        embed.set_footer(text="Use /my_characters to see all your characters.")

        await interaction.followup.send(embed=embed, ephemeral=True)

    @app_commands.command(
        name="shard_sfs",
        description="Set Shadowfrost Shard count for a character.",
    )
    @app_commands.guild_only()
    @app_commands.describe(
        name="Character name",
        amount="Shard count (0-50) or 'remove' to stop tracking",
    )
    async def shard_sfs(
        self,
        interaction: discord.Interaction,
        name: str,
        amount: str,
    ):
        await interaction.response.defer(ephemeral=True, thinking=True)
        guild_id = interaction.guild_id
        discord_user_id = interaction.user.id

        valid_classes = {"Paladin", "Death Knight", "Warrior"}

        count = None
        if amount.lower() != "remove":
            try:
                count = int(amount)
                if not (0 <= count <= 50):
                    await interaction.followup.send(
                        "❌ Amount must be between 0 and 50.", ephemeral=True
                    )
                    return
            except ValueError:
                await interaction.followup.send(
                    "❌ Amount must be a number or 'remove'.", ephemeral=True
                )
                return

        def _update():
            session = get_session()
            try:
                chars = (
                    session.query(Character)
                    .filter_by(
                        guild_id=guild_id,
                        discord_user_id=discord_user_id,
                        char_name=name.capitalize(),
                        is_deleted=False,
                    )
                    .all()
                )

                if not chars:
                    return False, "Character not found."

                if chars[0].char_class not in valid_classes:
                    return (
                        False,
                        f"❌ Shadowfrost Shards can only be tracked for: {', '.join(valid_classes)}.",
                    )

                for c in chars:
                    c.sfs_count = count
                    c.last_updated = datetime.datetime.now(datetime.timezone.utc)

                session.commit()
                return True, None
            finally:
                session.close()

        success, error = await asyncio.get_event_loop().run_in_executor(None, _update)
        if not success:
            await interaction.followup.send(error, ephemeral=True)
        else:
            msg = f"✅ Shadowfrost Shards for **{name.capitalize()}** set to **{count if count is not None else 'None'}**."
            await interaction.followup.send(msg, ephemeral=True)

    @app_commands.command(
        name="shard_val",
        description="Set Fragments of Val'anyr count for a character.",
    )
    @app_commands.guild_only()
    @app_commands.describe(
        name="Character name",
        amount="Fragment count (0-30) or 'remove' to stop tracking",
    )
    async def shard_val(
        self,
        interaction: discord.Interaction,
        name: str,
        amount: str,
    ):
        await interaction.response.defer(ephemeral=True, thinking=True)
        guild_id = interaction.guild_id
        discord_user_id = interaction.user.id

        valid_classes = {"Paladin", "Priest", "Druid", "Shaman"}

        count = None
        if amount.lower() != "remove":
            try:
                count = int(amount)
                if not (0 <= count <= 30):
                    await interaction.followup.send(
                        "❌ Amount must be between 0 and 30.", ephemeral=True
                    )
                    return
            except ValueError:
                await interaction.followup.send(
                    "❌ Amount must be a number or 'remove'.", ephemeral=True
                )
                return

        def _update():
            session = get_session()
            try:
                chars = (
                    session.query(Character)
                    .filter_by(
                        guild_id=guild_id,
                        discord_user_id=discord_user_id,
                        char_name=name.capitalize(),
                        is_deleted=False,
                    )
                    .all()
                )

                if not chars:
                    return False, "Character not found."

                if chars[0].char_class not in valid_classes:
                    return (
                        False,
                        f"❌ Fragments of Val'anyr can only be tracked for: {', '.join(valid_classes)}.",
                    )

                for c in chars:
                    c.val_count = count
                    c.last_updated = datetime.datetime.now(datetime.timezone.utc)

                session.commit()
                return True, None
            finally:
                session.close()

        success, error = await asyncio.get_event_loop().run_in_executor(None, _update)
        if not success:
            await interaction.followup.send(error, ephemeral=True)
        else:
            msg = f"✅ Fragments of Val'anyr for **{name.capitalize()}** set to **{count if count is not None else 'None'}**."
            await interaction.followup.send(msg, ephemeral=True)

    @shard_sfs.autocomplete("name")
    @shard_val.autocomplete("name")
    async def shard_name_autocomplete(
        self, interaction: discord.Interaction, current: str
    ) -> list[app_commands.Choice[str]]:
        return await self.character_name_autocomplete(interaction, current)

    async def character_name_autocomplete(
        self, interaction: discord.Interaction, current: str
    ) -> list[app_commands.Choice[str]]:
        guild_id = interaction.guild_id
        discord_user_id = interaction.user.id
        if not guild_id:
            return []

        def _fetch():
            session = get_session()
            try:
                # Get unique character names for this user in this guild
                chars = (
                    session.query(Character.char_name)
                    .filter_by(
                        guild_id=guild_id,
                        discord_user_id=discord_user_id,
                        is_deleted=False,
                    )
                    .distinct()
                    .all()
                )
                return [c[0] for c in chars]
            finally:
                session.close()

        loop = asyncio.get_event_loop()
        try:
            names = await loop.run_in_executor(None, _fetch)
        except Exception:
            return []

        return [
            app_commands.Choice(name=name, value=name)
            for name in names
            if current.lower() in name.lower()
        ][:25]

    # ── /remove_character ──────────────────────────────────────────────────
    @app_commands.command(
        name="remove_character",
        description="Remove one of your registered characters.",
    )
    @app_commands.guild_only()
    @app_commands.describe(
        name="Character name to remove",
        realm="Realm name (optional if name is unique)",
        spec="Spec to remove (leave blank to remove all specs of this character)",
    )
    async def remove_character(
        self,
        interaction: discord.Interaction,
        name: str,
        realm: Optional[str] = None,
        spec: Optional[str] = None,
    ):
        await interaction.response.defer(ephemeral=True, thinking=True)
        discord_user_id = interaction.user.id
        guild_id = interaction.guild_id
        loop = asyncio.get_event_loop()

        def _delete():
            session = get_session()
            try:
                q = session.query(Character).filter(
                    Character.guild_id == guild_id,
                    Character.discord_user_id == discord_user_id,
                    Character.char_name.ilike(name),
                    Character.is_deleted == False,  # noqa: E712
                )
                if realm:
                    q = q.filter(Character.realm.ilike(realm))
                if spec:
                    q = q.filter(Character.spec.ilike(spec))
                chars = q.all()
                if not chars:
                    return 0
                for c in chars:
                    c.is_deleted = True
                session.commit()
                return len(chars)
            finally:
                session.close()

        removed = await loop.run_in_executor(None, _delete)

        if removed == 0:
            await interaction.followup.send(
                f"❌ No character named **{name}**"
                + (f" ({spec})" if spec else "")
                + " found in your registered list.",
                ephemeral=True,
            )
        else:
            await interaction.followup.send(
                f"🗑️ Removed **{removed}** entry/entries for **{name.capitalize()}**.",
                ephemeral=True,
            )

    @remove_character.autocomplete("name")
    async def remove_character_name_autocomplete(
        self, interaction: discord.Interaction, current: str
    ) -> list[app_commands.Choice[str]]:
        return await self.character_name_autocomplete(interaction, current)

    @app_commands.command(
        name="my_characters",
        description="View and edit your registered characters.",
    )
    @app_commands.guild_only()
    async def my_characters(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True, thinking=True)
        loop = asyncio.get_event_loop()
        discord_user_id = interaction.user.id
        guild_id = interaction.guild_id

        def _fetch():
            session = get_session()
            try:
                return (
                    session.query(Character)
                    .filter_by(guild_id=guild_id, discord_user_id=discord_user_id, is_deleted=False)
                    .all()
                )
            finally:
                session.close()

        chars = await loop.run_in_executor(None, _fetch)

        if not chars:
            await interaction.followup.send(
                "You have no registered characters. Use `/addcharacter` to add one.",
                ephemeral=True,
            )
            return

        embed = discord.Embed(
            title=f"Characters for {interaction.user.display_name}",
            color=discord.Color.blurple(),
        )
        if len(chars) > 25:
            embed.description = f"Showing the first 25 of {len(chars)} character entries."
        for char in chars[:25]:
            role_str = char.role.value.capitalize() if char.role else "Not set"
            field_name = f"{char.char_name} ({char.realm})"
            if char.spec:
                field_name += f" – {char.spec}"
            embed.add_field(
                name=field_name,
                value=(
                    f"**Class:** {char.char_class or 'Unknown'}\n"
                    f"**GS:** {format_gs(char.gearscore)}\n"
                    f"**Role:** {role_str}\n"
                    f"**Realm:** {char.realm}"
                ),
                inline=True,
            )

        try:
            editable_characters = await loop.run_in_executor(
                None,
                fetch_editable_characters,
                guild_id,
                discord_user_id,
            )
        except Exception:
            logger.exception(
                "Failed to load character editor for user %s in guild %s",
                discord_user_id,
                guild_id,
            )
            editable_characters = []

        view = None
        if editable_characters:
            view = CharacterEditView(
                user_id=discord_user_id,
                guild_id=guild_id,
                characters=editable_characters,
            )
            embed.set_footer(text="Choose a character below to edit it.")

        message = await interaction.followup.send(
            embed=embed,
            view=view,
            ephemeral=True,
            wait=True,
        )
        if view is not None:
            view.message = message

    @commands.Cog.listener()
    async def on_interaction(self, interaction: discord.Interaction):
        if interaction.type != discord.InteractionType.component:
            return

        custom_id = interaction.data.get("custom_id", "")
        if not (custom_id.startswith("suggest_accept_") or custom_id.startswith("suggest_deny_")):
            return

        await interaction.response.defer(ephemeral=True)

        action = "accepted" if custom_id.startswith("suggest_accept_") else "denied"
        try:
            suggestion_id = int(custom_id.split("_")[-1])
        except (ValueError, IndexError):
            await interaction.followup.send("❌ Invalid suggestion ID.", ephemeral=True)
            return

        loop = asyncio.get_event_loop()

        def _process():
            session = get_session()
            try:
                suggestion = session.get(CharacterSuggestion, suggestion_id)
                if not suggestion or suggestion.status != SuggestionStatus.pending:
                    return None, "This suggestion is no longer valid or already processed."

                char = session.get(Character, suggestion.character_id)
                if not char:
                    return None, "Character not found."

                if action == "accepted":
                    if suggestion.new_char_class:
                        char.char_class = suggestion.new_char_class
                    if suggestion.new_spec:
                        char.spec = suggestion.new_spec
                    if suggestion.new_gearscore is not None:
                        char.gearscore = suggestion.new_gearscore

                    char.last_updated = datetime.datetime.now(datetime.timezone.utc)
                    suggestion.status = SuggestionStatus.accepted
                else:
                    suggestion.status = SuggestionStatus.denied

                suggestion.resolved_at = datetime.datetime.now(datetime.timezone.utc)
                session.commit()
                return char.char_name, None
            finally:
                session.close()

        char_name, error = await loop.run_in_executor(None, _process)

        if error:
            await interaction.followup.send(f"❌ {error}", ephemeral=True)
        else:
            await interaction.followup.send(
                f"✅ Suggestion for **{char_name}** has been **{action}**.", ephemeral=True
            )
            # Update the original message to remove buttons
            try:
                await interaction.edit_original_response(view=None)
            except discord.HTTPException:
                pass
