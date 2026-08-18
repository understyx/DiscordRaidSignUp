-- Migration 041: Guild Characters rank filter
-- Stores the Discord ranks that count as guild members on the shared officer roster.

CREATE TABLE IF NOT EXISTS guild_character_ranks (
    guild_id BIGINT NOT NULL,
    role_id  BIGINT NOT NULL,
    PRIMARY KEY (guild_id, role_id)
);
