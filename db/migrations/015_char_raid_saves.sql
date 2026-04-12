-- Migration 015: per-character raid-save tracking
-- Stores whether a character is "saved" (locked out) to a raid instance.

CREATE TABLE IF NOT EXISTS char_raid_saves (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  character_id INT NOT NULL,
  instance_name VARCHAR(100) NOT NULL,
  is_saved     TINYINT(1) NOT NULL DEFAULT 1,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_char_save (character_id, instance_name),
  CONSTRAINT fk_char_save_char FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE
);
