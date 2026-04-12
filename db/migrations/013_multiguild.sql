-- Migration 013: Multi-guild support
-- Adds guild_id to raids so each raid is scoped to the Discord server it was created in.
-- Adds bot_guilds table so the web can discover which guilds the bot is present in.

ALTER TABLE raids ADD COLUMN guild_id BIGINT NULL DEFAULT NULL AFTER id;

CREATE INDEX idx_raids_guild_id ON raids (guild_id);

CREATE TABLE IF NOT EXISTS bot_guilds (
    guild_id   BIGINT       NOT NULL,
    guild_name VARCHAR(200) NOT NULL,
    icon       VARCHAR(200) NULL,
    PRIMARY KEY (guild_id)
);
