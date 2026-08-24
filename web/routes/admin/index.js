const express = require('express');
const fetch = require('node-fetch');
const pool = require('../../db');
const { requireAdmin, popFlash, currentUser } = require('../helpers');
const { isDevFullAdminEnabled, setDevFullAdminEnabled } = require('../../server/runtimeFlags');
const { buildPresetPeek, integerIds } = require('../../services/presetPeek');
const {
  _WOW_CLASSES,
  _CLASS_SPEC_ROLES,
  _REALMS,
  _randInt,
  _randomCharName,
  _randomFakeId,
} = require('./seedHelpers');

const router = express.Router();
const DEV_USER_ID = process.env.DEV_USER_ID || '';

// lowercase class names used for spec aliases management
const WOW_CLASS_NAMES = _WOW_CLASSES.map((c) => c.name.toLowerCase());

function isDeveloper(req) {
  return !!DEV_USER_ID && !!req.session.user_id && req.session.user_id === DEV_USER_ID;
}

// POST /admin/dev-full-admin/toggle — developer-only live runtime toggle (web process)
router.post('/dev-full-admin/toggle', express.urlencoded({ extended: false }), (req, res) => {
  if (!isDeveloper(req)) {
    req.session.flash = '❌ Access denied.';
    return res.redirect('/raids');
  }

  const current = isDevFullAdminEnabled();
  const next = !current;
  setDevFullAdminEnabled(next);
  req.session.flash = `✅ Developer full-admin is now ${next ? 'enabled' : 'disabled'} (website runtime).`;
  return res.redirect('/raids');
});

// GET /admin/signup-presets — developer-only, read-only view of every user's
// signup presets in the active guild.
router.get('/signup-presets', async (req, res) => {
  if (!isDeveloper(req)) {
    req.session.flash = '❌ Access denied. This page is only available to developers.';
    return res.redirect('/raids');
  }

  const guildId = req.session.active_guild_id;
  if (!guildId) {
    req.session.flash = '❌ No active guild selected.';
    return res.redirect('/select-guild');
  }

  const [presetRows] = await pool.query(
    `SELECT sp.id, sp.discord_user_id, sp.name, sp.character_ids, sp.priority_ids,
            sp.notes, sp.created_at, du.username, du.display_name
       FROM signup_presets sp
       LEFT JOIN discord_users du ON du.discord_user_id = sp.discord_user_id
      WHERE sp.guild_id = ?
      ORDER BY COALESCE(NULLIF(du.display_name, ''), du.username),
               sp.discord_user_id, sp.created_at DESC, sp.id DESC`,
    [guildId]
  );

  const characterIds = [
    ...new Set(presetRows.flatMap((preset) => integerIds(preset.character_ids))),
  ];
  let characterRows = [];
  if (characterIds.length > 0) {
    const placeholders = characterIds.map(() => '?').join(', ');
    [characterRows] = await pool.query(
      `SELECT id, discord_user_id, char_name, realm, char_class, spec, role, gearscore
         FROM characters
        WHERE guild_id = ? AND id IN (${placeholders})`,
      [guildId, ...characterIds]
    );
  }

  const peek = buildPresetPeek(presetRows, characterRows);
  res.render('admin_signup_presets.html', {
    ...peek,
    flash: popFlash(req),
    user: currentUser(req),
  });
});

