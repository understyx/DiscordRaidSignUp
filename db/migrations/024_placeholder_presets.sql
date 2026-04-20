-- Migration 024: Add placeholder_presets table for saving roster placeholder layouts
CREATE TABLE IF NOT EXISTS placeholder_presets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  guild_id BIGINT,
  name VARCHAR(100) NOT NULL,
  slots JSON NOT NULL,
  created_by BIGINT,
  created_at DATETIME(3) DEFAULT NOW(3),
  INDEX idx_guild (guild_id)
);
