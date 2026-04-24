const express = require('express');
const fetch = require('node-fetch');
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

// GET /admin/all-characters — viewable by developers only
router.get('/all-characters', async (req, res) => {
  const devUserId = process.env.DEV_USER_ID || '';
  if (!devUserId || !req.session.user_id || req.session.user_id !== devUserId) {
    req.session.flash = '❌ Access denied. This page is only available to developers.';
    return res.redirect('/raids');
  }

  // Fetch all characters and their owner's info
  const [rows] = await pool.query(
    `SELECT c.*, du.username as discord_username, du.display_name as discord_display_name
     FROM characters c
     LEFT JOIN discord_users du ON c.discord_user_id = du.discord_user_id
     WHERE c.is_deleted = 0
     ORDER BY du.username ASC, c.char_name ASC`
  );

  // Group by user
  const byUser = {};
  for (const row of rows) {
    const userId = row.discord_user_id;
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

  const flash = req.session.flash;
  delete req.session.flash;

  res.render('admin_all_characters.html', {
    users: Object.values(byUser),
    flash,
    user: req.session.user_id
      ? { id: req.session.user_id, username: req.session.username, is_admin: req.session.is_admin }
      : null,
  });
});

// POST /admin/suggest-character-change
router.post('/suggest-character-change', express.urlencoded({ extended: false }), async (req, res) => {
  const devUserId = process.env.DEV_USER_ID || '';
  // For now, only dev can suggest via this route, though plan mentioned officers too.
  // We'll stick to dev for "all characters" and maybe add officers later if needed.
  if (!devUserId || !req.session.user_id || req.session.user_id !== devUserId) {
    req.session.flash = '❌ Access denied.';
    return res.redirect('/raids');
  }

  const { char_id, char_class, spec, gearscore } = req.body;
  const charId = parseInt(char_id);
  if (isNaN(charId)) {
    req.session.flash = '❌ Invalid character ID.';
    return res.redirect('/admin/all-characters');
  }

  const gs = gearscore ? parseFloat(gearscore) : null;

  try {
    const [[char]] = await pool.query(
      'SELECT c.*, du.username FROM characters c JOIN discord_users du ON c.discord_user_id = du.discord_user_id WHERE c.id = ?',
      [charId]
    );

    if (!char) {
      req.session.flash = '❌ Character not found.';
      return res.redirect('/admin/all-characters');
    }

    const [result] = await pool.query(
      `INSERT INTO character_suggestions (character_id, suggested_by, new_char_class, new_spec, new_gearscore)
       VALUES (?, ?, ?, ?, ?)`,
      [charId, req.session.user_id, char_class || null, spec || null, isNaN(gs) ? null : gs]
    );
    const suggestionId = result.insertId;

    // Trigger Discord Bot DM
    const botToken = process.env.DISCORD_BOT_TOKEN;
    if (botToken) {
      // 1. Create DM channel
      const dmChannelRes = await fetch('https://discord.com/api/v10/users/@me/channels', {
        method: 'POST',
        headers: {
          'Authorization': `Bot ${botToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ recipient_id: char.discord_user_id })
      });

      if (dmChannelRes.ok) {
        const dmChannel = await dmChannelRes.json();

        // 2. Send message with buttons
        const suggesterName = req.session.username;
        let changeText = '';
        if (char_class && char_class !== char.char_class) changeText += `\n- Class: ${char.char_class} ➡️ ${char_class}`;
        if (spec && spec !== char.spec) changeText += `\n- Spec: ${char.spec || 'None'} ➡️ ${spec}`;
        if (gs && gs !== char.gearscore) changeText += `\n- GS: ${char.gearscore || 0} ➡️ ${gs}`;

        await fetch(`https://discord.com/api/v10/channels/${dmChannel.id}/messages`, {
          method: 'POST',
          headers: {
            'Authorization': `Bot ${botToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            content: `👋 **${suggesterName}** suggested a change for your character **${char.char_name}**:${changeText}`,
            components: [
              {
                type: 1,
                components: [
                  {
                    type: 2,
                    label: 'Accept',
                    style: 3, // Success (green)
                    custom_id: `suggest_accept_${suggestionId}`
                  },
                  {
                    type: 2,
                    label: 'Deny',
                    style: 4, // Danger (red)
                    custom_id: `suggest_deny_${suggestionId}`
                  }
                ]
              }
            ]
          })
        });
      }
    }

    req.session.flash = `✅ Suggestion sent to ${char.username} for ${char.char_name}.`;
  } catch (err) {
    console.error('Failed to send suggestion:', err);
    req.session.flash = '❌ Failed to send suggestion.';
  }

  res.redirect('/admin/all-characters');
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
