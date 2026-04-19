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
from bot.signup_parser import parse_gs, format_gs
from db.models import Character, CharacterRole

logger = logging.getLogger(__name__)

class RoleSelectView(discord.ui.View):
    def __init__(self, character_id: int):
        super().__init__(timeout=120)
        self.character_id = character_id

    @discord.ui.select(
        placeholder="Choose your role…",
        options=[
            discord.SelectOption(label="Tank", value="tank", emoji="🛡️"),
            discord.SelectOption(label="Healer", value="healer", emoji="💚"),
            discord.SelectOption(label="DPS", value="dps", emoji="⚔️"),
        ],
    )
    async def role_select(self, interaction: discord.Interaction, select: discord.ui.Select):
        role_value = select.values[0]
        loop = asyncio.get_event_loop()

        def _update():
            session = get_session()
            try:
                char = session.get(Character, self.character_id)
                if char:
                    char.role = CharacterRole(role_value)
                    session.commit()
            finally:
                session.close()

        await loop.run_in_executor(None, _update)
        await interaction.response.edit_message(
            content=f"✅ Role set to **{role_value.capitalize()}**!", view=None
        )


class CharacterCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    # ── /addcharacter ──────────────────────────────────────────────────────
    @app_commands.command(
        name="addcharacter",
        description="Manually add a character with spec and gearscore (no armory needed).",
    )
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
        realm: str = "Icecrown",
    ):
        await interaction.response.defer(ephemeral=True, thinking=True)
        discord_user_id = interaction.user.id
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
                            discord_user_id=discord_user_id,
                            char_name=name.capitalize(),
                            realm=realm.capitalize(),
                            spec=spec,
                        )
                        .first()
                    )
                    if char is None:
                        char = Character(
                            discord_user_id=discord_user_id,
                            char_name=name.capitalize(),
                            realm=realm.capitalize(),
                            spec=spec,
                        )
                        session.add(char)

                    char.gearscore = gs
                    char.char_class = normalize_class(char_class)
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

        # Offer role selection for the first (primary) spec
        role_view = RoleSelectView(char_ids[0])
        await interaction.followup.send(embed=embed, view=role_view, ephemeral=True)

    # ── /remove_character ──────────────────────────────────────────────────
    @app_commands.command(
        name="remove_character",
        description="Remove one of your registered characters.",
    )
    @app_commands.describe(
        name="Character name to remove",
        spec="Spec to remove (leave blank to remove all specs of this character)",
    )
    async def remove_character(
        self,
        interaction: discord.Interaction,
        name: str,
        spec: Optional[str] = None,
    ):
        await interaction.response.defer(ephemeral=True, thinking=True)
        discord_user_id = interaction.user.id
        loop = asyncio.get_event_loop()

        def _delete():
            session = get_session()
            try:
                q = session.query(Character).filter(
                    Character.discord_user_id == discord_user_id,
                    Character.char_name.ilike(name),
                )
                if spec:
                    q = q.filter(Character.spec.ilike(spec))
                chars = q.all()
                if not chars:
                    return 0
                for c in chars:
                    session.delete(c)
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


    @app_commands.command(
        name="my_characters",
        description="List all your registered characters.",
    )
    async def my_characters(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True, thinking=True)
        loop = asyncio.get_event_loop()
        discord_user_id = interaction.user.id

        def _fetch():
            session = get_session()
            try:
                return (
                    session.query(Character)
                    .filter_by(discord_user_id=discord_user_id)
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
                    f"Class: {char.char_class or 'Unknown'}\n"
                    f"GS: {format_gs(char.gearscore)}\n"
                    f"Role: {role_str}"
                ),
                inline=True,
            )

        await interaction.followup.send(embed=embed, ephemeral=True)


async def setup(bot: commands.Bot):
    await bot.add_cog(CharacterCog(bot))
