-- Migration 029: recruitment Discord integration
-- Adds category tracking for recruitment to guild_settings
-- and channel tracking to recruitment_applications.

ALTER TABLE guild_settings ADD COLUMN recruitment_category_open_id   BIGINT UNSIGNED DEFAULT NULL;
ALTER TABLE guild_settings ADD COLUMN recruitment_category_closed_id BIGINT UNSIGNED DEFAULT NULL;

ALTER TABLE recruitment_applications ADD COLUMN discord_channel_id BIGINT UNSIGNED DEFAULT NULL;
