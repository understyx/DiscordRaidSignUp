from __future__ import annotations

from .cog import CharacterCog


async def setup(bot):
    await bot.add_cog(CharacterCog(bot))


__all__ = ["CharacterCog", "setup"]
