const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const pool = require('../../db');

// Load WotLK buff definitions once at startup

const DISCORD_API = 'https://discord.com/api/v10';
const RAID_LOG_HISTORY_SCAN_LIMIT = 10000;
const RAID_LOG_TOKEN_PREFIX = '[raid-log:';
let CACHED_BOT_USER_ID = null;

async function postToDiscordChannel(channelId, payload) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token || !channelId) return { ok: false, reason: 'missing token or channel' };

  try {
    const resp = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return { ok: false, reason: `Discord API ${resp.status}: ${text}` };
    }
    const data = await resp.json().catch(() => null);
    return { ok: true, messageId: data && data.id ? String(data.id) : null };
  } catch (err) {
    return { ok: false, reason: `Network error: ${err.message}` };
  }
}

async function editDiscordMessage(channelId, messageId, payload) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token || !channelId || !messageId)
    return { ok: false, reason: 'missing token/channel/message' };

  try {
    const resp = await fetch(`${DISCORD_API}/channels/${channelId}/messages/${messageId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return { ok: false, status: resp.status, reason: `Discord API ${resp.status}: ${text}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `Network error: ${err.message}` };
  }
}

function isDiscordNotFound(result) {
  return Boolean(result && !result.ok && result.status === 404);
}

async function fetchDiscordMessagesPage(channelId, limit, before = null) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token || !channelId) return { ok: false, reason: 'missing token or channel', messages: [] };
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 100));
  const qs = new URLSearchParams({ limit: String(safeLimit) });
  if (before) qs.set('before', String(before));

  try {
    const resp = await fetch(`${DISCORD_API}/channels/${channelId}/messages?${qs.toString()}`, {
      headers: { Authorization: `Bot ${token}` },
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return { ok: false, reason: `Discord API ${resp.status}: ${text}`, messages: [] };
    }
    const messages = await resp.json();
    return { ok: true, messages: Array.isArray(messages) ? messages : [] };
  } catch (err) {
    return { ok: false, reason: `Network error: ${err.message}`, messages: [] };
  }
}

