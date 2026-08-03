-- Migration 034: Guild custom embed
-- Adds columns to guild_settings for custom link embeds.

ALTER TABLE guild_settings
ADD COLUMN embed_title VARCHAR(255) NULL DEFAULT NULL,
ADD COLUMN embed_description VARCHAR(1024) NULL DEFAULT NULL,
ADD COLUMN embed_image_url VARCHAR(255) NULL DEFAULT NULL,
ADD COLUMN embed_color VARCHAR(7) NULL DEFAULT NULL;
