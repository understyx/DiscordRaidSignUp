'use strict';

const fetch = require('node-fetch');

const DISCORD_API = 'https://discord.com/api/v10';
const DISCORD_BLURPLE = 0x5865f2;
const MAX_CUSTOM_MESSAGE_LENGTH = 2000;
const MAX_BULK_RECIPIENTS = 5000;

function selectBulkRecipients(
  members,
  characterCounts,
  { characterFilter, rankIds, specificUserId }
) {
  const selectedRankIds = new Set((rankIds || []).map(String));
  return members.filter((member) => {
    if (!member.user || member.user.bot) return false;

    const userId = String(member.user.id);
    if (characterFilter === 'specific') return userId === String(specificUserId || '');

    const characterCount = Number(characterCounts.get(userId)) || 0;
    if (characterFilter === 'zero' && characterCount !== 0) return false;
    if (characterFilter === 'one_or_more' && characterCount < 1) return false;
    if (selectedRankIds.size && !selectedRankIds.has(String(member.topRoleId || ''))) return false;
    return true;
  });
}

function buildHelpRaidBotMessage({ guildId, guildName, webBaseUrl }) {
  const guideUrl = `${String(webBaseUrl || 'http://localhost:8000').replace(/\/$/, '')}/help/add-characters/${guildId}`;

  return {
    embeds: [
      {
        title: '👋 Need help managing your characters?',
        description:
          "Choose where you'd like to add or edit them. Your answers will stay private.\n\n" +
          '💬 **Discord** — use a guided flow in a DM with me\n' +
          '🌐 **Website** — manage them in your browser',
        color: DISCORD_BLURPLE,
        footer: {
          text: `Sent for ${guildName || 'your server'} · Guild ID: ${guildId}`,
        },
      },
    ],
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 1,
            label: 'Guide me in Discord',
            emoji: { name: '💬' },
            custom_id: 'helpnoobs:discord',
          },
          {
            type: 2,
            style: 5,
            label: 'Use the website',
            emoji: { name: '🌐' },
            url: guideUrl,
          },
        ],
      },
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 2,
            label: 'Show useful bot commands',
            emoji: { name: '🧰' },
            custom_id: 'helpnoobs:commands',
          },
        ],
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

function buildCustomMessage(content) {
  const message = String(content || '').trim();
  if (!message) throw new Error('Enter a message to send.');
  if (message.length > MAX_CUSTOM_MESSAGE_LENGTH) {
    throw new Error(`Messages cannot exceed ${MAX_CUSTOM_MESSAGE_LENGTH} characters.`);
  }
  if (message.startsWith('/')) {
    throw new Error(
      'Discord does not execute slash commands sent as text. Choose a supported bot action instead.'
    );
  }
  return { content: message, allowed_mentions: { parse: [] } };
}

function summarizeBulkMessagePayload(value, messageAction) {
  let payload = value;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      return messageAction === 'helpraidbot' ? 'Character setup guide' : 'Message unavailable';
    }
  }

  if (typeof payload?.content === 'string' && payload.content.trim()) {
    return payload.content.trim();
  }

  const firstEmbed = Array.isArray(payload?.embeds) ? payload.embeds[0] : null;
  const embedText = [firstEmbed?.title, firstEmbed?.description]
    .filter((part) => typeof part === 'string' && part.trim())
    .map((part) => part.trim())
    .join('\n');
  if (embedText) return embedText;

  return messageAction === 'helpraidbot' ? 'Character setup guide' : 'Message unavailable';
}

function responseRateLimitDelay(response) {
  const remaining = response.headers?.get?.('x-ratelimit-remaining');
  if (remaining !== '0') return 0;
  return Math.max(Number(response.headers.get('x-ratelimit-reset-after')) || 0, 0) * 1000;
}

async function failedDiscordResponse(response, operation) {
  let retryAfterMs = 0;
  let globalRateLimit = false;
  if (response.status === 429) {
    const rateLimit = await response.json().catch(() => ({}));
    retryAfterMs = Math.max(Number(rateLimit.retry_after) || 1, 0.1) * 1000;
    globalRateLimit = Boolean(rateLimit.global);
  }
  return {
    ok: false,
    reason: `${operation} (${response.status}).`,
    retryable: response.status === 429 || response.status >= 500,
    retryAfterMs,
    rateLimited: response.status === 429,
    globalRateLimit,
  };
}

async function sendDiscordDirectMessage(userId, payload, options = {}) {
  const botToken = options.botToken || process.env.DISCORD_BOT_TOKEN;
  const fetchImpl = options.fetchImpl || fetch;
  if (!botToken) return { ok: false, reason: 'Bot token is not configured.' };

  const headers = {
    Authorization: `Bot ${botToken}`,
    'Content-Type': 'application/json',
  };

  try {
    const dmResponse = await fetchImpl(`${DISCORD_API}/users/@me/channels`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ recipient_id: String(userId) }),
    });
    if (!dmResponse.ok) {
      return failedDiscordResponse(dmResponse, 'Could not open DM channel');
    }

    const dmChannel = await dmResponse.json();
    const dmChannelDelay = responseRateLimitDelay(dmResponse);
    if (dmChannelDelay) {
      await new Promise((resolve) => setTimeout(resolve, dmChannelDelay));
    }

    const messagePayload = options.nonce
      ? { ...payload, nonce: String(options.nonce), enforce_nonce: true }
      : payload;
    const messageResponse = await fetchImpl(`${DISCORD_API}/channels/${dmChannel.id}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(messagePayload),
    });
    if (!messageResponse.ok) {
      return failedDiscordResponse(messageResponse, 'Could not send message');
    }
    return { ok: true, rateLimitDelayMs: responseRateLimitDelay(messageResponse) };
  } catch (error) {
    return {
      ok: false,
      reason: `Discord request failed: ${error.message}`,
      retryable: true,
      retryAfterMs: 1000,
    };
  }
}

async function sendBulkDiscordDirectMessages(userIds, payload, options = {}) {
  const results = [];
  for (const userId of userIds) {
    const result = await sendDiscordDirectMessage(userId, payload, options);
    results.push({ userId: String(userId), ...result });
  }
  return results;
}

module.exports = {
  MAX_BULK_RECIPIENTS,
  MAX_CUSTOM_MESSAGE_LENGTH,
  buildCustomMessage,
  buildHelpRaidBotMessage,
  selectBulkRecipients,
  sendBulkDiscordDirectMessages,
  sendDiscordDirectMessage,
  summarizeBulkMessagePayload,
};
