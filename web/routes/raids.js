const express = require('express');
const pool = require('../db');

const router = express.Router();

function requireLogin(req, res) {
  if (!req.session.user_id) {
    res.redirect('/auth/login');
    return false;
  }
  return true;
}

function popFlash(req) {
  const msg = req.session.flash || null;
  delete req.session.flash;
  return msg;
}

function currentUser(req) {
  return { id: req.session.user_id, username: req.session.username };
}

// GET /raids
router.get('/', async (req, res) => {
  if (!requireLogin(req, res)) return;

  const [raids] = await pool.query(
    `SELECT r.*, COALESCE(s.player_count, 0) AS signup_count
     FROM raids r
     LEFT JOIN (
       SELECT raid_id, COUNT(DISTINCT discord_user_id) AS player_count FROM signups GROUP BY raid_id
     ) s ON s.raid_id = r.id
     ORDER BY (r.status = 'open') DESC, r.date ASC`
  );

  const raidData = raids.map(r => ({
    raid: r,
    signup_count: r.signup_count,
  }));

  res.render('raids_list.html', {
    raids: raidData,
    flash: popFlash(req),
    user: currentUser(req),
  });
});

// GET /raids/:raid_id
router.get('/:raid_id', async (req, res) => {
  if (!requireLogin(req, res)) return;

  const raidId = parseInt(req.params.raid_id);
  const userId = req.session.user_id;

  const [[raid]] = await pool.query('SELECT * FROM raids WHERE id = ?', [raidId]);
  if (!raid) return res.redirect('/raids');

  const [[{ signup_count }]] = await pool.query(
    'SELECT COUNT(*) AS signup_count FROM signups WHERE raid_id = ?',
    [raidId]
  );
  raid.signup_count = signup_count;

  const [userChars] = await pool.query(
    'SELECT * FROM characters WHERE discord_user_id = ?',
    [userId]
  );

  const [[mySignupRow]] = await pool.query(
    'SELECT s.*, c.id AS c_id, c.char_name, c.realm, c.char_class, c.spec, c.gearscore, c.role FROM signups s JOIN characters c ON s.character_id = c.id WHERE s.raid_id = ? AND s.discord_user_id = ?',
    [raidId, userId]
  );

  let mySignup = null;
  if (mySignupRow) {
    mySignup = {
      ...mySignupRow,
      character: {
        id: mySignupRow.c_id,
        char_name: mySignupRow.char_name,
        realm: mySignupRow.realm,
        char_class: mySignupRow.char_class,
        spec: mySignupRow.spec,
        gearscore: mySignupRow.gearscore,
        role: mySignupRow.role,
      },
    };
  }

  const [allSignups] = await pool.query(
    `SELECT s.*, c.id AS c_id, c.char_name, c.realm, c.char_class, c.spec, c.gearscore, c.role
     FROM signups s JOIN characters c ON s.character_id = c.id
     WHERE s.raid_id = ?`,
    [raidId]
  );

  const grouped = { fill: [], prio_role: [], prio_character: [] };
  for (const s of allSignups) {
    const signup = {
      ...s,
      character: {
        id: s.c_id,
        char_name: s.char_name,
        realm: s.realm,
        char_class: s.char_class,
        spec: s.spec,
        gearscore: s.gearscore,
        role: s.role,
      },
    };
    const key = s.signup_type || 'fill';
    if (grouped[key]) {
      grouped[key].push(signup);
    } else {
      grouped.fill.push(signup);
    }
  }

  res.render('raid_detail.html', {
    raid,
    user_chars: userChars,
    my_signup: mySignup,
    grouped_signups: grouped,
    signup_types: ['fill', 'prio_role', 'prio_character'],
    flash: popFlash(req),
    user: currentUser(req),
  });
});

