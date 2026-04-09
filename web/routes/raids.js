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

  const [[{ player_count }]] = await pool.query(
    'SELECT COUNT(DISTINCT discord_user_id) AS player_count FROM signups WHERE raid_id = ?',
    [raidId]
  );
  raid.signup_count = player_count;

  const [userChars] = await pool.query(
    'SELECT * FROM characters WHERE discord_user_id = ?',
    [userId]
  );

  // Fetch ALL signups for this user in this raid (one per character/spec)
  const [mySignupRows] = await pool.query(
    `SELECT s.*, c.id AS c_id, c.char_name, c.realm, c.char_class, c.spec, c.gearscore, c.role
     FROM signups s JOIN characters c ON s.character_id = c.id
     WHERE s.raid_id = ? AND s.discord_user_id = ?`,
    [raidId, userId]
  );

  // Build a map of character_id -> signup for easy template lookup
  const mySignupMap = {};
  for (const row of mySignupRows) {
    mySignupMap[String(row.character_id)] = {
      signup_type: row.signup_type,
      status: row.status,
    };
  }

  // Group user's characters by char_name so each character shows once with all specs
  const charGroupMap = {};
  for (const c of userChars) {
    if (!charGroupMap[c.char_name]) {
      charGroupMap[c.char_name] = {
        char_name: c.char_name,
        char_class: c.char_class,
        specs: [],
      };
    }
    charGroupMap[c.char_name].specs.push({
      id: c.id,
      spec: c.spec,
      gearscore: c.gearscore,
      role: c.role,
    });
  }
  const userCharGroups = Object.values(charGroupMap).map(g => {
    const is_signed = g.specs.some(s => mySignupMap[String(s.id)] !== undefined);
    const is_prio   = g.specs.some(s => mySignupMap[String(s.id)]?.signup_type === 'prio_character');
    return { ...g, is_signed, is_prio };
  });

  const [allSignups] = await pool.query(
    `SELECT s.*, c.id AS c_id, c.char_name, c.realm, c.char_class, c.spec, c.gearscore, c.role
     FROM signups s JOIN characters c ON s.character_id = c.id
     WHERE s.raid_id = ?`,
    [raidId]
  );

  // Merge signups by (discord_user_id + char_name) within each signup_type bucket
  const grouped = { fill: [], prio_role: [], prio_character: [] };
  for (const s of allSignups) {
    const key = s.signup_type || 'fill';
    const bucket = grouped[key] || grouped.fill;
    const mergeKey = `${s.discord_user_id}__${s.char_name}`;
    const existing = bucket.find(e => e._mergeKey === mergeKey);
    if (existing) {
      existing.character.specs.push({ spec: s.spec, gearscore: s.gearscore });
    } else {
      bucket.push({
        ...s,
        _mergeKey: mergeKey,
        discord_user_id: s.discord_user_id,
        character: {
          id: s.c_id,
          char_name: s.char_name,
          realm: s.realm,
          char_class: s.char_class,
          role: s.role,
          specs: [{ spec: s.spec, gearscore: s.gearscore }],
        },
      });
    }
  }

  res.render('raid_detail.html', {
    raid,
    user_char_groups: userCharGroups,
    my_signup_map: mySignupMap,
    my_signup_count: mySignupRows.length,
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

  const [[raid]] = await pool.query('SELECT * FROM raids WHERE id = ?', [raidId]);
  if (!raid || raid.status !== 'open') {
    req.session.flash = '❌ Raid is not open for sign-ups.';
    return res.redirect(`/raids/${raidId}`);
  }

  // Support multi-select: character_ids[] and priority_ids[]
  let characterIds = req.body.character_ids || req.body.character_id;
  if (!Array.isArray(characterIds)) {
    characterIds = characterIds ? [characterIds] : [];
  }
  characterIds = characterIds.map(id => parseInt(id)).filter(id => !isNaN(id));

  let priorityIds = req.body.priority_ids || [];
  if (!Array.isArray(priorityIds)) {
    priorityIds = [priorityIds];
  }
  const prioritySet = new Set(priorityIds.map(id => parseInt(id)));

  if (characterIds.length === 0) {
    req.session.flash = '❌ Please select at least one character.';
    return res.redirect(`/raids/${raidId}`);
  }

  // Verify all selected characters belong to this user
  if (characterIds.length > 0) {
    const placeholders = characterIds.map(() => '?').join(', ');
    const [owned] = await pool.query(
      `SELECT id FROM characters WHERE id IN (${placeholders}) AND discord_user_id = ?`,
      [...characterIds, userId]
    );
    if (owned.length !== characterIds.length) {
      req.session.flash = '❌ Invalid character selection.';
      return res.redirect(`/raids/${raidId}`);
    }
  }

  // Delete all existing signups for this user in this raid, then re-insert
  await pool.query('DELETE FROM signups WHERE raid_id = ? AND discord_user_id = ?', [raidId, userId]);

  for (const charId of characterIds) {
    const stype = prioritySet.has(charId) ? 'prio_character' : 'fill';
    await pool.query(
      "INSERT INTO signups (raid_id, discord_user_id, character_id, signup_type, status) VALUES (?, ?, ?, ?, 'signed')",
      [raidId, userId, charId, stype]
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

  const [result] = await pool.query(
    'DELETE FROM signups WHERE raid_id = ? AND discord_user_id = ?',
    [raidId, userId]
  );

  if (result.affectedRows > 0) {
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
    `SELECT s.*, c.id AS c_id, c.char_name, c.realm, c.char_class, c.spec, c.gearscore, c.role,
            du.username AS du_username, du.display_name AS du_display_name
     FROM signups s
     JOIN characters c ON s.character_id = c.id
     LEFT JOIN discord_users du ON du.discord_user_id = s.discord_user_id
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

  // Group signups by discord user, then by char_name within each user
  const userSignupMap = {};
  for (const s of signups) {
    const uid = String(s.discord_user_id);
    if (!userSignupMap[uid]) {
      let label;
      if (s.du_username && s.du_display_name && s.du_display_name !== s.du_username) {
        label = `${s.du_username} – ${s.du_display_name}`;
      } else if (s.du_username) {
        label = s.du_username;
      } else {
        label = uid;
      }
      userSignupMap[uid] = { discord_user_id: uid, display_label: label, characters: [] };
    }

    // Find or create a character group by char_name
    let charGroup = userSignupMap[uid].characters.find(cg => cg.char_name === s.character.char_name);
    if (!charGroup) {
      charGroup = {
        char_name: s.character.char_name,
        char_class: s.character.char_class,
        discord_user_id: uid,
        signup_type: s.signup_type,
        specs: [],
      };
      userSignupMap[uid].characters.push(charGroup);
    }
    charGroup.specs.push({
      character_id: s.character.id,
      spec: s.character.spec,
      gearscore: s.character.gearscore,
      role: s.character.role,
    });
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

  // Build compBySlot: slot_number -> { char_id, role }
  // Existing comp entries use role_slot like "tank_1", "healer_3", "dps_5"
  const compBySlot = {};
  for (const [roleSlot, charId] of Object.entries(compMap)) {
    const match = roleSlot.match(/^(tank|healer|dps)_(\d+)$/);
    if (match) {
      const num = parseInt(match[2]);
      if (num >= 1 && num <= maxSize) {
        compBySlot[num] = { char_id: charId, role: match[1] };
      }
    }
  }

  // Build slots array: "role_number" strings for each slot 1..maxSize
  // Use the role from existing comp data if present, otherwise default to 'dps'
  const slots = [];
  for (let i = 1; i <= maxSize; i++) {
    const role = compBySlot[i] ? compBySlot[i].role : 'dps';
    slots.push(`${role}_${i}`);
  }

  res.render('raid_manage.html', {
    raid,
    signups,
    signupsByUser,
    slots,
    comp_map: compMap,
    max_size: maxSize,
    comp_by_slot: compBySlot,
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
