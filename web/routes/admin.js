const express = require('express');
const pool = require('../db');

const router = express.Router();

const _WOW_CLASSES = [
  { name: 'Death Knight', specs: ['Blood', 'Frost', 'Unholy'] },
  { name: 'Druid',        specs: ['Balance', 'Feral (Cat)', 'Feral (Bear)', 'Restoration'] },
  { name: 'Hunter',       specs: ['Beast Mastery', 'Marksmanship', 'Survival'] },
  { name: 'Mage',         specs: ['Arcane', 'Fire', 'Frost'] },
  { name: 'Paladin',      specs: ['Holy', 'Protection', 'Retribution'] },
  { name: 'Priest',       specs: ['Discipline', 'Holy', 'Shadow'] },
  { name: 'Rogue',        specs: ['Assassination', 'Combat', 'Subtlety'] },
  { name: 'Shaman',       specs: ['Elemental', 'Enhancement', 'Restoration'] },
  { name: 'Warlock',      specs: ['Affliction', 'Demonology', 'Destruction'] },
  { name: 'Warrior',      specs: ['Arms', 'Fury', 'Protection'] },
];

const _CLASS_SPEC_ROLES = {
  'Death Knight.Blood':       'tank',
  'Death Knight.Frost':       'dps',
  'Death Knight.Unholy':      'dps',
  'Druid.Balance':            'dps',
  'Druid.Feral (Cat)':        'dps',
  'Druid.Feral (Bear)':       'tank',
  'Druid.Restoration':        'healer',
  'Hunter.Beast Mastery':     'dps',
  'Hunter.Marksmanship':      'dps',
  'Hunter.Survival':          'dps',
  'Mage.Arcane':              'dps',
  'Mage.Fire':                'dps',
  'Mage.Frost':               'dps',
  'Paladin.Holy':             'healer',
  'Paladin.Protection':       'tank',
  'Paladin.Retribution':      'dps',
  'Priest.Discipline':        'healer',
  'Priest.Holy':              'healer',
  'Priest.Shadow':            'dps',
  'Rogue.Assassination':      'dps',
  'Rogue.Combat':             'dps',
  'Rogue.Subtlety':           'dps',
  'Shaman.Elemental':         'dps',
  'Shaman.Enhancement':       'dps',
  'Shaman.Restoration':       'healer',
  'Warlock.Affliction':       'dps',
  'Warlock.Demonology':       'dps',
  'Warlock.Destruction':      'dps',
  'Warrior.Arms':             'dps',
  'Warrior.Fury':             'dps',
  'Warrior.Protection':       'tank',
};

const _REALMS = ['Icecrown', 'Lordaeron', 'Frostmourne'];

const _FAKE_USER_ID_MIN = BigInt('10000000000000000');
const _FAKE_USER_ID_MAX = BigInt('999999999999999999');

function _randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function _randomCharName(length) {
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  let name = upper[_randInt(0, upper.length - 1)];
  for (let i = 1; i < length; i++) {
    name += lower[_randInt(0, lower.length - 1)];
  }
  return name;
}

function _randomFakeId(usedIds) {
  const range = _FAKE_USER_ID_MAX - _FAKE_USER_ID_MIN + BigInt(1);
  while (true) {
    const rand = _FAKE_USER_ID_MIN + BigInt(Math.floor(Math.random() * Number(range)));
    const key = rand.toString();
    if (!usedIds.has(key)) {
      usedIds.add(key);
      return key;
    }
  }
}

function requireAdmin(req, res) {
  if (!req.session.user_id) {
    req.session.next_url = req.originalUrl;
    res.redirect('/auth/login');
    return false;
  }
  if (req.session.is_admin === false) {
    req.session.flash = '❌ You do not have permission to perform this action.';
    res.redirect('/raids');
    return false;
  }
  return true;
}

// lowercase class names used for spec aliases management
const WOW_CLASS_NAMES = _WOW_CLASSES.map(c => c.name.toLowerCase());

// GET /admin/spec-aliases — viewable by developers only
router.get('/spec-aliases', async (req, res) => {
  const devUserId = process.env.DEV_USER_ID || '';
  if (!devUserId || !req.session.user_id || req.session.user_id !== devUserId) {
    req.session.flash = '❌ Access denied. This page is only available to developers.';
    return res.redirect('/raids');
  }

  const [rows] = await pool.query(
    'SELECT id, char_class, alias, canonical FROM spec_aliases ORDER BY char_class, alias'
  );

  // Group by class
  const byClass = {};
  for (const cls of WOW_CLASS_NAMES) byClass[cls] = [];
  for (const row of rows) {
    if (!byClass[row.char_class]) byClass[row.char_class] = [];
    byClass[row.char_class].push(row);
  }

  const flash = req.session.flash;
  delete req.session.flash;

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
  const devUserId = process.env.DEV_USER_ID || '';
  if (!devUserId || !req.session.user_id || req.session.user_id !== devUserId) {
    req.session.flash = '❌ Access denied.';
    return res.redirect('/raids');
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
      'INSERT INTO spec_aliases (char_class, alias, canonical) VALUES (?, ?, ?)',
      [cls, al, can]
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
  const devUserId = process.env.DEV_USER_ID || '';
  if (!devUserId || !req.session.user_id || req.session.user_id !== devUserId) {
    req.session.flash = '❌ Access denied.';
    return res.redirect('/raids');
  }

  const id = parseInt(req.body.id, 10);
  if (isNaN(id)) {
    req.session.flash = '❌ Invalid alias ID.';
    return res.redirect('/admin/spec-aliases');
  }

  const [result] = await pool.query('DELETE FROM spec_aliases WHERE id = ?', [id]);
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
          `INSERT INTO characters (discord_user_id, char_name, realm, char_class, spec, role, gearscore, is_deleted, last_updated)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, NOW())`,
          [fakeId, charName, realm, charClass, spec, role, gearscore]
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
    const [[raid]] = await conn.query('SELECT id FROM raids WHERE id = ?', [raidId]);
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
          `INSERT INTO characters (discord_user_id, char_name, realm, char_class, spec, role, gearscore, is_deleted, last_updated)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, NOW())`,
          [fakeId, charName, realm, charClass, spec, role, gearscore]
        );
        const charId = charResult.insertId;

        await conn.query(
          `INSERT INTO signups (raid_id, discord_user_id, character_id, signup_type, status)
           VALUES (?, ?, ?, 'fill', 'signed')`,
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
