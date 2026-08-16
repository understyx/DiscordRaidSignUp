'use strict';

async function saveSignupPreset(pool, { userId, guildId, name, characterIds, priorityIds, notes }) {
  const [result] = await pool.query(
    `INSERT INTO signup_presets
       (discord_user_id, guild_id, name, character_ids, priority_ids, notes)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       id = LAST_INSERT_ID(id),
       name = VALUES(name),
       character_ids = VALUES(character_ids),
       priority_ids = VALUES(priority_ids),
       notes = VALUES(notes),
       created_at = NOW(3)`,
    [
      userId,
      guildId,
      name,
      JSON.stringify(characterIds),
      JSON.stringify(priorityIds),
      JSON.stringify(notes),
    ]
  );
  return result.insertId;
}

async function savePlaceholderPreset(pool, { guildId, userId, name, slots }) {
  const [result] = await pool.query(
    `INSERT INTO placeholder_presets (guild_id, name, slots, created_by)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       id = LAST_INSERT_ID(id),
       name = VALUES(name),
       slots = VALUES(slots),
       created_by = VALUES(created_by),
       created_at = NOW(3)`,
    [guildId, name, JSON.stringify(slots), userId]
  );
  return result.insertId;
}

module.exports = { savePlaceholderPreset, saveSignupPreset };
