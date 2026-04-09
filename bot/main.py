import asyncio
import logging
import discord
from discord.ext import commands
from bot.config import BOT_TOKEN

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


class RaidBot(commands.Bot):
    def __init__(self):
        intents = discord.Intents.default()
        intents.message_content = True
        intents.guilds = True
        intents.members = True
        super().__init__(command_prefix="!", intents=intents)

    async def setup_hook(self):
        await self.load_extension("bot.cogs.character")
        await self.load_extension("bot.cogs.raid")
        await self.load_extension("bot.cogs.signup")
        await self.load_extension("bot.cogs.dev")

        # Register persistent SignupView so buttons survive bot restarts
        from bot.cogs.signup import SignupView
        self.add_view(SignupView())

        await self.tree.sync()
        logger.info("Slash commands synced.")

    async def on_ready(self):
        logger.info(f"Logged in as {self.user} (ID: {self.user.id})")
        await self.change_presence(
            activity=discord.Activity(
                type=discord.ActivityType.watching, name="raid sign-ups"
            )
        )


async def main():
    bot = RaidBot()
    async with bot:
        await bot.start(BOT_TOKEN)


if __name__ == "__main__":
    asyncio.run(main())
