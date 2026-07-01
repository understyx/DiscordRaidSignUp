-- Migration 030: Multitenant scoping for characters and spec_aliases
-- Adds guild_id to characters and spec_aliases, and migrates existing data
-- by duplicating it for each known guild.

-- 1. Prepare spec_aliases
ALTER TABLE spec_aliases ADD COLUMN guild_id BIGINT NULL;
ALTER TABLE spec_aliases DROP INDEX uq_class_alias;

-- Duplicate spec_aliases for each guild
INSERT INTO spec_aliases (char_class, alias, canonical, guild_id)
SELECT sa.char_class, sa.alias, sa.canonical, bg.guild_id
FROM spec_aliases sa
CROSS JOIN bot_guilds bg
WHERE sa.guild_id IS NULL;

-- Remove original global aliases
DELETE FROM spec_aliases WHERE guild_id IS NULL;

ALTER TABLE spec_aliases MODIFY COLUMN guild_id BIGINT NOT NULL;
CREATE UNIQUE INDEX uq_guild_class_alias ON spec_aliases (guild_id, char_class, alias);


-- 2. Prepare characters
ALTER TABLE characters ADD COLUMN guild_id BIGINT NULL;
ALTER TABLE characters ADD COLUMN old_id INT NULL;

-- Duplicate characters for each guild
INSERT INTO characters (discord_user_id, char_name, realm, role, char_class, spec, gearscore, last_updated, is_deleted, guild_id, old_id)
SELECT c.discord_user_id, c.char_name, c.realm, c.role, c.char_class, c.spec, c.gearscore, c.last_updated, c.is_deleted, bg.guild_id, c.id
FROM characters c
CROSS JOIN bot_guilds bg
WHERE c.guild_id IS NULL;


-- 3. Update related tables to point to new character IDs
-- signups: match character by old_id and raid's guild_id
UPDATE signups s
JOIN raids r ON s.raid_id = r.id
JOIN characters c ON s.character_id = c.old_id AND r.guild_id = c.guild_id
SET s.character_id = c.id;

-- compositions: match character by old_id and raid's guild_id
UPDATE compositions comp
JOIN raids r ON comp.raid_id = r.id
JOIN characters c ON comp.character_id = c.old_id AND r.guild_id = c.guild_id
SET comp.character_id = c.id;

-- char_raid_saves: these were per-character, now they should be per-guild-character.
-- We need to duplicate them for each guild instance of the character.
CREATE TABLE tmp_char_raid_saves AS SELECT * FROM char_raid_saves;
TRUNCATE TABLE char_raid_saves;

INSERT INTO char_raid_saves (character_id, instance_name, is_saved, updated_at)
SELECT c.id, t.instance_name, t.is_saved, t.updated_at
FROM tmp_char_raid_saves t
JOIN characters c ON t.character_id = c.old_id;

DROP TABLE tmp_char_raid_saves;

-- character_suggestions: similarly, duplicate for each guild instance
CREATE TABLE tmp_character_suggestions AS SELECT * FROM character_suggestions;
TRUNCATE TABLE character_suggestions;

INSERT INTO character_suggestions (character_id, suggested_by, new_char_class, new_spec, new_gearscore, status, created_at, resolved_at)
SELECT c.id, t.suggested_by, t.new_char_class, t.new_spec, t.new_gearscore, t.status, t.created_at, t.resolved_at
FROM tmp_character_suggestions t
JOIN characters c ON t.character_id = c.old_id;

DROP TABLE tmp_character_suggestions;


-- 4. Cleanup characters
DELETE FROM characters WHERE guild_id IS NULL;
ALTER TABLE characters MODIFY COLUMN guild_id BIGINT NOT NULL;
ALTER TABLE characters DROP COLUMN old_id;
CREATE INDEX idx_char_guild_id ON characters (guild_id);
