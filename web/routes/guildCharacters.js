const express = require('express');
const pool = require('../db');
const { requireAdmin, popFlash, currentUser } = require('./helpers');

const router = express.Router();
const DISCORD_API = 'https://discord.com/api/v10';

router.get('/', async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const guildId = req.session.active_guild_id;
  if (!guildId) {
    req.session.flash = '❌ No active guild selected.';
    return res.redirect('/raids');
  }

  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!botToken) {
    req.session.flash = '❌ Bot token not configured.';
    return res.redirect('/raids');
  }

  try {
    // 1. Fetch guild members from Discord using native fetch (Node 18+)
    const resp = await fetch(`${DISCORD_API}/guilds/${guildId}/members?limit=1000`, {
      headers: { Authorization: `Bot ${botToken}` },
    });

    if (!resp.ok) {
      throw new Error(`Discord API error: ${resp.status} ${resp.statusText}`);
    }

    const members = await resp.json();
    const memberIds = members.map(m => String(m.user.id));

    if (memberIds.length === 0) {
      return res.render('guild_characters.html', {
        users: [],
        flash: popFlash(req),
        user: currentUser(req),
      });
    }

    // 2. Fetch characters for these members
    const [rows] = await pool.query(
      `SELECT c.*, du.username as discord_username, du.display_name as discord_display_name
       FROM characters c
       LEFT JOIN discord_users du ON c.discord_user_id = du.discord_user_id
       WHERE c.is_deleted = 0 AND c.discord_user_id IN (?)
       ORDER BY du.username ASC, c.char_name ASC`,
      [memberIds]
    );

    // 3. Group by user
    const byUser = {};

    for (const row of rows) {
      const userId = String(row.discord_user_id);
      if (!byUser[userId]) {
        byUser[userId] = {
          userId,
          username: row.discord_username || 'Unknown',
          displayName: row.discord_display_name || 'Unknown',
          characters: []
        };
      }
      byUser[userId].characters.push(row);
    }

    res.render('guild_characters.html', {
      users: Object.values(byUser),
      guild_name: req.session.active_guild_name,
      flash: popFlash(req),
      user: currentUser(req),
    });

  } catch (err) {
    console.error('[guild-characters] Error:', err);
    req.session.flash = '❌ Failed to load guild characters.';
    res.redirect('/raids');
  }
});

module.exports = router;
