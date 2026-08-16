from __future__ import annotations

import asyncio
import logging
import random
import string

import discord
from discord import app_commands
from discord.ext import commands

from bot.cogs.raid import is_officer
from bot.db import get_session
from bot.wow import CLASS_SPEC_ROLES, REALMS, classes_and_specs
from db.models import Character, CharacterRole

logger = logging.getLogger(__name__)

_WOW_CLASSES = classes_and_specs()

_FAKE_USER_ID_MIN = 10**16
_FAKE_USER_ID_MAX = 10**18 - 1


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
        role = CharacterRole(CLASS_SPEC_ROLES.get((char_class, spec), "dps"))
        gearscore = round(random.uniform(4000.0, 6800.0), 0)
        realm = random.choice(REALMS)
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
            await interaction.followup.send(
                "This command can only be used in a server.", ephemeral=True
            )
            return

        emojis = interaction.guild.emojis
        if not emojis:
            await interaction.followup.send(
                "No custom emojis found in this server.", ephemeral=True
            )
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
