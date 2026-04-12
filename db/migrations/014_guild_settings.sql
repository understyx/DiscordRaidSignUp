-- Migration 014: Guild settings
-- Adds guild_settings table to store per-guild configuration such as
-- signup restrictions.

CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id           BIGINT       NOT NULL,
    signup_restriction ENUM('all', 'guild_member', 'role') NOT NULL DEFAULT 'all',
    signup_role_id     BIGINT       NULL DEFAULT NULL,
    PRIMARY KEY (guild_id)
);