// POST /raids/:raid_id/signup
router.post('/:raid_id/signup', express.urlencoded({ extended: false }), async (req, res) => {
  if (!requireLogin(req, res)) return;

  const raidId = parseInt(req.params.raid_id);
  const userId = req.session.user_id;
  const { character_id, signup_type = 'fill' } = req.body;

  const [[raid]] = await pool.query('SELECT * FROM raids WHERE id = ?', [raidId]);
  if (!raid || raid.status !== 'open') {
    req.session.flash = '❌ Raid is not open for sign-ups.';
    return res.redirect(`/raids/${raidId}`);
  }

  const validTypes = ['fill', 'prio_role', 'prio_character'];
  const stype = validTypes.includes(signup_type) ? signup_type : 'fill';

  const [[existing]] = await pool.query(
    'SELECT id FROM signups WHERE raid_id = ? AND discord_user_id = ?',
    [raidId, userId]
  );

  if (existing) {
    await pool.query(
      "UPDATE signups SET character_id = ?, signup_type = ?, status = 'signed' WHERE id = ?",
      [parseInt(character_id), stype, existing.id]
    );
  } else {
    await pool.query(
      "INSERT INTO signups (raid_id, discord_user_id, character_id, signup_type, status) VALUES (?, ?, ?, ?, 'signed')",
      [raidId, userId, parseInt(character_id), stype]
    );
  }

  req.session.flash = '✅ Signed up!';
  res.redirect(`/raids/${raidId}`);
});

// POST /raids/:raid_id/withdraw
router.post('/:raid_id/withdraw', async (req, res) => {
  if (!requireLogin(req, res)) return;

  const raidId = parseInt(req.params.raid_id);
  const userId = req.session.user_id;

  const [[existing]] = await pool.query(
    'SELECT id FROM signups WHERE raid_id = ? AND discord_user_id = ?',
    [raidId, userId]
  );

  if (existing) {
    await pool.query('DELETE FROM signups WHERE id = ?', [existing.id]);
    req.session.flash = '✅ Withdrawn from raid.';
  } else {
    req.session.flash = 'You were not signed up.';
  }

  res.redirect(`/raids/${raidId}`);
});

// GET /raids/:raid_id/manage
router.get('/:raid_id/manage', async (req, res) => {
  if (!requireLogin(req, res)) return;

  const raidId = parseInt(req.params.raid_id);

  const [[raid]] = await pool.query('SELECT * FROM raids WHERE id = ?', [raidId]);
  if (!raid) return res.redirect('/raids');

  const [allSignups] = await pool.query(
    `SELECT s.*, c.id AS c_id, c.char_name, c.realm, c.char_class, c.spec, c.gearscore, c.role
     FROM signups s JOIN characters c ON s.character_id = c.id
     WHERE s.raid_id = ?`,
    [raidId]
  );

  const signups = allSignups.map(s => ({
    ...s,
    character: {
      id: s.c_id,
      char_name: s.char_name,
      realm: s.realm,
      char_class: s.char_class,
      spec: s.spec,
      gearscore: s.gearscore,
      role: s.role,
    },
  }));

  // Group signups by discord user for the pool panel
  const userSignupMap = {};
  for (const s of signups) {
    const uid = String(s.discord_user_id);
    if (!userSignupMap[uid]) {
      userSignupMap[uid] = { discord_user_id: uid, characters: [] };
    }
    userSignupMap[uid].characters.push(s);
  }
  const signupsByUser = Object.values(userSignupMap);

  const [existingComp] = await pool.query(
    'SELECT * FROM compositions WHERE raid_id = ?',
    [raidId]
  );
  const compMap = {};
  for (const c of existingComp) {
    compMap[c.role_slot] = String(c.character_id);
  }

  const maxSize = raid.max_size || 25;
  const tanks = Math.max(2, Math.floor(maxSize / 10));
  const healers = Math.max(4, Math.floor(maxSize / 5));
  const dpsSlots = maxSize - tanks - healers;

  const slots = [
    ...[...Array(tanks).keys()].map(i => `tank_${i + 1}`),
    ...[...Array(healers).keys()].map(i => `healer_${i + 1}`),
    ...[...Array(dpsSlots).keys()].map(i => `dps_${i + 1}`),
  ];

  res.render('raid_manage.html', {
    raid,
    signups,
    signupsByUser,
    slots,
    comp_map: compMap,
    flash: popFlash(req),
    user: currentUser(req),
  });
});

