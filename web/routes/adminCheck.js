/**
 * adminCheck.js
 *
 * Resolves role-based access for Discord users on the website.
 *
 * Two role types are supported (stored in guild_admin_roles.role_type):
 *   'admin'  – can manage raids on the website.
 *   'signup' – allowed to sign up for raids.
 *
 * Base-case logic (applies to both types independently):
 *   1. If DISCORD_GUILD_ID is not configured → everyone has access.
 *   2. If no rows of that role_type exist for the guild → everyone has access.
 *   3. Otherwise → fetch the user's guild member record via the bot token and
 *      check whether any of their roles appear in guild_admin_roles for that type.
 */

const fetch = require('node-fetch');
const pool = require('../db');

const DISCORD_API = 'https://discord.com/api/v10';

/**
 * Fetches the Discord guild member roles for a user.
 * Returns an array of role ID strings, or null on failure.
 *
 * @param {string} guildId
 * @param {string} userId
 * @param {string} botToken
 * @returns {Promise<string[]|null>}
 */
async function _fetchMemberRoles(guildId, userId, botToken) {
  if (!botToken) return null;
  try {
    const resp = await fetch(`${DISCORD_API}/guilds/${guildId}/members/${userId}`, {
      headers: { Authorization: `Bot ${botToken}` },
    });
    if (!resp.ok) return null;
    const member = await resp.json();
    return (member.roles || []).map(String);
  } catch (_err) {
    return null;
  }
}

/**
 * Generic resolver: returns true if the user has access for the given role_type.
 *
 * @param {string} userId    Discord user ID (string snowflake)
 * @param {string} roleType  'admin' or 'signup'
 * @returns {Promise<boolean>}
 */
async function _resolveAccess(userId, roleType) {
  const guildId = process.env.DISCORD_GUILD_ID;
  const botToken = process.env.DISCORD_BOT_TOKEN;

  // If guild ID is not configured, grant access to everyone (backward-compatible).
  if (!guildId) return true;

  // Check if any roles of this type are configured for this guild.
  const [rows] = await pool.query(
    'SELECT role_id FROM guild_admin_roles WHERE guild_id = ? AND role_type = ?',
    [guildId, roleType]
  );

  // Base case: no roles configured → everyone has access.
  if (!rows || rows.length === 0) return true;

  const configuredIds = new Set(rows.map(r => String(r.role_id)));

  const memberRoles = await _fetchMemberRoles(guildId, userId, botToken);
  if (!memberRoles) return false;

  return memberRoles.some(rid => configuredIds.has(rid));
}

/**
 * Returns true if the given Discord user ID should be treated as a raid admin.
 *
 * @param {string} userId  Discord user ID (string snowflake)
 * @returns {Promise<boolean>}
 */
async function resolveIsAdmin(userId) {
  return _resolveAccess(userId, 'admin');
}

/**
 * Returns true if the given Discord user ID is allowed to sign up for raids.
 *
 * @param {string} userId  Discord user ID (string snowflake)
 * @returns {Promise<boolean>}
 */
async function resolveCanSignup(userId) {
  return _resolveAccess(userId, 'signup');
}

module.exports = { resolveIsAdmin, resolveCanSignup };
