'use strict';

function createStatisticsRepository(pool) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('createStatisticsRepository requires a database pool');
  }

  async function listGuildMemberAttendance(guildId) {
    const [rows] = await pool.query(
      `SELECT members.discord_user_id, members.username, members.display_name,
              COALESCE(signups.signup_count, 0) AS signup_count,
              COALESCE(placements.placed_count, 0) AS placed_count
       FROM (
         SELECT c.discord_user_id,
                MAX(du.username) AS username,
                MAX(du.display_name) AS display_name
         FROM characters c
         LEFT JOIN discord_users du ON du.discord_user_id = c.discord_user_id
         WHERE c.guild_id = ?
         GROUP BY c.discord_user_id
       ) members
       LEFT JOIN (
         SELECT s.discord_user_id, COUNT(DISTINCT s.raid_id) AS signup_count
         FROM signups s
         INNER JOIN raids r ON r.id = s.raid_id
         WHERE r.guild_id = ? AND s.status IN ('signed', 'tentative')
         GROUP BY s.discord_user_id
       ) signups ON signups.discord_user_id = members.discord_user_id
       LEFT JOIN (
         SELECT placed_rows.discord_user_id,
                COUNT(DISTINCT placed_rows.raid_id) AS placed_count
         FROM (
           SELECT co.raid_id,
                  COALESCE(co.discord_user_id, c.discord_user_id) AS discord_user_id
           FROM compositions co
           INNER JOIN raids r ON r.id = co.raid_id
           LEFT JOIN characters c ON c.id = co.character_id
           WHERE r.guild_id = ?
         ) placed_rows
         WHERE placed_rows.discord_user_id IS NOT NULL
         GROUP BY placed_rows.discord_user_id
       ) placements ON placements.discord_user_id = members.discord_user_id
       ORDER BY placed_count DESC, signup_count DESC,
                COALESCE(members.display_name, members.username, members.discord_user_id) ASC`,
      [guildId, guildId, guildId]
    );

    return rows.map((row) => {
      const userId = String(row.discord_user_id);
      const username = row.username || userId;
      return {
        userId,
        username,
        displayName: row.display_name || username,
        signupCount: Number(row.signup_count) || 0,
        placedCount: Number(row.placed_count) || 0,
      };
    });
  }

  return { listGuildMemberAttendance };
}

module.exports = { createStatisticsRepository };
