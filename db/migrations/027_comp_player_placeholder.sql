-- Migration 027: support player placeholders in compositions
-- Allows assigning a player (Discord User) to a slot without choosing a specific character.

ALTER TABLE compositions
  ADD COLUMN discord_user_id VARCHAR(20) NULL AFTER placeholder_text;