async function fetchDiscordBotUserId() {
  if (CACHED_BOT_USER_ID) return CACHED_BOT_USER_ID;
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) return null;
  try {
    const resp = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bot ${token}` },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    CACHED_BOT_USER_ID = data && data.id ? String(data.id) : null;
    return CACHED_BOT_USER_ID;
  } catch (_) {
    return null;
  }
}

function userLogIdentityToken(raidId, discordUserId) {
  return `${RAID_LOG_TOKEN_PREFIX}${raidId}:${discordUserId}]`;
}

function ensureUserLogIdentityToken(message, raidId, discordUserId) {
  const content = String(message || '');
  const token = userLogIdentityToken(raidId, discordUserId);
  if (content.includes(token)) return content;
  return `${content}\n${token}`;
}

async function findExistingRaidUserLogMessageId(threadId, raidId, discordUserId) {
  const token = userLogIdentityToken(raidId, discordUserId);
  const mentionA = `<@${discordUserId}>`;
  const mentionB = `<@!${discordUserId}>`;
  const botUserId = await fetchDiscordBotUserId();
  if (!botUserId) return null;
  let before = null;
  let scannedMessages = 0;

  while (scannedMessages < RAID_LOG_HISTORY_SCAN_LIMIT) {
    const pageSize = Math.min(100, RAID_LOG_HISTORY_SCAN_LIMIT - scannedMessages);
    const page = await fetchDiscordMessagesPage(threadId, pageSize, before);
    if (!page.ok) {
      console.warn(`[log-thread] Failed to read thread history ${threadId}: ${page.reason}`);
      return null;
    }
    const msgs = page.messages || [];
    if (msgs.length === 0) break;
    scannedMessages += msgs.length;
    if (scannedMessages >= RAID_LOG_HISTORY_SCAN_LIMIT) break;

    for (const msg of msgs) {
      if (!msg.author || String(msg.author.id) !== botUserId) continue;
      const content = String(msg.content || '');
      if (content.includes(token)) return msg.id;
      // Backward-compat fallback for legacy rows/messages created before tokenization.
      if (!content.includes(mentionA) && !content.includes(mentionB)) continue;
      return msg.id;
    }
    before = msgs[msgs.length - 1].id;
  }
  return null;
}

async function getStoredRaidUserLogMessageId(raidId, discordUserId) {
  const [rows] = await pool.query(
    'SELECT discord_message_id FROM raid_log_messages WHERE raid_id = ? AND discord_user_id = ? LIMIT 1',
    [raidId, discordUserId]
  );
  const row = rows[0];
  return row && row.discord_message_id ? String(row.discord_message_id) : null;
}

async function upsertRaidUserLogMessageId(raidId, discordUserId, threadId, messageId) {
  if (!raidId || !discordUserId || !threadId || !messageId) return;
  await pool.query(
    `INSERT INTO raid_log_messages
      (raid_id, discord_user_id, discord_thread_id, discord_message_id, updated_at)
     VALUES (?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
      discord_thread_id = VALUES(discord_thread_id),
      discord_message_id = VALUES(discord_message_id),
      updated_at = NOW()`,
    [raidId, discordUserId, threadId, messageId]
  );
}

async function postToRaidLogThread(raidId, message, discordUserId = null) {
  const [rows] = await pool.query('SELECT discord_log_thread_id FROM raids WHERE id = ?', [raidId]);
  const raid = rows[0];
  const threadId = raid && raid.discord_log_thread_id ? String(raid.discord_log_thread_id) : null;
  if (!threadId) return;
  let allowPostFallback = true;
  let finalMessage = String(message || '');

  if (discordUserId) {
    finalMessage = ensureUserLogIdentityToken(finalMessage, raidId, discordUserId);
    const storedMessageId = await getStoredRaidUserLogMessageId(raidId, discordUserId);
    if (storedMessageId) {
      const editStoredResult = await editDiscordMessage(threadId, storedMessageId, {
        content: finalMessage,
      });
      if (editStoredResult.ok) {
        return;
      }
      console.warn(
        `[log-thread] Failed to edit stored log message ${storedMessageId} in ${threadId}: ${editStoredResult.reason}`
      );
      if (!isDiscordNotFound(editStoredResult)) {
        allowPostFallback = false;
      }
    }

    const existingMessageId = await findExistingRaidUserLogMessageId(
      threadId,
      raidId,
      discordUserId
    );
    if (existingMessageId) {
      const editResult = await editDiscordMessage(threadId, existingMessageId, {
        content: finalMessage,
      });
      if (!editResult.ok) {
        console.warn(
          `[log-thread] Failed to edit log message ${existingMessageId} in ${threadId}: ${editResult.reason}`
        );
        if (!isDiscordNotFound(editResult)) {
          allowPostFallback = false;
        }
      } else {
        await upsertRaidUserLogMessageId(raidId, discordUserId, threadId, existingMessageId);
        return;
      }
    }
  }

  if (!allowPostFallback) return;

  const postResult = await postToDiscordChannel(threadId, { content: finalMessage });
  if (!postResult.ok) {
    console.warn(`[log-thread] Failed to post to log thread ${threadId}: ${postResult.reason}`);
    return;
  }
  if (discordUserId && postResult.messageId) {
    await upsertRaidUserLogMessageId(raidId, discordUserId, threadId, postResult.messageId);
  }
}

module.exports = {
  postToDiscordChannel,
  editDiscordMessage,
  isDiscordNotFound,
  fetchDiscordMessagesPage,
  fetchDiscordBotUserId,
  findExistingRaidUserLogMessageId,
  getStoredRaidUserLogMessageId,
  upsertRaidUserLogMessageId,
  postToRaidLogThread,
  DISCORD_API,
  RAID_LOG_HISTORY_SCAN_LIMIT,
};
