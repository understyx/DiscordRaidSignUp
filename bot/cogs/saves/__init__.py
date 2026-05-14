from __future__ import annotations

from .helpers import (
    RAID_SAVE_INSTANCES,
    LOCKOUT_CANONICAL,
    _canonicalize_instance,
    _autocomplete_instance,
    _fetch_user_chars,
    _get_save_state,
    _set_save_state,
    _fetch_all_saves_for_user,
    _clear_all_saves,
)
from .cog import SavesCog


async def setup(bot):
    await bot.add_cog(SavesCog(bot))


__all__ = [
    "RAID_SAVE_INSTANCES",
    "LOCKOUT_CANONICAL",
    "_canonicalize_instance",
    "_autocomplete_instance",
    "_fetch_user_chars",
    "_get_save_state",
    "_set_save_state",
    "_fetch_all_saves_for_user",
    "_clear_all_saves",
    "SavesCog",
    "setup",
]
