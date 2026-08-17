from __future__ import annotations

import datetime

import discord


def utc_timestamp(value: datetime.datetime) -> int:
    """Return a Discord timestamp, treating database-naive raid dates as UTC."""
    if value.tzinfo is None:
        value = value.replace(tzinfo=datetime.timezone.utc)
    return int(value.timestamp())


def get_top_role_name(member: discord.Member) -> str | None:
    """Return the name of the highest role for a member, excluding @everyone."""
    # roles are sorted by position, lowest first. @everyone is at index 0.
    roles = member.roles[1:]  # exclude @everyone
    if not roles:
        return None

    # Highest position role is last
    return roles[-1].name
