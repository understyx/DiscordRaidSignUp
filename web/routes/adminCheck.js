/**
 * adminCheck.js
 *
 * Resolves whether a Discord user has raid-admin access on the website.
 *
 * Logic:
 *   1. If guildId is not provided → everyone is admin (backward-compatible).
 *   2. If no rows exist in guild_admin_roles for the guild → everyone is admin
 *      (no restrictions configured yet).
 *   3. Otherwise → fetch the user's guild member record via the bot token and
 *      check whether any of their roles appear in guild_admin_roles.
 */

const fetch = require('node-fetch');
const pool = require('../db');
const { isDevFullAdminEnabled } = require('../server/runtimeFlags');

const DISCORD_API = 'https://discord.com/api/v10';
function createAdminResolver(options) {
  const database = options.pool;
  const fetchMember = options.fetch;
  const botToken = options.botToken || '';
  const devUserId = options.devUserId || '';
  const devOverrideEnabled = options.devOverrideEnabled || (() => false);

  return async function resolveIsAdmin(userId, guildId) {
    const isDev = devOverrideEnabled() && devUserId && String(userId) === String(devUserId);
    if (isDev) return true;

    // Preserve the legacy single-guild behavior when no guild context exists.
    if (!guildId) return true;

    const [rows] = await database.query(
      'SELECT role_id FROM guild_admin_roles WHERE guild_id = ?',
      [guildId]
    );
    if (!rows || rows.length === 0) return true;
    if (!botToken) return false;

    const adminRoleIds = new Set(rows.map((row) => String(row.role_id)));
    try {
      const response = await fetchMember(`${DISCORD_API}/guilds/${guildId}/members/${userId}`, {
        headers: { Authorization: `Bot ${botToken}` },
      });
      if (!response.ok) return false;
      const member = await response.json();
      return (member.roles || []).some((roleId) => adminRoleIds.has(String(roleId)));
    } catch (_error) {
      return false;
    }
  };
}

const resolveIsAdmin = createAdminResolver({
  botToken: process.env.DISCORD_BOT_TOKEN,
  devOverrideEnabled: isDevFullAdminEnabled,
  devUserId: process.env.DEV_USER_ID,
  fetch,
  pool,
});

module.exports = { createAdminResolver, resolveIsAdmin };
