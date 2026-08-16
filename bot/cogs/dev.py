import discord
from discord import app_commands
from discord.ext import commands

from bot.cogs.raid import is_officer


class DevCog(commands.Cog):
    def __init__(self, bot: commands.Bot):
        self.bot = bot

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