// POST /raids/:raid_id/manage (JSON body)
router.post('/:raid_id/manage', express.json(), async (req, res) => {
  if (!requireLogin(req, res)) return;

  const raidId = parseInt(req.params.raid_id);
  const userId = req.session.user_id;
  const body = req.body;

  if (!Array.isArray(body)) {
    return res.json({ ok: false, error: 'Body must be a list of {character_id, role_slot} entries.' });
  }

  for (const entry of body) {
    if (
      typeof entry !== 'object' ||
      !('character_id' in entry) ||
      !('role_slot' in entry)
    ) {
      return res.json({ ok: false, error: 'Each entry must have character_id and role_slot fields.' });
    }
    if (isNaN(parseInt(entry.character_id))) {
      return res.json({ ok: false, error: `Invalid character_id: ${entry.character_id}` });
    }
  }

  if (body.length > 0) {
    // Validate: each Discord user may only appear once in the composition
    const charIds = body.map(e => parseInt(e.character_id));
    const placeholders = charIds.map(() => '?').join(', ');
    const [chars] = await pool.query(
      `SELECT id, discord_user_id FROM characters WHERE id IN (${placeholders})`,
      charIds
    );
    const seenUsers = new Set();
    for (const char of chars) {
      const uid = String(char.discord_user_id);
      if (seenUsers.has(uid)) {
        return res.json({ ok: false, error: 'Each Discord user can only have one character in the raid composition. Please remove duplicate assignments.' });
      }
      seenUsers.add(uid);
    }
  }

  await pool.query('DELETE FROM compositions WHERE raid_id = ?', [raidId]);

  for (const entry of body) {
    await pool.query(
      'INSERT INTO compositions (raid_id, character_id, role_slot, created_by, created_at) VALUES (?, ?, ?, ?, NOW())',
      [raidId, parseInt(entry.character_id), entry.role_slot, userId]
    );
  }

  res.json({ ok: true });
});

// GET /raids/:raid_id/comp
router.get('/:raid_id/comp', async (req, res) => {
  if (!requireLogin(req, res)) return;

  const raidId = parseInt(req.params.raid_id);

  const [[raid]] = await pool.query('SELECT * FROM raids WHERE id = ?', [raidId]);
  if (!raid) return res.redirect('/raids');

  const [comps] = await pool.query(
    `SELECT co.*, c.id AS c_id, c.char_name, c.realm, c.char_class, c.spec, c.gearscore, c.role, c.discord_user_id AS char_discord_user_id
     FROM compositions co JOIN characters c ON co.character_id = c.id
     WHERE co.raid_id = ?
     ORDER BY co.role_slot`,
    [raidId]
  );

  const groups = { tank: [], healer: [], dps: [] };
  for (const comp of comps) {
    const entry = {
      ...comp,
      character: {
        id: comp.c_id,
        char_name: comp.char_name,
        realm: comp.realm,
        char_class: comp.char_class,
        spec: comp.spec,
        gearscore: comp.gearscore,
        role: comp.role,
        discord_user_id: comp.char_discord_user_id,
      },
    };
    const prefix = comp.role_slot.split('_')[0];
    if (groups[prefix]) {
      groups[prefix].push(entry);
    } else {
      groups[prefix] = [entry];
    }
  }

  res.render('raid_comp.html', {
    raid,
    groups,
    flash: popFlash(req),
    user: currentUser(req),
  });
});

// POST /raids/:raid_id/lock
router.post('/:raid_id/lock', async (req, res) => {
  if (!requireLogin(req, res)) return;

  const raidId = parseInt(req.params.raid_id);
  const [[raid]] = await pool.query('SELECT * FROM raids WHERE id = ?', [raidId]);

  if (raid) {
    await pool.query("UPDATE raids SET status = 'locked' WHERE id = ?", [raidId]);
    req.session.flash = `🔒 Raid '${raid.name}' locked.`;
  }

  res.redirect(`/raids/${raidId}/manage`);
});

// POST /raids/:raid_id/post_comp
router.post('/:raid_id/post_comp', async (req, res) => {
  if (!requireLogin(req, res)) return;

  const raidId = parseInt(req.params.raid_id);
  const [[raid]] = await pool.query('SELECT * FROM raids WHERE id = ?', [raidId]);

  if (raid) {
    await pool.query("UPDATE raids SET status = 'posted' WHERE id = ?", [raidId]);
    req.session.flash = `📋 Raid '${raid.name}' marked as posted.`;
  }

  res.redirect(`/raids/${raidId}/comp`);
});

module.exports = router;
