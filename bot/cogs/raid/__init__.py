from __future__ import annotations

from .cog import (
    CreateRaidModal,
    EditRaidModal,
    RaidCog,
    _build_signup_embed,
    has_officer_access,
    is_officer,
)


async def setup(bot):
    await bot.add_cog(RaidCog(bot))


__all__ = [
    "is_officer",
    "has_officer_access",
    "_build_signup_embed",
    "CreateRaidModal",
    "EditRaidModal",
    "RaidCog",
    "setup",
]
