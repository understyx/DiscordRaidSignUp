from __future__ import annotations

import asyncio
import datetime
import logging
from typing import Optional

import discord
from discord import app_commands
from discord.ext import commands

from bot.db import get_session
from db.models import Character, CharacterRole

logger = logging.getLogger(__name__)

WOW_CLASS_COLORS = {
    "Death Knight": 0xC41E3A,
    "Druid": 0xFF7C0A,
    "Hunter": 0xAAD372,
    "Mage": 0x3FC7EB,
    "Paladin": 0xF48CBA,
    "Priest": 0xFFFFFF,
    "Rogue": 0xFFF468,
    "Shaman": 0x0070DD,
    "Warlock": 0x8788EE,
    "Warrior": 0xC69B3A,
}


def _get_class_color(char_class: Optional[str]) -> int:
    if not char_class:
        return 0x7289DA
    for cls, color in WOW_CLASS_COLORS.items():
        if cls.lower() in (char_class or "").lower():
            return color
    return 0x7289DA


def _fetch_armory_data(char_name: str, realm: str) -> dict:
    """Fetch class, spec, and gearscore from Warmane armory. Returns a dict."""
    from bot.warmane import (
        getHTML,
        check_for_error,
        extract_class_race_level_from_profile,
        extract_specializations_from_profile,
        extract_items_from_profile,
        clean_data,
    )
    # GS calculation requires DB items; we use a lightweight approach here:
    # just pull class/spec for now, skip GS if no DB available.
    profile_html = getHTML(char_name, realm, "summary")
    if profile_html is None or check_for_error(profile_html):
        return {}

    class_race_level = extract_class_race_level_from_profile(profile_html)
    # Extract class: last word after level number is typically "Class"
    # The string looks like "80 Troll Shaman" – take last token
    parts = [p.strip() for p in class_race_level.split() if p.strip()]
    char_class = parts[-1] if parts else None
    # Handle two-word classes
    if len(parts) >= 2 and f"{parts[-2]} {parts[-1]}" in WOW_CLASS_COLORS:
        char_class = f"{parts[-2]} {parts[-1]}"

    raw_specs = extract_specializations_from_profile(profile_html)
    spec = clean_data(raw_specs)

    return {
        "char_class": char_class,
        "spec": spec,
        "gearscore": 0.0,  # Full GS requires items DB; set to 0 without it
    }


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

    # ── /register_character ────────────────────────────────────────────────
    @app_commands.command(
        name="register_character",
        description="Register a WoW character from the Warmane armory.",
    )
    @app_commands.describe(name="Character name", realm="Realm name (default: Icecrown)")
    async def register_character(
        self,
        interaction: discord.Interaction,
        name: str,
        realm: str = "Icecrown",
    ):
        await interaction.response.defer(ephemeral=True, thinking=True)
        loop = asyncio.get_event_loop()

        armory_data = await loop.run_in_executor(None, _fetch_armory_data, name, realm)

        if not armory_data:
            await interaction.followup.send(
                f"❌ Could not find character **{name}** on **{realm}**. "
                "Check the name/realm and try again.",
                ephemeral=True,
            )
            return

        discord_user_id = interaction.user.id

        def _upsert():
            session = get_session()
            try:
                char = (
                    session.query(Character)
                    .filter_by(
                        discord_user_id=discord_user_id,
                        char_name=name.capitalize(),
                        realm=realm.capitalize(),
                    )
                    .first()
                )
                if char is None:
                    char = Character(
                        discord_user_id=discord_user_id,
                        char_name=name.capitalize(),
                        realm=realm.capitalize(),
                    )
                    session.add(char)

                char.char_class = armory_data.get("char_class")
                char.spec = armory_data.get("spec")
                char.gearscore = armory_data.get("gearscore", 0.0)
                char.last_updated = datetime.datetime.now(datetime.timezone.utc)
                session.commit()
                session.refresh(char)
                return char.id
            finally:
                session.close()

        char_id = await loop.run_in_executor(None, _upsert)

        embed = discord.Embed(
            title=f"✅ {name.capitalize()}-{realm.capitalize()} registered!",
            color=_get_class_color(armory_data.get("char_class")),
        )
        embed.add_field(name="Class", value=armory_data.get("char_class") or "Unknown", inline=True)
        embed.add_field(name="Spec", value=armory_data.get("spec") or "Unknown", inline=True)
        embed.set_footer(text="Now pick your role:")

        role_view = RoleSelectView(char_id)
        await interaction.followup.send(embed=embed, view=role_view, ephemeral=True)

    # ── /my_characters ─────────────────────────────────────────────────────
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
                "You have no registered characters. Use `/register_character` to add one.",
                ephemeral=True,
            )
            return

        embed = discord.Embed(
            title=f"Characters for {interaction.user.display_name}",
            color=discord.Color.blurple(),
        )
        for char in chars:
            role_str = char.role.value.capitalize() if char.role else "Not set"
            embed.add_field(
                name=f"{char.char_name} ({char.realm})",
                value=(
                    f"Class: {char.char_class or 'Unknown'}\n"
                    f"Spec: {char.spec or 'Unknown'}\n"
                    f"GS: {char.gearscore:.0f}\n"
                    f"Role: {role_str}"
                ),
                inline=True,
            )

        await interaction.followup.send(embed=embed, ephemeral=True)

    # ── /update_character ──────────────────────────────────────────────────
    @app_commands.command(
        name="update_character",
        description="Refresh armory data for one of your registered characters.",
    )
    @app_commands.describe(name="Character name to update")
    async def update_character(self, interaction: discord.Interaction, name: str):
        await interaction.response.defer(ephemeral=True, thinking=True)
        loop = asyncio.get_event_loop()
        discord_user_id = interaction.user.id

        def _find():
            session = get_session()
            try:
                return (
                    session.query(Character)
                    .filter(
                        Character.discord_user_id == discord_user_id,
                        Character.char_name.ilike(name),
                    )
                    .first()
                )
            finally:
                session.close()

        char = await loop.run_in_executor(None, _find)

        if not char:
            await interaction.followup.send(
                f"❌ No character named **{name}** found in your registered list.",
                ephemeral=True,
            )
            return

        armory_data = await loop.run_in_executor(
            None, _fetch_armory_data, char.char_name, char.realm
        )

        if not armory_data:
            await interaction.followup.send(
                f"❌ Could not fetch armory data for **{char.char_name}** on **{char.realm}**.",
                ephemeral=True,
            )
            return

        def _update():
            session = get_session()
            try:
                c = session.get(Character, char.id)
                if c:
                    c.char_class = armory_data.get("char_class")
                    c.spec = armory_data.get("spec")
                    c.gearscore = armory_data.get("gearscore", 0.0)
                    c.last_updated = datetime.datetime.now(datetime.timezone.utc)
                    session.commit()
            finally:
                session.close()

        await loop.run_in_executor(None, _update)

        embed = discord.Embed(
            title=f"🔄 {char.char_name}-{char.realm} updated!",
            color=_get_class_color(armory_data.get("char_class")),
        )
        embed.add_field(name="Class", value=armory_data.get("char_class") or "Unknown", inline=True)
        embed.add_field(name="Spec", value=armory_data.get("spec") or "Unknown", inline=True)
        await interaction.followup.send(embed=embed, ephemeral=True)


async def setup(bot: commands.Bot):
    await bot.add_cog(CharacterCog(bot))
