-- Migration 017: per-guild sequential raid numbers
-- Adds guild_raid_number to raids so each guild has its own 1-based counter
-- independent of the global auto-increment primary key.

ALTER TABLE raids ADD COLUMN guild_raid_number INT NOT NULL DEFAULT 0 AFTER guild_id;

-- Populate existing rows with sequential numbers per guild
-- (NULL guild_id raids are treated as their own group)
UPDATE raids r
JOIN (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY IFNULL(guild_id, 0) ORDER BY id) AS rn
  FROM raids
) ranked ON r.id = ranked.id
SET r.guild_raid_number = ranked.rn;

-- Index for fast (guild_id, guild_raid_number) lookups
CREATE INDEX idx_raids_guild_raid_num ON raids (guild_id, guild_raid_number);
