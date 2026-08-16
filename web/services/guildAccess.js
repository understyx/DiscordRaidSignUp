'use strict';

function selectAvailableGuilds(botGuildRows, userGuildIds, options = {}) {
  const membershipIds = new Set((userGuildIds || []).map(String));
  const excludedGuildId = options.excludedGuildId ? String(options.excludedGuildId) : null;
  const isDev = Boolean(options.isDev);

  return (botGuildRows || [])
    .filter((row) => !excludedGuildId || String(row.guild_id) !== excludedGuildId)
    .filter((row) => isDev || membershipIds.has(String(row.guild_id)))
    .map((row) => ({
      guild_id: String(row.guild_id),
      guild_name: row.guild_name,
      is_dev_only: isDev && !membershipIds.has(String(row.guild_id)),
    }));
}

function safeRelativeRedirect(candidate, fallback = '/raids') {
  if (!candidate) return fallback;
  try {
    const decoded = decodeURIComponent(candidate);
    if (decoded.startsWith('/') && !decoded.startsWith('//') && !/[\r\n]/.test(decoded)) {
      return decoded;
    }
  } catch (_) {
    // Invalid percent encoding is not a valid redirect target.
  }
  return fallback;
}

function canStartCharacterGuide(userGuildIds, guildId) {
  if (!/^\d+$/.test(String(guildId || ''))) return false;
  return new Set((userGuildIds || []).map(String)).has(String(guildId));
}

module.exports = { canStartCharacterGuide, safeRelativeRedirect, selectAvailableGuilds };
