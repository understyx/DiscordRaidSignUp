from __future__ import annotations

import asyncio
import datetime
import logging
from typing import Optional

import discord
from discord import app_commands
from discord.ext import commands

from bot.db import get_session
from bot.class_utils import normalize_class
from bot.role_utils import get_role_from_spec
from bot.cogs.signup import parse_gs, format_gs
from bot.cogs.signup.parser import _parse_character_lines
from db.models import Character, CharacterSuggestion, SuggestionStatus

logger = logging.getLogger(__name__)


class AddCharactersModal(discord.ui.Modal, title="Add Characters"):
    characters = discord.ui.TextInput(
        label="Character Sign-up Lines",
        style=discord.TextStyle.paragraph,
        placeholder="CharName / Class / Spec / GS [/ Spec2 / GS2] — one character per line",
        required=True,
        max_length=2000,
    )

    async def on_submit(self, interaction: discord.Interaction):
        if not interaction.guild_id:
            await interaction.response.send_message("❌ This command can only be used in a server.", ephemeral=True)
            return

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

        def _upsert_all():
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

        try:
            char_spec_info = await loop.run_in_executor(None, _upsert_all)
        except Exception:
            logger.exception("Failed to save characters for user %s", discord_user_id)
            await interaction.followup.send(
                "❌ An error occurred while saving your character(s). Please try again later.",
                ephemeral=True,
            )
            return

        lines = []
        for data in char_spec_info.values():
            spec_parts = [
                f"{s['spec']} GS {format_gs(s['gearscore'])}" for s in data["specs"]
            ]
            lines.append(
                f"• **{data['char_name']}** ({data['char_class']}) – {' / '.join(spec_parts)}"
            )

        embed = discord.Embed(
            title="✅ Character(s) added!",
            description="\n".join(lines),
            color=discord.Color.green(),
        )
        embed.set_footer(text="Use /my_characters to see all your characters.")
        await interaction.followup.send(embed=embed, ephemeral=True)


class CharacterCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

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
        await interaction.response.defer(ephemeral=True, thinking=True)
        discord_user_id = interaction.user.id
        guild_id = interaction.guild_id
        loop = asyncio.get_event_loop()

        try:
            parsed_gs1 = parse_gs(gs1)
        except ValueError:
            await interaction.followup.send(f"❌ Invalid gearscore: `{gs1}`. Use a number like `6200`, `6.2k`, `6.2` (auto-scaled to 6200), or `BiS`.", ephemeral=True)
            return

        specs: list[tuple[str, float]] = [(spec1.strip(), parsed_gs1)]
        if spec2 and gs2 is not None:
            try:
                specs.append((spec2.strip(), parse_gs(gs2)))
            except ValueError:
                await interaction.followup.send(f"❌ Invalid gearscore for spec 2: `{gs2}`.", ephemeral=True)
                return
        if spec3 and gs3 is not None:
            try:
                specs.append((spec3.strip(), parse_gs(gs3)))
            except ValueError:
                await interaction.followup.send(f"❌ Invalid gearscore for spec 3: `{gs3}`.", ephemeral=True)
                return
        if spec4 and gs4 is not None:
            try:
                specs.append((spec4.strip(), parse_gs(gs4)))
            except ValueError:
                await interaction.followup.send(f"❌ Invalid gearscore for spec 4: `{gs4}`.", ephemeral=True)
                return
        if spec5 and gs5 is not None:
            try:
                specs.append((spec5.strip(), parse_gs(gs5)))
            except ValueError:
                await interaction.followup.send(f"❌ Invalid gearscore for spec 5: `{gs5}`.", ephemeral=True)
                return
        if spec6 and gs6 is not None:
            try:
                specs.append((spec6.strip(), parse_gs(gs6)))
            except ValueError:
                await interaction.followup.send(f"❌ Invalid gearscore for spec 6: `{gs6}`.", ephemeral=True)
                return

        def _upsert_all():
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

                session.commit()
                return saved_ids
            finally:
                session.close()

        char_ids = await loop.run_in_executor(None, _upsert_all)

        canonical_class = normalize_class(char_class)
        lines = [
            f"• **{spec}** – GS {gs:.0f}"
            for spec, gs in specs
        ]
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
                    await interaction.followup.send("❌ Amount must be between 0 and 50.", ephemeral=True)
                    return
            except ValueError:
                await interaction.followup.send("❌ Amount must be a number or 'remove'.", ephemeral=True)
                return

        def _update():
            session = get_session()
            try:
                chars = session.query(Character).filter_by(
                    guild_id=guild_id,
                    discord_user_id=discord_user_id,
                    char_name=name.capitalize(),
                    is_deleted=False
                ).all()

                if not chars:
                    return False, "Character not found."

                if chars[0].char_class not in valid_classes:
                    return False, f"❌ Shadowfrost Shards can only be tracked for: {', '.join(valid_classes)}."

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
                    await interaction.followup.send("❌ Amount must be between 0 and 30.", ephemeral=True)
                    return
            except ValueError:
                await interaction.followup.send("❌ Amount must be a number or 'remove'.", ephemeral=True)
                return

        def _update():
            session = get_session()
            try:
                chars = session.query(Character).filter_by(
                    guild_id=guild_id,
                    discord_user_id=discord_user_id,
                    char_name=name.capitalize(),
                    is_deleted=False
                ).all()

                if not chars:
                    return False, "Character not found."

                if chars[0].char_class not in valid_classes:
                    return False, f"❌ Fragments of Val'anyr can only be tracked for: {', '.join(valid_classes)}."

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

    @app_commands.command(
        name="edit_character",
        description="Update your character's name, class, realm, role, or gearscore.",
    )
    @app_commands.guild_only()
    @app_commands.describe(
        name="Current name of the character to edit",
        realm="Current realm of the character (optional if name is unique)",
        new_name="New name for the character",
        new_class="New WoW class",
        new_realm="New realm",
        new_role="New primary role (Tank, Healer, DPS)",
        new_gs="New gearscore (applied to ALL specs of this character)",
    )
    @app_commands.choices(
        new_role=[
            app_commands.Choice(name="Tank", value="tank"),
            app_commands.Choice(name="Healer", value="healer"),
            app_commands.Choice(name="DPS", value="dps"),
        ]
    )
    async def edit_character(
        self,
        interaction: discord.Interaction,
        name: str,
        realm: Optional[str] = None,
        new_name: Optional[str] = None,
        new_class: Optional[str] = None,
        new_realm: Optional[str] = None,
        new_role: Optional[str] = None,
        new_gs: Optional[str] = None,
        new_prof1: Optional[str] = None,
        new_prof2: Optional[str] = None,
    ):
        await interaction.response.defer(ephemeral=True, thinking=True)
        discord_user_id = interaction.user.id
        guild_id = interaction.guild_id
        loop = asyncio.get_event_loop()

        def _update():
            session = get_session()
            try:
                q = session.query(Character).filter_by(
                    guild_id=guild_id,
                    discord_user_id=discord_user_id,
                    char_name=name,
                    is_deleted=False,
                )
                if realm:
                    q = q.filter(Character.realm.ilike(realm))

                chars = q.all()
                if not chars:
                    return None, "Character not found."

                updates = []
                if new_name:
                    name_cap = new_name.capitalize()
                    for c in chars:
                        c.char_name = name_cap
                    updates.append(f"Name: **{name_cap}**")

                if new_class:
                    normalized = normalize_class(new_class)
                    for c in chars:
                        c.char_class = normalized
                    updates.append(f"Class: **{normalized}**")

                if new_realm:
                    realm_cap = new_realm.capitalize()
                    for c in chars:
                        c.realm = realm_cap
                    updates.append(f"Realm: **{realm_cap}**")

                if new_role:
                    for c in chars:
                        c.role = new_role
                    updates.append(f"Role: **{new_role.capitalize()}**")

                if new_gs:
                    try:
                        parsed_gs = parse_gs(new_gs)
                        for c in chars:
                            c.gearscore = parsed_gs
                        updates.append(f"GS: **{format_gs(parsed_gs)}** (applied to all specs)")
                    except ValueError:
                        return None, f"Invalid gearscore: `{new_gs}`"

                if new_prof1 is not None or new_prof2 is not None:
                    # Update both together if either is specified, but allow partial update
                    for c in chars:
                        if new_prof1 is not None:
                            c.prof_1 = new_prof1
                        if new_prof2 is not None:
                            c.prof_2 = new_prof2
                    updates.append("Professions updated")

                if updates:
                    for c in chars:
                        c.last_updated = datetime.datetime.now(datetime.timezone.utc)
                    session.commit()
                    return updates, None
                else:
                    return [], "No changes specified."
            finally:
                session.close()

        updates, error = await loop.run_in_executor(None, _update)

        if error:
            await interaction.followup.send(f"❌ {error}", ephemeral=True)
        elif updates:
            embed = discord.Embed(
                title=f"✅ Character Updated: {name}",
                description="\n".join(updates),
                color=discord.Color.green(),
            )
            await interaction.followup.send(embed=embed, ephemeral=True)
        else:
            await interaction.followup.send("ℹ️ No updates were performed.", ephemeral=True)

    @edit_character.autocomplete("name")
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
        description="List all your registered characters.",
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
                    .filter_by(
                        guild_id=guild_id, discord_user_id=discord_user_id, is_deleted=False
                    )
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
        for char in chars:
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

        await interaction.followup.send(embed=embed, ephemeral=True)

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
            await interaction.followup.send(f"✅ Suggestion for **{char_name}** has been **{action}**.", ephemeral=True)
            # Update the original message to remove buttons
            try:
                await interaction.edit_original_response(view=None)
            except discord.HTTPException:
                pass



