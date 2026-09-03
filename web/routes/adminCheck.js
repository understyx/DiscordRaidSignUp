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
const { demoConfig, isDemoGuildId } = require('../services/demoGuild');

const DISCORD_API = 'https://discord.com/api/v10';
function createAdminResolver(options) {
  const database = options.pool;
  const fetchMember = options.fetch;
  const botToken = options.botToken || '';
  const devUserId = options.devUserId || '';
  const devOverrideEnabled = options.devOverrideEnabled || (() => false);
  const cacheTtlMs = options.cacheTtlMs ?? 30_000;
  const staleTtlMs = options.staleTtlMs ?? 5 * 60_000;
  const now = options.now || Date.now;
  const logger = options.logger || console;
  const permissionCache = new Map();
  const pendingChecks = new Map();

  function cacheResult(key, value) {
    permissionCache.set(key, { value, checkedAt: now() });
    return value;
  }

  function staleResult(key) {
    const cached = permissionCache.get(key);
    return cached && now() - cached.checkedAt <= staleTtlMs ? cached.value : null;
  }

  return async function resolveIsAdmin(userId, guildId) {
    const demo = demoConfig(process.env);
    if (isDemoGuildId(guildId)) return String(userId) === demo.officerUserId;

    const isDev = devOverrideEnabled() && devUserId && String(userId) === String(devUserId);
    if (isDev) return true;

    // Preserve the legacy single-guild behavior when no guild context exists.
    if (!guildId) return true;

    const key = `${guildId}:${userId}`;
    const cached = permissionCache.get(key);
    if (cached && now() - cached.checkedAt <= cacheTtlMs) return cached.value;
    if (pendingChecks.has(key)) return pendingChecks.get(key);

    const check = (async () => {
      const [rows] = await database.query(
        'SELECT role_id FROM guild_admin_roles WHERE guild_id = ?',
        [guildId]
      );
      if (!rows || rows.length === 0) return cacheResult(key, true);
      if (!botToken) {
        logger.warn(
          '[adminCheck] Cannot verify user %s in guild %s because DISCORD_BOT_TOKEN is missing.',
          userId,
          guildId
        );
        return cacheResult(key, false);
      }

      const adminRoleIds = new Set(rows.map((row) => String(row.role_id)));
      try {
        const response = await fetchMember(`${DISCORD_API}/guilds/${guildId}/members/${userId}`, {
          headers: { Authorization: `Bot ${botToken}` },
        });
        if (!response.ok) {
          // A missing member is an authoritative denial. Other statuses can be
          // Discord outages, bot permission failures, or rate limits.
          if (response.status === 404) return cacheResult(key, false);
          const fallback = staleResult(key);
          logger.warn(
            '[adminCheck] Discord member lookup returned HTTP %s for user %s in guild %s; cached permission available: %s.',
            response.status || 'unknown',
            userId,
            guildId,
            fallback !== null
          );
          return fallback === null ? false : fallback;
        }
        const member = await response.json();
        return cacheResult(
          key,
          (member.roles || []).some((roleId) => adminRoleIds.has(String(roleId)))
        );
      } catch (error) {
        const fallback = staleResult(key);
        logger.warn(
          '[adminCheck] Discord member lookup failed for user %s in guild %s (%s); cached permission available: %s.',
          userId,
          guildId,
          error.message || error,
          fallback !== null
        );
        return fallback === null ? false : fallback;
      }
    })();

    pendingChecks.set(key, check);
    try {
      return await check;
    } finally {
      pendingChecks.delete(key);
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
