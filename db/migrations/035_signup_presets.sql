-- Migration 035: Add signup_presets table for saving user signup configurations
CREATE TABLE IF NOT EXISTS signup_presets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  discord_user_id BIGINT NOT NULL,
  guild_id BIGINT NOT NULL,
  name VARCHAR(100) NOT NULL,
  character_ids JSON NOT NULL,
  priority_ids JSON NOT NULL,
  notes JSON NOT NULL,
  created_at DATETIME(3) DEFAULT NOW(3),
  INDEX idx_user_guild (discord_user_id, guild_id)
);
