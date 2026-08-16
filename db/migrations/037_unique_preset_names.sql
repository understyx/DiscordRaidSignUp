-- Keep only the newest preset when duplicate names already exist.
DELETE older
FROM signup_presets older
JOIN signup_presets newer
  ON newer.discord_user_id = older.discord_user_id
  AND newer.guild_id = older.guild_id
  AND newer.name = older.name
  AND newer.id > older.id;

ALTER TABLE signup_presets
  ADD UNIQUE INDEX uq_signup_preset_owner_name (discord_user_id, guild_id, name);

DELETE older
FROM placeholder_presets older
JOIN placeholder_presets newer
  ON newer.guild_id <=> older.guild_id
  AND newer.name = older.name
  AND newer.id > older.id;

-- NULL guild IDs represent the shared/default scope. MySQL unique indexes allow
-- multiple NULL values, so normalize that scope to zero for uniqueness checks.
ALTER TABLE placeholder_presets
  ADD COLUMN guild_scope BIGINT GENERATED ALWAYS AS (COALESCE(guild_id, 0)) STORED,
  ADD UNIQUE INDEX uq_placeholder_preset_scope_name (guild_scope, name);
