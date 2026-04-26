from __future__ import annotations

import asyncio
import logging
import random
import string

import discord
from discord import app_commands
from discord.ext import commands

from bot.db import get_session
from bot.cogs.raid import is_officer
from db.models import Character, CharacterRole

logger = logging.getLogger(__name__)

_WOW_CLASSES = [
    ("Death Knight", ["Blood", "Frost", "Unholy"]),
    ("Druid", ["Balance", "Feral (Cat)", "Feral (Bear)", "Restoration"]),
    ("Hunter", ["Beast Mastery", "Marksmanship", "Survival"]),
    ("Mage", ["Arcane", "Fire", "Frost"]),
    ("Paladin", ["Holy", "Protection", "Retribution"]),
    ("Priest", ["Discipline", "Holy", "Shadow"]),
    ("Rogue", ["Assassination", "Combat", "Subtlety"]),
    ("Shaman", ["Elemental", "Enhancement", "Restoration"]),
    ("Warlock", ["Affliction", "Demonology", "Destruction"]),
    ("Warrior", ["Arms", "Fury", "Protection"]),
]

# Maps each (class, spec) pair to a role so shared spec names don't collide.
_CLASS_SPEC_ROLES: dict[tuple[str, str], CharacterRole] = {
    ("Death Knight", "Blood"): CharacterRole.tank,
    ("Death Knight", "Frost"): CharacterRole.dps,
    ("Death Knight", "Unholy"): CharacterRole.dps,
    ("Druid", "Balance"): CharacterRole.dps,
    ("Druid", "Feral (Cat)"): CharacterRole.dps,
    ("Druid", "Feral (Bear)"): CharacterRole.tank,
    ("Druid", "Restoration"): CharacterRole.healer,
    ("Hunter", "Beast Mastery"): CharacterRole.dps,
    ("Hunter", "Marksmanship"): CharacterRole.dps,
    ("Hunter", "Survival"): CharacterRole.dps,
    ("Mage", "Arcane"): CharacterRole.dps,
    ("Mage", "Fire"): CharacterRole.dps,
    ("Mage", "Frost"): CharacterRole.dps,
    ("Paladin", "Holy"): CharacterRole.healer,
    ("Paladin", "Protection"): CharacterRole.tank,
    ("Paladin", "Retribution"): CharacterRole.dps,
    ("Priest", "Discipline"): CharacterRole.healer,
    ("Priest", "Holy"): CharacterRole.healer,
    ("Priest", "Shadow"): CharacterRole.dps,
    ("Rogue", "Assassination"): CharacterRole.dps,
    ("Rogue", "Combat"): CharacterRole.dps,
    ("Rogue", "Subtlety"): CharacterRole.dps,
    ("Shaman", "Elemental"): CharacterRole.dps,
    ("Shaman", "Enhancement"): CharacterRole.dps,
    ("Shaman", "Restoration"): CharacterRole.healer,
    ("Warlock", "Affliction"): CharacterRole.dps,
    ("Warlock", "Demonology"): CharacterRole.dps,
    ("Warlock", "Destruction"): CharacterRole.dps,
    ("Warrior", "Arms"): CharacterRole.dps,
    ("Warrior", "Fury"): CharacterRole.dps,
    ("Warrior", "Protection"): CharacterRole.tank,
}

_REALMS = ["Icecrown", "Lordaeron", "Frostmourne"]

_FAKE_USER_ID_MIN = 10 ** 16
_FAKE_USER_ID_MAX = 10 ** 18 - 1


def _random_char_name(length: int) -> str:
    """Return a capitalised name of the given length using only letters."""
    first = random.choice(string.ascii_uppercase)
    rest = "".join(random.choices(string.ascii_lowercase, k=length - 1))
    return first + rest


def _generate_characters(discord_user_id: int, count: int) -> list[Character]:
    chars = []
    for _ in range(count):
        name_len = random.randint(5, 15)
        char_name = _random_char_name(name_len)
        char_class, specs = random.choice(_WOW_CLASSES)
        spec = random.choice(specs)
        role = _CLASS_SPEC_ROLES.get((char_class, spec), CharacterRole.dps)
        gearscore = round(random.uniform(4000.0, 6800.0), 0)
        realm = random.choice(_REALMS)
        chars.append(
            Character(
                discord_user_id=discord_user_id,
                char_name=char_name,
                realm=realm,
                char_class=char_class,
                spec=spec,
                role=role,
                gearscore=gearscore,
            )
        )
    return chars


class DevCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

    @app_commands.command(
        name="seed_fake_users",
        description="(Dev) Insert 25 fake Discord users with 2–10 random characters each.",
    )
    @is_officer()
    async def seed_fake_users(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True, thinking=True)
        loop = asyncio.get_event_loop()

        num_users = 25

        def _seed():
            session = get_session()
            try:
                total_chars = 0
                used_ids: set[int] = set()
                for _ in range(num_users):
                    # Generate a unique fake user ID
                    while True:
                        fake_id = random.randint(_FAKE_USER_ID_MIN, _FAKE_USER_ID_MAX)
                        if fake_id not in used_ids:
                            used_ids.add(fake_id)
                            break
                    char_count = random.randint(2, 10)
                    chars = _generate_characters(fake_id, char_count)
                    session.add_all(chars)
                    total_chars += char_count
                session.commit()
                return total_chars
            finally:
                session.close()

        total = await loop.run_in_executor(None, _seed)

        embed = discord.Embed(
            title="✅ Fake users seeded",
            description=(
                f"Created **{num_users}** fake Discord users "
                f"with a total of **{total}** characters."
            ),
            color=discord.Color.green(),
        )
        await interaction.followup.send(embed=embed, ephemeral=True)

    @app_commands.command(
        name="print_emojis",
        description="(Dev) Print all custom emojis in this server in their raw format.",
    )
    @is_officer()
    async def print_emojis(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True, thinking=True)

        if not interaction.guild:
            await interaction.followup.send("This command can only be used in a server.", ephemeral=True)
            return

        emojis = interaction.guild.emojis
        if not emojis:
            await interaction.followup.send("No custom emojis found in this server.", ephemeral=True)
            return

        # Format: <:name:id> or <a:name:id> for animated
        # Use backslash to escape so Discord prints the raw string format
        emoji_strings = [f"\\{e}" for e in emojis]

        # Split into chunks of 2000 characters (Discord limit)
        chunk = ""
        chunks = []
        for e_str in emoji_strings:
            if len(chunk) + len(e_str) + 1 > 2000:
                chunks.append(chunk)
                chunk = e_str
            else:
                chunk += " " + e_str if chunk else e_str

        if chunk:
            chunks.append(chunk)

        for c in chunks:
            await interaction.followup.send(c, ephemeral=True)


async def setup(bot: commands.Bot):
    await bot.add_cog(DevCog(bot))
