from __future__ import annotations

from .cog import is_officer, _build_signup_embed, CreateRaidModal, RaidCog


async def setup(bot):
    await bot.add_cog(RaidCog(bot))


__all__ = [
    "is_officer",
    "_build_signup_embed",
    "CreateRaidModal",
    "RaidCog",
    "setup",
]
