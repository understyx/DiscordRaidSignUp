-- Migration 026: Character Suggestions
-- Tracks suggested changes for characters from officers/dev.

CREATE TABLE IF NOT EXISTS character_suggestions (
    id                INT AUTO_INCREMENT PRIMARY KEY,
    character_id      INT NOT NULL,
    suggested_by      BIGINT NOT NULL, -- Discord user ID of the suggester
    new_char_class    VARCHAR(50) NULL,
    new_spec          VARCHAR(100) NULL,
    new_gearscore     FLOAT NULL,
    status            ENUM('pending', 'accepted', 'denied') DEFAULT 'pending',
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved_at       DATETIME NULL,

    FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE
);
