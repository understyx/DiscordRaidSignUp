const express = require('express');
const pool = require('../db');
const { requireAdmin, popFlash, currentUser, parseGS } = require('./helpers');

const router = express.Router();
const DISCORD_API = 'https://discord.com/api/v10';

/**
 * Helper: Verify that a specific Discord user is a member of the given guild.
 * Uses the bot token to check membership via Discord API.
 */
async function verifyGuildMembership(guildId, userId) {
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!botToken) return false;

  try {
    const resp = await fetch(`${DISCORD_API}/guilds/${guildId}/members/${userId}`, {
      headers: { Authorization: `Bot ${botToken}` },
    });
    return resp.ok;
  } catch (err) {
    console.error('[verifyGuildMembership] Error:', err);
    return false;
  }
}

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
    // 1. Fetch guild members from Discord
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
       ORDER BY du.username ASC, c.char_name ASC, c.id ASC`,
      [memberIds]
    );

    // 3. Group by user, then by character name+realm
    const byUser = {};

    for (const row of rows) {
      const userId = String(row.discord_user_id);
      if (!byUser[userId]) {
        byUser[userId] = {
          userId,
          username: row.discord_username || 'Unknown',
          displayName: row.discord_display_name || 'Unknown',
          charGroups: []
        };
      }

      const groupKey = `${row.char_name}|${row.realm}`;
      let group = byUser[userId].charGroups.find(g => `${g.name}|${g.realm}` === groupKey);
      if (!group) {
        group = {
          name: row.char_name,
          realm: row.realm,
          char_class: row.char_class,
          rows: []
        };
        byUser[userId].charGroups.push(group);
      }
      group.rows.push(row);
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

// POST /guild-characters/update-spec/:char_id
router.post('/update-spec/:char_id', express.urlencoded({ extended: false }), async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const guildId = req.session.active_guild_id;
  const charId = parseInt(req.params.char_id);
  const spec = (req.body.spec || '').trim() || null;

  try {
    const [[char]] = await pool.query('SELECT discord_user_id, char_name FROM characters WHERE id = ? AND is_deleted = 0', [charId]);
    if (!char) {
      req.session.flash = '❌ Character not found.';
      return res.redirect('/guild-characters');
    }

    if (!(await verifyGuildMembership(guildId, char.discord_user_id))) {
      req.session.flash = '❌ Permission denied: Character owner is not in this guild.';
      return res.redirect('/guild-characters');
    }

    await pool.query('UPDATE characters SET spec = ?, last_updated = NOW() WHERE id = ?', [spec, charId]);
    req.session.flash = `✅ Spec updated for ${char.char_name}.`;
  } catch (err) {
    console.error('[guild-characters] Update spec error:', err);
    req.session.flash = '❌ Failed to update spec.';
  }

  res.redirect('/guild-characters');
});

// POST /guild-characters/update-gs/:char_id
router.post('/update-gs/:char_id', express.urlencoded({ extended: false }), async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const guildId = req.session.active_guild_id;
  const charId = parseInt(req.params.char_id);
  const gearscore = parseGS(req.body.gearscore);

  try {
    const [[char]] = await pool.query('SELECT discord_user_id, char_name FROM characters WHERE id = ? AND is_deleted = 0', [charId]);
    if (!char) {
      req.session.flash = '❌ Character not found.';
      return res.redirect('/guild-characters');
    }

    if (!(await verifyGuildMembership(guildId, char.discord_user_id))) {
      req.session.flash = '❌ Permission denied: Character owner is not in this guild.';
      return res.redirect('/guild-characters');
    }

    await pool.query('UPDATE characters SET gearscore = ?, last_updated = NOW() WHERE id = ?', [gearscore, charId]);
    req.session.flash = `✅ GS updated for ${char.char_name}.`;
  } catch (err) {
    console.error('[guild-characters] Update GS error:', err);
    req.session.flash = '❌ Failed to update GS.';
  }

  res.redirect('/guild-characters');
});

// POST /guild-characters/delete/:char_id
router.post('/delete/:char_id', express.urlencoded({ extended: false }), async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const guildId = req.session.active_guild_id;
  const charId = parseInt(req.params.char_id);

  try {
    const [[char]] = await pool.query('SELECT discord_user_id, char_name FROM characters WHERE id = ? AND is_deleted = 0', [charId]);
    if (!char) {
      req.session.flash = '❌ Character not found.';
      return res.redirect('/guild-characters');
    }

    if (!(await verifyGuildMembership(guildId, char.discord_user_id))) {
      req.session.flash = '❌ Permission denied: Character owner is not in this guild.';
      return res.redirect('/guild-characters');
    }

    await pool.query('UPDATE characters SET is_deleted = 1 WHERE id = ?', [charId]);
    req.session.flash = `✅ Character ${char.char_name} hidden.`;
  } catch (err) {
    console.error('[guild-characters] Delete error:', err);
    req.session.flash = '❌ Failed to delete character.';
  }

  res.redirect('/guild-characters');
});

// POST /guild-characters/register
router.post('/register', express.urlencoded({ extended: false }), async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const guildId = req.session.active_guild_id;
  const targetUserId = req.body.discord_user_id;
  const charName = (req.body.char_name || '').trim();
  const realm = (req.body.realm || 'Icecrown').trim();
  const charClass = (req.body.char_class || '').trim() || null;
  const spec = (req.body.spec || '').trim() || null;
  const gearscore = parseGS(req.body.gearscore);

  if (!targetUserId || !charName) {
    req.session.flash = '❌ User ID and character name are required.';
    return res.redirect('/guild-characters');
  }

  try {
    if (!(await verifyGuildMembership(guildId, targetUserId))) {
      req.session.flash = '❌ Permission denied: Target user is not in this guild.';
      return res.redirect('/guild-characters');
    }

    const charNameCap = charName.charAt(0).toUpperCase() + charName.slice(1).toLowerCase();
    const realmCap = realm.charAt(0).toUpperCase() + realm.slice(1).toLowerCase();
    const specNorm = spec || null;

    const [[existing]] = await pool.query(
      `SELECT id FROM characters
       WHERE discord_user_id = ? AND char_name = ? AND realm = ?
         AND (spec <=> ?)
       LIMIT 1`,
      [targetUserId, charNameCap, realmCap, specNorm]
    );

    if (existing) {
      await pool.query(
        'UPDATE characters SET char_class = ?, gearscore = ?, is_deleted = 0, last_updated = NOW() WHERE id = ?',
        [charClass, gearscore, existing.id]
      );
    } else {
      await pool.query(
        `INSERT INTO characters (discord_user_id, char_name, realm, char_class, spec, gearscore, is_deleted, last_updated)
         VALUES (?, ?, ?, ?, ?, ?, 0, NOW())`,
        [targetUserId, charNameCap, realmCap, charClass, spec, gearscore]
      );
    }

    // If a class was provided, ensure all other specs of this character have the same class
    if (charClass) {
      await pool.query(
        'UPDATE characters SET char_class = ? WHERE discord_user_id = ? AND char_name = ? AND realm = ?',
        [charClass, targetUserId, charNameCap, realmCap]
      );
    }

    req.session.flash = `✅ Character ${charNameCap} registered for user.`;
  } catch (err) {
    console.error('[guild-characters] Register error:', err);
    req.session.flash = '❌ Failed to register character.';
  }

  res.redirect('/guild-characters');
});

module.exports = router;
