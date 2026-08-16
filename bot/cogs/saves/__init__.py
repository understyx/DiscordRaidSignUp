from __future__ import annotations

from .cog import SavesCog
from .helpers import (
    LOCKOUT_CANONICAL,
    RAID_SAVE_INSTANCES,
    _autocomplete_instance,
    _canonicalize_instance,
    _clear_all_saves,
    _fetch_all_saves_for_user,
    _fetch_user_chars,
    _get_save_state,
    _set_save_state,
)


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
