-- Migration 006: Guild admin roles
-- Stores which Discord roles have raid-admin access on the website per guild.
-- If this table is empty for a guild, all logged-in users retain full access (backward-compatible).

CREATE TABLE IF NOT EXISTS guild_admin_roles (
    guild_id BIGINT NOT NULL,
    role_id  BIGINT NOT NULL,
    PRIMARY KEY (guild_id, role_id)
);
