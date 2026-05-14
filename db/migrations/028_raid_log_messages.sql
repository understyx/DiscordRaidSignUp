CREATE TABLE IF NOT EXISTS raid_log_messages (
  raid_id            INT NOT NULL,
  discord_user_id    BIGINT NOT NULL,
  discord_thread_id  BIGINT NOT NULL,
  discord_message_id BIGINT NOT NULL,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (raid_id, discord_user_id),
  CONSTRAINT fk_raid_log_messages_raid
    FOREIGN KEY (raid_id) REFERENCES raids(id) ON DELETE CASCADE
);