// GET /admin/spec-aliases — viewable by developers only
router.get('/spec-aliases', async (req, res) => {
  if (!isDeveloper(req)) {
    req.session.flash = '❌ Access denied. This page is only available to developers.';
    return res.redirect('/raids');
  }

  const guildId = req.session.active_guild_id;
  if (!guildId) {
    req.session.flash = '❌ No active guild selected.';
    return res.redirect('/select-guild');
  }

  const [rows] = await pool.query(
    'SELECT id, char_class, alias, canonical FROM spec_aliases WHERE guild_id = ? ORDER BY char_class, alias',
    [guildId]
  );

  // Group by class
  const byClass = {};
  for (const cls of WOW_CLASS_NAMES) byClass[cls] = [];
  for (const row of rows) {
    if (!byClass[row.char_class]) byClass[row.char_class] = [];
    byClass[row.char_class].push(row);
  }

  const flash = popFlash(req);

  const isAdmin = req.session.user_id ? req.session.is_admin === true : false;

  res.render('admin_spec_aliases.html', {
    by_class: byClass,
    wow_classes: WOW_CLASS_NAMES,
    flash,
    is_admin: isAdmin,
    user: req.session.user_id
      ? { id: req.session.user_id, username: req.session.username, is_admin: req.session.is_admin }
      : null,
  });
});

// POST /admin/spec-aliases/add
router.post('/spec-aliases/add', express.urlencoded({ extended: false }), async (req, res) => {
  if (!isDeveloper(req)) {
    req.session.flash = '❌ Access denied.';
    return res.redirect('/raids');
  }

  const guildId = req.session.active_guild_id;
  if (!guildId) {
    req.session.flash = '❌ No active guild selected.';
    return res.redirect('/select-guild');
  }

  const { char_class, alias, canonical } = req.body;
  if (!char_class || !alias || !canonical) {
    req.session.flash = '❌ All fields are required.';
    return res.redirect('/admin/spec-aliases');
  }

  const cls = char_class.trim().toLowerCase();
  const al = alias.trim().toLowerCase();
  const can = canonical.trim();

  if (!WOW_CLASS_NAMES.includes(cls)) {
    req.session.flash = '❌ Invalid class.';
    return res.redirect('/admin/spec-aliases');
  }

  try {
    await pool.query(
      'INSERT INTO spec_aliases (guild_id, char_class, alias, canonical) VALUES (?, ?, ?, ?)',
      [guildId, cls, al, can]
    );
    req.session.flash = `✅ Alias "${al}" → "${can}" added for ${cls}.`;
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      req.session.flash = `❌ Alias "${al}" already exists for ${cls}.`;
    } else {
      throw err;
    }
  }

  res.redirect('/admin/spec-aliases');
});

// POST /admin/spec-aliases/delete
router.post('/spec-aliases/delete', express.urlencoded({ extended: false }), async (req, res) => {
  if (!isDeveloper(req)) {
    req.session.flash = '❌ Access denied.';
    return res.redirect('/raids');
  }

  const guildId = req.session.active_guild_id;
  if (!guildId) {
    req.session.flash = '❌ No active guild selected.';
    return res.redirect('/select-guild');
  }

  const id = parseInt(req.body.id, 10);
  if (isNaN(id)) {
    req.session.flash = '❌ Invalid alias ID.';
    return res.redirect('/admin/spec-aliases');
  }

  const [result] = await pool.query('DELETE FROM spec_aliases WHERE id = ? AND guild_id = ?', [
    id,
    guildId,
  ]);
  if (result.affectedRows === 0) {
    req.session.flash = '❌ Alias not found.';
  } else {
    req.session.flash = '✅ Alias removed.';
  }
  res.redirect('/admin/spec-aliases');
});

