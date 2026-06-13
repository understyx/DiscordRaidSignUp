const fetch = require('node-fetch');
const crypto = require('crypto');
const { URLSearchParams } = require('url');

const DISCORD_API = 'https://discord.com/api/v10';
const DISCORD_OAUTH_URL = 'https://discord.com/api/oauth2/authorize';
const DISCORD_TOKEN_URL = 'https://discord.com/api/oauth2/token';
const DISCORD_USER_URL = 'https://discord.com/api/users/@me';

// Notification Discord server — applicants are directed here to receive status updates
const NOTIFY_GUILD_ID   = '1495371293183180932';
const NOTIFY_CHANNEL_ID = '1495371294026366978';
const NOTIFY_INVITE_URL = 'https://discord.gg/VfgQ4UKSEP';

/**
 * Post a message to the notification server channel, mentioning the user.
 * Used to ping applicants when their application status changes.
 */
async function sendNotificationChannelPing(userId, content) {
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!botToken) return { ok: false, reason: 'no bot token' };

  try {
    const msgResp = await fetch(`${DISCORD_API}/channels/${NOTIFY_CHANNEL_ID}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: `<@${userId}> ${content}` }),
    });
    if (!msgResp.ok) {
      const text = await msgResp.text().catch(() => '');
      return { ok: false, reason: `Channel message ${msgResp.status}: ${text}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `Network error: ${err.message}` };
  }
}

/**
 * Send a Discord DM to a user via the bot token.
 */
async function sendDiscordDM(userId, content) {
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!botToken) return { ok: false, reason: 'no bot token' };

  try {
    const dmResp = await fetch(`${DISCORD_API}/users/@me/channels`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ recipient_id: String(userId) }),
    });
    if (!dmResp.ok) {
      const text = await dmResp.text().catch(() => '');
      return { ok: false, reason: `DM channel ${dmResp.status}: ${text}` };
    }
    const dmData = await dmResp.json();

    const msgResp = await fetch(`${DISCORD_API}/channels/${dmData.id}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content }),
    });
    if (!msgResp.ok) {
      const text = await msgResp.text().catch(() => '');
      return { ok: false, reason: `Message ${msgResp.status}: ${text}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `Network error: ${err.message}` };
  }
}

function redirectToRecruitmentOAuth(req, res) {
  const state = crypto.randomBytes(32).toString('hex');
  req.session.recruit_oauth_state = state;

  const redirectUri =
    process.env.RECRUITMENT_DISCORD_REDIRECT_URI ||
    `${process.env.WEB_BASE_URL || 'http://localhost:8000'}/recruitment/oauth-callback`;

  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID || '',
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'identify',
    state,
  });

  res.redirect(`${DISCORD_OAUTH_URL}?${params.toString()}`);
}

/**
 * Create a private application channel in the "Status - Open" category.
 */
async function createApplicationChannel(guildId, userId, username, displayName) {
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!botToken) return { ok: false, reason: 'no bot token' };

  try {
    const pool = require('../../db');
    const [[settings]] = await pool.query(
      'SELECT recruitment_category_open_id FROM guild_settings WHERE guild_id = ?',
      [guildId]
    );

    let categoryId = settings ? settings.recruitment_category_open_id : null;

    // Create channel
    const chanResp = await fetch(`${DISCORD_API}/guilds/${guildId}/channels`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: `app-${username.toLowerCase().replace(/[^a-z0-9]/g, '-')}`,
        type: 0, // Text channel
        parent_id: categoryId ? String(categoryId) : null,
        topic: `Application for ${displayName} (ID: ${userId})`,
        permission_overwrites: [
          { id: guildId, type: 0, deny: '1024' }, // Deny @everyone View Channel
          { id: String(userId), type: 1, allow: '3072' }, // Allow applicant View & Send
          { id: process.env.DISCORD_CLIENT_ID, type: 1, allow: '8' } // Allow bot Administrator (or just enough)
        ]
      }),
    });

    if (!chanResp.ok) {
      const text = await chanResp.text();
      return { ok: false, reason: `Failed to create channel: ${text}` };
    }

    const channel = await chanResp.json();
    return { ok: true, channel_id: channel.id };
  } catch (err) {
    return { ok: false, reason: `Network error: ${err.message}` };
  }
}

/**
 * Move a channel to a different category.
 */
async function moveChannelToCategory(channelId, categoryId) {
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!botToken) return { ok: false, reason: 'no bot token' };

  try {
    const resp = await fetch(`${DISCORD_API}/channels/${channelId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ parent_id: categoryId ? String(categoryId) : null }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      return { ok: false, reason: `Failed to move channel: ${text}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `Network error: ${err.message}` };
  }
}

async function sendEmbedToChannel(channelId, embed) {
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!botToken) return { ok: false, reason: 'no bot token' };

  try {
    const resp = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ embeds: [embed] }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      return { ok: false, reason: `Failed to send embed: ${text}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `Network error: ${err.message}` };
  }
}

module.exports = {
  DISCORD_API,
  DISCORD_OAUTH_URL,
  DISCORD_TOKEN_URL,
  DISCORD_USER_URL,
  NOTIFY_GUILD_ID,
  NOTIFY_CHANNEL_ID,
  NOTIFY_INVITE_URL,
  sendNotificationChannelPing,
  sendDiscordDM,
  redirectToRecruitmentOAuth,
  createApplicationChannel,
  moveChannelToCategory,
  sendEmbedToChannel,
};
