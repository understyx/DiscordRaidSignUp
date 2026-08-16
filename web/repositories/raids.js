'use strict';

function createRaidRepository(pool) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('createRaidRepository requires a database pool');
  }

  async function findByGuildRaidNumber(guildId, raidNumber) {
    if (!Number.isFinite(raidNumber)) return null;
    const scopedGuildId = guildId === '0' || guildId === 'null' || !guildId ? null : guildId;
    const query =
      scopedGuildId === null
        ? 'SELECT * FROM raids WHERE guild_id IS NULL AND guild_raid_number = ?'
        : 'SELECT * FROM raids WHERE guild_id = ? AND guild_raid_number = ?';
    const params = scopedGuildId === null ? [raidNumber] : [scopedGuildId, raidNumber];
    const [[raid]] = await pool.query(query, params);
    return raid || null;
  }

  return { findByGuildRaidNumber };
}

module.exports = { createRaidRepository };
