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

const DISCORD_API = 'https://discord.com/api/v10';

/**
 * Returns true if the given Discord user ID should be treated as a raid admin.
 *
 * @param {string} userId   Discord user ID (string snowflake)
 * @param {string|null} guildId  Active guild ID (string snowflake), or null
 * @returns {Promise<boolean>}
 */
async function resolveIsAdmin(userId, guildId) {
  const botToken = process.env.DISCORD_BOT_TOKEN;

  // If guild ID is not provided, grant admin to everyone (backward-compatible).
  if (!guildId) return true;

  // Check if any admin roles are configured for this guild.
  const [rows] = await pool.query(
    'SELECT role_id FROM guild_admin_roles WHERE guild_id = ?',
    [guildId]
  );

  // If no admin roles are configured yet, grant admin to everyone.
  if (!rows || rows.length === 0) return true;

  const adminRoleIds = new Set(rows.map(r => String(r.role_id)));

  // Fetch the user's guild member info using the bot token.
  if (!botToken) return false;

  try {
    const resp = await fetch(`${DISCORD_API}/guilds/${guildId}/members/${userId}`, {
      headers: { Authorization: `Bot ${botToken}` },
    });

    if (!resp.ok) {
      // User is not a member of the guild or an error occurred.
      return false;
    }

    const member = await resp.json();
    const memberRoles = member.roles || [];

    return memberRoles.some(rid => adminRoleIds.has(String(rid)));
  } catch (_err) {
    // Network or parse error — fail closed.
    return false;
  }
}

module.exports = { resolveIsAdmin };