// POST /admin/seed-fake-players
router.post('/seed-fake-players', async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const guildId = req.session.active_guild_id;
  if (!guildId) {
    req.session.flash = '❌ No active guild selected.';
    return res.redirect('/raids');
  }

  const NUM_USERS = 25;
  const usedIds = new Set();
  let totalChars = 0;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    for (let i = 0; i < NUM_USERS; i++) {
      const fakeId = _randomFakeId(usedIds);
      const username = `FakeUser${_randInt(1000, 9999)}`;

      await conn.query(
        `INSERT INTO discord_users (discord_user_id, username, display_name, updated_at)
         VALUES (?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE username = VALUES(username), display_name = VALUES(display_name), updated_at = NOW()`,
        [fakeId, username, username]
      );

      const charCount = _randInt(2, 10);
      for (let j = 0; j < charCount; j++) {
        const { name: charClass, specs } = _WOW_CLASSES[_randInt(0, _WOW_CLASSES.length - 1)];
        const spec = specs[_randInt(0, specs.length - 1)];
        const role = _CLASS_SPEC_ROLES[`${charClass}.${spec}`] || 'dps';
        const gearscore = _randInt(4000, 6800);
        const realm = _REALMS[_randInt(0, _REALMS.length - 1)];
        const charName = _randomCharName(_randInt(5, 12));

        await conn.query(
          `INSERT INTO characters (discord_user_id, guild_id, char_name, realm, char_class, spec, role, gearscore, is_deleted, last_updated)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NOW())`,
          [fakeId, guildId, charName, realm, charClass, spec, role, gearscore]
        );
        totalChars++;
      }
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  req.session.flash = `✅ Seeded ${NUM_USERS} fake players with ${totalChars} characters total.`;
  res.redirect('/raids');
});

// POST /admin/seed-fake-signups/:raid_id
router.post('/seed-fake-signups/:raid_id', async (req, res) => {
  if (!requireAdmin(req, res)) return;

  if (process.env.DEV_MODE !== 'true') {
    req.session.flash = '❌ This action is only available in dev mode.';
    return res.redirect('/raids');
  }

  const raidId = parseInt(req.params.raid_id);
  if (isNaN(raidId)) {
    req.session.flash = '❌ Invalid raid ID.';
    return res.redirect('/raids');
  }

  const conn = await pool.getConnection();
  let createdUsers = 0;
  let totalChars = 0;
  try {
    const [[raid]] = await conn.query('SELECT id, guild_id FROM raids WHERE id = ?', [raidId]);
    if (!raid) {
      req.session.flash = '❌ Raid not found.';
      return res.redirect('/raids');
    }

    await conn.beginTransaction();

    const NUM_USERS = 25;
    const usedIds = new Set();

    for (let i = 0; i < NUM_USERS; i++) {
      const fakeId = _randomFakeId(usedIds);
      const username = `FakeUser${_randInt(1000, 9999)}`;

      await conn.query(
        `INSERT INTO discord_users (discord_user_id, username, display_name, updated_at)
         VALUES (?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE username = VALUES(username), display_name = VALUES(display_name), updated_at = NOW()`,
        [fakeId, username, username]
      );
      createdUsers++;

      const charCount = _randInt(2, 10);
      for (let j = 0; j < charCount; j++) {
        const { name: charClass, specs } = _WOW_CLASSES[_randInt(0, _WOW_CLASSES.length - 1)];
        const spec = specs[_randInt(0, specs.length - 1)];
        const role = _CLASS_SPEC_ROLES[`${charClass}.${spec}`] || 'dps';
        const gearscore = _randInt(4000, 6800);
        const realm = _REALMS[_randInt(0, _REALMS.length - 1)];
        const charName = _randomCharName(_randInt(5, 12));

        const [charResult] = await conn.query(
          `INSERT INTO characters (discord_user_id, guild_id, char_name, realm, char_class, spec, role, gearscore, is_deleted, last_updated)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NOW())`,
          [fakeId, raid.guild_id, charName, realm, charClass, spec, role, gearscore]
        );
        const charId = charResult.insertId;

        await conn.query(
          `INSERT INTO signups (raid_id, discord_user_id, character_id, signup_type, status, created_at)
           VALUES (?, ?, ?, 'fill', 'signed', NOW())`,
          [raidId, fakeId, charId]
        );
        totalChars++;
      }
    }

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  req.session.flash = `✅ Seeded ${createdUsers} fake players with ${totalChars} total character sign-ups for this raid.`;
  res.redirect(`/raids/${raidId}/manage`);
});

module.exports = router;
