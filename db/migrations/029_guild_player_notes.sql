CREATE TABLE IF NOT EXISTS guild_player_notes (
    guild_id BIGINT NOT NULL,
    discord_user_id BIGINT NOT NULL,
    note TEXT NOT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (guild_id, discord_user_id)
);
