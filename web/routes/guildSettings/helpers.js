const fetch = require('node-fetch');

const DISCORD_API = 'https://discord.com/api/v10';

/**
 * Fetch guild roles from Discord API.
 * Returns [] on any error so the UI degrades gracefully.
 */
async function fetchGuildRoles(guildId) {
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!guildId || !botToken) return [];

  try {
    const resp = await fetch(`${DISCORD_API}/guilds/${guildId}/roles`, {
      headers: { Authorization: `Bot ${botToken}` },
    });
    if (!resp.ok) {
      console.warn(`[guild-settings] Discord API ${resp.status} fetching roles for guild ${guildId}`);
      return [];
    }
    const roles = await resp.json();
    return roles
      .filter(r => r.id !== guildId) // exclude @everyone
      .sort((a, b) => b.position - a.position)
      .map(r => ({
        id: r.id,
        name: r.name,
        color_hex: r.color ? r.color.toString(16).padStart(6, '0') : null,
      }));
  } catch (err) {
    console.warn('[guild-settings] Failed to fetch guild roles:', err.message || err);
    return [];
  }
}

const RESERVED_SLUGS = new Set([
  'www', 'api', 'admin', 'mail', 'auth', 'login', 'app', 'static', 'assets',
  'cdn', 'ftp', 'smtp', 'pop', 'imap', 'dev', 'staging', 'test', 'beta',
  'help', 'support', 'status', 'blog', 'shop', 'store',
]);

module.exports = { fetchGuildRoles, RESERVED_SLUGS };
