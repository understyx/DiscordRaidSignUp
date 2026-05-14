from __future__ import annotations

from .parser import parse_gs, format_gs
from .main_view import SignupView
from .cog import SignupCog
from .process import process_text_signup


async def setup(bot):
    await bot.add_cog(SignupCog(bot))


__all__ = [
    "parse_gs",
    "format_gs",
    "SignupView",
    "SignupCog",
    "process_text_signup",
    "setup",
]
