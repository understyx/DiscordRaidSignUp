const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const pool = require('../db');
const { resolveIsAdmin } = require('./adminCheck');

// Load WotLK buff definitions once at startup
const WOTLK_BUFFS = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'wotlk_buffs.json'), 'utf8')
);

const DISCORD_API = 'https://discord.com/api/v10';

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
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `Network error: ${err.message}` };
  }
}

async function fetchCompLabels(raidId) {
  const [rows] = await pool.query(
    'SELECT comp_number, label FROM comp_labels WHERE raid_id = ?',
    [raidId]
  );
  const map = {};
  for (const r of rows) map[r.comp_number] = r.label;
  return map;
}

function compTabLabel(compNumber, compLabels) {
  return (compLabels && compLabels[compNumber]) || `Raid ${compNumber}`;
}

/**
 * Collect unique Discord user IDs (in order of appearance) from all role groups.
 */
function collectUniqueUserIds(groups) {
  const seen = new Set();
  const ids = [];
  for (const roleKey of ['tank', 'healer', 'dps']) {
    for (const e of groups[roleKey] || []) {
      if (!e.is_placeholder && e.character && e.character.discord_user_id) {
        const id = e.character.discord_user_id;
        if (!seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      }
    }
  }
  return ids;
}

function buildCompEmbed(raid, groups, compNumber, totalComps, compLabels) {
  const label = compTabLabel(compNumber, compLabels);
  const compLabel = totalComps > 1 ? ` – ${label}` : '';
  const dateStr = raid.date instanceof Date
    ? raid.date.toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
    : String(raid.date).slice(0, 16) + ' UTC';

  const fields = [];

  for (const [roleKey, roleLabel] of [
    ['tank', '🛡️ Tanks'],
    ['healer', '💚 Healers'],
    ['dps', '⚔️ DPS'],
  ]) {
    const entries = groups[roleKey] || [];
    if (entries.length === 0) continue;
    const lines = entries.map(e => {
      if (e.is_placeholder) return `*${e.placeholder_text || '?'}*`;
      const c = e.character;
      const mention = c.discord_user_id ? ` <@${c.discord_user_id}>` : '';
      return `**${c.char_name}** — ${c.spec || c.char_class || '?'}${mention}`;
    });
    fields.push({
      name: `${roleLabel} [${entries.length}]`,
      value: lines.join('\n') || '—',
      inline: false,
    });
  }

  // Collect unique user IDs so pings in the message content trigger real notifications.
  const allIds = collectUniqueUserIds(groups);
  const content = allIds.map(id => `<@${id}>`).join(' ');

  return {
    content: content || undefined,
    embeds: [
      {
        title: `📋 ${raid.name}${compLabel}`,
        description: `**${raid.raid_instance}** | ${dateStr}`,
        color: 0xe6cc80,
        fields,
        footer: { text: `Raid ID: ${raid.id}` },
      },
    ],
  };
}

const router = express.Router();

// Re-evaluate admin status on every request so that role changes take effect
// immediately without requiring users to log out and back in.
router.use(async (req, res, next) => {
  if (req.session.user_id) {
    try {
      req.session.is_admin = await resolveIsAdmin(req.session.user_id);
    } catch (err) {
      // Keep the existing cached value on transient errors, but log for debugging.
      console.warn('[adminCheck] Failed to refresh admin status for user %s:', req.session.user_id, err.message || err);
    }
  }
  next();
});

function requireLogin(req, res) {
  if (!req.session.user_id) {
    req.session.next_url = req.originalUrl;
    res.redirect('/auth/login');
    return false;
  }
  return true;
}

function requireAdmin(req, res) {
  if (!req.session.user_id) {
    req.session.next_url = req.originalUrl;
    res.redirect('/auth/login');
    return false;
  }
  // is_admin defaults to true when undefined (e.g. old sessions before feature was added)
  if (req.session.is_admin === false) {
    req.session.flash = '❌ You do not have permission to perform this action.';
    res.redirect('/raids');
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
  return {
    id: req.session.user_id,
    username: req.session.username,
    is_admin: req.session.is_admin !== false,
  };
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
     ORDER BY r.id DESC`
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

// GET /raids/admin-roles — manage which Discord roles have raid-admin access
router.get('/admin-roles', async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const guildId = process.env.DISCORD_GUILD_ID;
  const botToken = process.env.DISCORD_BOT_TOKEN;

  // Fetch currently configured admin roles from DB
  let configuredRoles = [];
  if (guildId) {
    const [rows] = await pool.query(
      'SELECT role_id FROM guild_admin_roles WHERE guild_id = ?',
      [guildId]
    );
    configuredRoles = rows.map(r => String(r.role_id));
  }

  // Fetch available guild roles from Discord API
  let guildRoles = [];
  if (guildId && botToken) {
    try {
      const resp = await fetch(`${DISCORD_API}/guilds/${guildId}/roles`, {
        headers: { Authorization: `Bot ${botToken}` },
      });
      if (resp.ok) {
        const roles = await resp.json();
        // Exclude the @everyone role (same id as guild_id) and sort by position desc
        guildRoles = roles
          .filter(r => r.id !== guildId)
          .sort((a, b) => b.position - a.position)
          .map(r => ({
            id: r.id,
            name: r.name,
            color_hex: r.color ? r.color.toString(16).padStart(6, '0') : null,
          }));
      } else {
        console.warn(`[admin-roles] Discord API returned ${resp.status} when fetching guild roles for guild ${guildId}`);
      }
    } catch (_err) {
      console.warn('[admin-roles] Failed to fetch guild roles from Discord:', _err.message || _err);
    }
  }

  res.render('admin_roles.html', {
    guild_id: guildId || null,
    configured_role_ids: configuredRoles,
    guild_roles: guildRoles,
    guild_roles_map: Object.fromEntries(guildRoles.map(r => [r.id, r])),
    flash: popFlash(req),
    user: currentUser(req),
  });
});

// POST /raids/admin-roles/add — add a role to guild_admin_roles
router.post('/admin-roles/add', express.urlencoded({ extended: false }), async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) {
    req.session.flash = '❌ DISCORD_GUILD_ID is not configured.';
    return res.redirect('/raids/admin-roles');
  }

  const roleId = String(req.body.role_id || '').trim();
  if (!roleId || !/^\d+$/.test(roleId)) {
    req.session.flash = '❌ Invalid role ID.';
    return res.redirect('/raids/admin-roles');
  }

  await pool.query(
    'INSERT IGNORE INTO guild_admin_roles (guild_id, role_id) VALUES (?, ?)',
    [guildId, roleId]
  );

  req.session.flash = '✅ Role added to admin roles.';
  res.redirect('/raids/admin-roles');
});

// POST /raids/admin-roles/remove — remove a role from guild_admin_roles
router.post('/admin-roles/remove', express.urlencoded({ extended: false }), async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) {
    req.session.flash = '❌ DISCORD_GUILD_ID is not configured.';
    return res.redirect('/raids/admin-roles');
  }

  const roleId = String(req.body.role_id || '').trim();
  if (!roleId || !/^\d+$/.test(roleId)) {
    req.session.flash = '❌ Invalid role ID.';
    return res.redirect('/raids/admin-roles');
  }

  await pool.query(
    'DELETE FROM guild_admin_roles WHERE guild_id = ? AND role_id = ?',
    [guildId, roleId]
  );

  req.session.flash = '✅ Role removed from admin roles.';
  res.redirect('/raids/admin-roles');
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

  // Merge signups by (discord_user_id + char_name) within each bucket.
  // Tentative signups go into their own bucket regardless of signup_type.
  const grouped = { fill: [], prio_role: [], prio_character: [], tentative: [] };
  for (const s of allSignups) {
    let bucket;
    if (s.status === 'tentative') {
      bucket = grouped.tentative;
    } else {
      const key = s.signup_type || 'fill';
      bucket = grouped[key] || grouped.fill;
    }
    const mergeKey = `${s.discord_user_id}__${s.char_name}`;
    const existing = bucket.find(e => e._mergeKey === mergeKey);
    const is_prio = s.signup_type === 'prio_character' || s.signup_type === 'prio_role';
    const is_saved = !!s.is_saved;
    if (existing) {
      existing.character.specs.push({ spec: s.spec, gearscore: s.gearscore, is_prio, is_saved });
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
          specs: [{ spec: s.spec, gearscore: s.gearscore, is_prio, is_saved }],
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
  const canEdit = req.session.is_admin !== false;

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

  // Build a direct character_id → signup lookup for the roster slot rendering
  const signupByCharId = {};
  for (const s of signups) {
    signupByCharId[String(s.character.id)] = s;
  }

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
      userSignupMap[uid] = { discord_user_id: uid, display_label: label, is_tentative: false, characters: [] };
    }

    // Tentative is a user-level flag: true if any of the user's signups is tentative
    if (s.status === 'tentative') {
      userSignupMap[uid].is_tentative = true;
    }

    // Skip specs/characters that are already saved this lockout — they are not
    // available for the raid and would only add clutter to the pool.
    if (s.is_saved) continue;

    // Find or create a character group by char_name
    let charGroup = userSignupMap[uid].characters.find(cg => cg.char_name === s.character.char_name);
    if (!charGroup) {
      charGroup = {
        char_name: s.character.char_name,
        char_class: s.character.char_class,
        discord_user_id: uid,
        note: s.note || '',
        specs: [],
      };
      userSignupMap[uid].characters.push(charGroup);
    }
    charGroup.specs.push({
      character_id: s.character.id,
      spec: s.character.spec,
      gearscore: s.character.gearscore,
      role: s.character.role,
      is_prio: s.signup_type === 'prio_character' || s.signup_type === 'prio_role',
    });
  }

  // Remove user groups that have no remaining (non-saved) characters.
  for (const uid of Object.keys(userSignupMap)) {
    if (userSignupMap[uid].characters.length === 0) delete userSignupMap[uid];
  }
  const signupsByUser = Object.values(userSignupMap);

  // Sort: players with starred (prio) characters first, tentative players last
  signupsByUser.sort((a, b) => {
    const aPrio = a.characters.some(cg => cg.specs.some(s => s.is_prio));
    const bPrio = b.characters.some(cg => cg.specs.some(s => s.is_prio));
    if (a.is_tentative !== b.is_tentative) return a.is_tentative ? 1 : -1;
    if (aPrio !== bPrio) return aPrio ? -1 : 1;
    return 0;
  });

  // Determine which comp numbers already exist for this raid
  const [existingCompNums] = await pool.query(
    'SELECT DISTINCT comp_number FROM compositions WHERE raid_id = ? ORDER BY comp_number',
    [raidId]
  );
  const compNumbers = existingCompNums.map(r => r.comp_number);
  if (compNumbers.length === 0) compNumbers.push(1);

  // Determine active comp from query param (default: 1)
  const currentComp = parseInt(req.query.comp) || 1;

  // Include the current comp even if it hasn't been saved to the DB yet
  // (e.g. user navigated to a new comp tab but hasn't placed anyone yet)
  if (!compNumbers.includes(currentComp)) {
    compNumbers.push(currentComp);
    compNumbers.sort((a, b) => a - b);
  }

  const [existingComp] = await pool.query(
    'SELECT * FROM compositions WHERE raid_id = ? AND comp_number = ?',
    [raidId, currentComp]
  );

  const maxSize = raid.max_size || 25;

  // Build lookup maps keyed by absolute slot key "slot_N"
  const compMap = {};
  const placeholderMap = {};
  const slotRoleMap = {};

  for (const c of existingComp) {
    const slotKey = c.role_slot; // "slot_N" format after migration 005
    const role = c.slot_role || 'dps';
    if (c.character_id) {
      compMap[slotKey] = String(c.character_id);
    } else if (c.placeholder_text) {
      placeholderMap[slotKey] = c.placeholder_text;
    }
    slotRoleMap[slotKey] = role;
  }

  // Build slots array: ["slot_1", "slot_2", ..., "slot_N"]
  // Fill in default role "dps" for slots not present in the DB
  const slots = [];
  for (let i = 1; i <= maxSize; i++) {
    const slotKey = `slot_${i}`;
    slots.push(slotKey);
    if (!slotRoleMap[slotKey]) slotRoleMap[slotKey] = 'dps';
  }

  // Next comp number for "Add Comp" button
  const nextComp = Math.max(...compNumbers, currentComp) + 1;

  // Fetch custom comp labels
  const compLabels = await fetchCompLabels(raidId);

  // Build map of character_id -> [comp_numbers] across ALL comps for this raid.
  // Used by the left-panel to show which characters are already placed.
  const [allCompAssignments] = await pool.query(
    'SELECT character_id, comp_number FROM compositions WHERE raid_id = ? AND character_id IS NOT NULL',
    [raidId]
  );
  const charsInComps = {};
  for (const row of allCompAssignments) {
    const cid = String(row.character_id);
    if (!charsInComps[cid]) charsInComps[cid] = [];
    charsInComps[cid].push(row.comp_number);
  }

  // Build per-comp role-count summaries for the post confirmation modal
  const compSummaries = {};
  for (const cn of compNumbers) {
    compSummaries[cn] = { tank: 0, healer: 0, dps: 0 };
  }
  if (compNumbers.length > 1) {
    const sqlPlaceholders = compNumbers.map(() => '?').join(', ');
    const [summaryRows] = await pool.query(
      `SELECT comp_number, slot_role, COUNT(*) AS cnt
       FROM compositions
       WHERE raid_id = ? AND comp_number IN (${sqlPlaceholders})
       GROUP BY comp_number, slot_role`,
      [raidId, ...compNumbers]
    );
    for (const row of summaryRows) {
      const cn = row.comp_number;
      if (compSummaries[cn] && ['tank', 'healer', 'dps'].includes(row.slot_role)) {
        compSummaries[cn][row.slot_role] = Number(row.cnt);
      }
    }
  }

  res.render('raid_manage.html', {
    raid,
    signups,
    signupsByUser,
    signup_by_char_id: signupByCharId,
    slots,
    comp_map: compMap,
    placeholder_map: placeholderMap,
    slot_role_map: slotRoleMap,
    max_size: maxSize,
    comp_numbers: compNumbers,
    comp_labels: compLabels,
    current_comp: currentComp,
    next_comp: nextComp,
    comp_summaries: compSummaries,
    chars_in_comps: charsInComps,
    wotlk_buffs: WOTLK_BUFFS,
    flash: popFlash(req),
    user: currentUser(req),
    can_edit: canEdit,
  });
});

// POST /raids/:raid_id/manage (JSON body) — full-state save used by manual "Save & Reload"
router.post('/:raid_id/manage', express.json(), async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const raidId = parseInt(req.params.raid_id);
  const userId = req.session.user_id;
  const compNumber = parseInt(req.query.comp) || 1;
  const body = req.body;

  if (!Array.isArray(body)) {
    return res.json({ ok: false, error: 'Body must be a list of {character_id?, placeholder_text?, role_slot} entries.' });
  }

  for (const entry of body) {
    if (typeof entry !== 'object' || !('role_slot' in entry)) {
      return res.json({ ok: false, error: 'Each entry must have a role_slot field.' });
    }
    const hasChar = 'character_id' in entry && entry.character_id !== null && entry.character_id !== '';
    const hasPlaceholder = 'placeholder_text' in entry && entry.placeholder_text;
    if (!hasChar && !hasPlaceholder) {
      return res.json({ ok: false, error: 'Each entry must have either character_id or placeholder_text.' });
    }
    if (hasChar && isNaN(parseInt(entry.character_id))) {
      return res.json({ ok: false, error: `Invalid character_id: ${entry.character_id}` });
    }
  }

  // Separate character entries from placeholder entries
  const charEntries = body.filter(e => e.character_id !== null && e.character_id !== undefined && e.character_id !== '');
  const placeholderEntries = body.filter(e => !e.character_id && e.placeholder_text);

  if (charEntries.length > 0) {
    // Validate: each Discord user may only appear once in the composition
    const charIds = charEntries.map(e => parseInt(e.character_id));
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

  await pool.query('DELETE FROM compositions WHERE raid_id = ? AND comp_number = ?', [raidId, compNumber]);

  for (const entry of charEntries) {
    const slotRole = ['tank', 'healer', 'dps'].includes(entry.slot_role) ? entry.slot_role : 'dps';
    await pool.query(
      'INSERT INTO compositions (raid_id, character_id, placeholder_text, role_slot, slot_role, comp_number, created_by, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?, NOW(3), NOW(3))',
      [raidId, parseInt(entry.character_id), entry.role_slot, slotRole, compNumber, userId]
    );
  }

  for (const entry of placeholderEntries) {
    const slotRole = ['tank', 'healer', 'dps'].includes(entry.slot_role) ? entry.slot_role : 'dps';
    await pool.query(
      'INSERT INTO compositions (raid_id, character_id, placeholder_text, role_slot, slot_role, comp_number, created_by, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, ?, ?, NOW(3), NOW(3))',
      [raidId, entry.placeholder_text, entry.role_slot, slotRole, compNumber, userId]
    );
  }

  res.json({ ok: true });
});

// PATCH /raids/:raid_id/manage — granular per-slot auto-save (last-write-wins per slot)
// Body: array of { role_slot, slot_role?, character_id? | placeholder_text? | clear: true }
// Only the slots present in the payload are touched; all other slots are left as-is.
router.patch('/:raid_id/manage', express.json(), async (req, res) => {
  if (!req.session.user_id) return res.status(401).json({ ok: false });
  if (req.session.is_admin === false) return res.status(403).json({ ok: false, error: 'Forbidden' });

  const raidId = parseInt(req.params.raid_id);
  const userId = req.session.user_id;
  const compNumber = parseInt(req.query.comp) || 1;
  const body = req.body;

  if (!Array.isArray(body) || body.length === 0) {
    // Return current composition even for empty payloads
    const [emptyRows] = await pool.query(
      `SELECT co.role_slot, co.slot_role, co.character_id, co.placeholder_text,
              c.char_name, c.char_class, c.spec, c.discord_user_id AS char_discord_user_id
       FROM compositions co
       LEFT JOIN characters c ON co.character_id = c.id
       WHERE co.raid_id = ? AND co.comp_number = ?
       ORDER BY co.role_slot`,
      [raidId, compNumber]
    );
    const emptyEntries = emptyRows.map(r => ({
      role_slot: r.role_slot,
      slot_role: r.slot_role || 'dps',
      character_id: r.character_id ? String(r.character_id) : null,
      placeholder_text: r.placeholder_text || null,
      char_name: r.char_name || null,
      char_class: r.char_class ? r.char_class.toLowerCase().replace(/ /g, '-') : null,
      spec: r.spec || null,
      discord_user_id: r.char_discord_user_id ? String(r.char_discord_user_id) : null,
    }));
    return res.json({ ok: true, saved: [], entries: emptyEntries });
  }

  // Basic validation
  for (const entry of body) {
    if (typeof entry !== 'object' || !entry.role_slot) {
      return res.json({ ok: false, error: 'Each entry must have a role_slot field.' });
    }
    const hasChar = entry.character_id !== null && entry.character_id !== undefined && entry.character_id !== '';
    const hasPlaceholder = !!entry.placeholder_text;
    const isClear = entry.clear === true;
    if (!hasChar && !hasPlaceholder && !isClear) {
      return res.json({ ok: false, error: `Entry for ${entry.role_slot} must have character_id, placeholder_text, or clear:true.` });
    }
    if (hasChar && isNaN(parseInt(entry.character_id))) {
      return res.json({ ok: false, error: `Invalid character_id: ${entry.character_id}` });
    }
  }

  const savedSlots = [];

  for (const entry of body) {
    const { role_slot } = entry;
    const slotRole = ['tank', 'healer', 'dps'].includes(entry.slot_role) ? entry.slot_role : 'dps';
    const charId = (entry.character_id !== null && entry.character_id !== undefined && entry.character_id !== '')
      ? parseInt(entry.character_id) : null;
    const placeholderText = entry.placeholder_text || null;
    const isClear = entry.clear === true;

    if (isClear) {
      await pool.query(
        'DELETE FROM compositions WHERE raid_id = ? AND comp_number = ? AND role_slot = ?',
        [raidId, compNumber, role_slot]
      );
      savedSlots.push({ role_slot, cleared: true });
    } else if (charId !== null) {
      await pool.query(
        `INSERT INTO compositions (raid_id, character_id, placeholder_text, role_slot, slot_role, comp_number, created_by, created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, NOW(3), NOW(3))
         ON DUPLICATE KEY UPDATE
           character_id    = VALUES(character_id),
           placeholder_text = NULL,
           slot_role       = VALUES(slot_role),
           created_by      = VALUES(created_by),
           updated_at      = NOW(3)`,
        [raidId, charId, role_slot, slotRole, compNumber, userId]
      );
      savedSlots.push({ role_slot });
    } else if (placeholderText) {
      await pool.query(
        `INSERT INTO compositions (raid_id, character_id, placeholder_text, role_slot, slot_role, comp_number, created_by, created_at, updated_at)
         VALUES (?, NULL, ?, ?, ?, ?, ?, NOW(3), NOW(3))
         ON DUPLICATE KEY UPDATE
           character_id    = NULL,
           placeholder_text = VALUES(placeholder_text),
           slot_role       = VALUES(slot_role),
           created_by      = VALUES(created_by),
           updated_at      = NOW(3)`,
        [raidId, placeholderText, role_slot, slotRole, compNumber, userId]
      );
      savedSlots.push({ role_slot });
    }
  }

  // Return the full current composition so all clients can converge immediately
  const [rows] = await pool.query(
    `SELECT co.role_slot, co.slot_role, co.character_id, co.placeholder_text,
            c.char_name, c.char_class, c.spec, c.discord_user_id AS char_discord_user_id
     FROM compositions co
     LEFT JOIN characters c ON co.character_id = c.id
     WHERE co.raid_id = ? AND co.comp_number = ?
     ORDER BY co.role_slot`,
    [raidId, compNumber]
  );

  const entries = rows.map(r => ({
    role_slot: r.role_slot,
    slot_role: r.slot_role || 'dps',
    character_id: r.character_id ? String(r.character_id) : null,
    placeholder_text: r.placeholder_text || null,
    char_name: r.char_name || null,
    char_class: r.char_class ? r.char_class.toLowerCase().replace(/ /g, '-') : null,
    spec: r.spec || null,
    discord_user_id: r.char_discord_user_id ? String(r.char_discord_user_id) : null,
  }));

  res.json({ ok: true, saved: savedSlots, entries });
});

// GET /raids/:raid_id/manage/json  — polling endpoint for collaborative auto-load
router.get('/:raid_id/manage/json', async (req, res) => {
  if (!req.session.user_id) return res.status(401).json({ ok: false });

  const raidId = parseInt(req.params.raid_id);
  const compNumber = parseInt(req.query.comp) || 1;

  const [rows] = await pool.query(
    `SELECT co.role_slot, co.slot_role, co.character_id, co.placeholder_text,
            MAX(co.updated_at) OVER () AS max_updated_at,
            c.char_name, c.char_class, c.spec, c.discord_user_id AS char_discord_user_id
     FROM compositions co
     LEFT JOIN characters c ON co.character_id = c.id
     WHERE co.raid_id = ? AND co.comp_number = ?
     ORDER BY co.role_slot`,
    [raidId, compNumber]
  );

  // Version = ISO string of most recent updated_at across all slots
  const version = rows.length > 0 && rows[0].max_updated_at
    ? (rows[0].max_updated_at instanceof Date
        ? rows[0].max_updated_at.toISOString()
        : String(rows[0].max_updated_at))
    : '';

  const entries = rows.map(r => ({
    role_slot: r.role_slot,
    slot_role: r.slot_role || 'dps',
    character_id: r.character_id ? String(r.character_id) : null,
    placeholder_text: r.placeholder_text || null,
    char_name: r.char_name || null,
    char_class: r.char_class ? r.char_class.toLowerCase().replace(/ /g, '-') : null,
    spec: r.spec || null,
    discord_user_id: r.char_discord_user_id ? String(r.char_discord_user_id) : null,
  }));

  res.json({ ok: true, version: version || '', entries });
});

// PUT /raids/:raid_id/comp_label — set or clear a custom label for a comp tab
router.put('/:raid_id/comp_label', express.json(), async (req, res) => {
  if (!req.session.user_id) return res.status(401).json({ ok: false });
  if (req.session.is_admin === false) return res.status(403).json({ ok: false, error: 'Forbidden' });

  const raidId = parseInt(req.params.raid_id);
  const { comp_number, label } = req.body || {};

  if (comp_number == null || typeof label !== 'string') {
    return res.status(400).json({ ok: false, error: 'comp_number and label are required' });
  }

  const trimmed = label.trim().slice(0, 100);
  if (trimmed) {
    await pool.query(
      'INSERT INTO comp_labels (raid_id, comp_number, label) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE label = ?',
      [raidId, comp_number, trimmed, trimmed]
    );
  } else {
    await pool.query('DELETE FROM comp_labels WHERE raid_id = ? AND comp_number = ?', [raidId, comp_number]);
  }

  res.json({ ok: true, label: trimmed || null });
});

// GET /raids/:raid_id/comp
router.get('/:raid_id/comp', async (req, res) => {
  if (!requireLogin(req, res)) return;

  const raidId = parseInt(req.params.raid_id);

  const [[raid]] = await pool.query('SELECT * FROM raids WHERE id = ?', [raidId]);
  if (!raid) return res.redirect('/raids');

  // Determine which comp numbers exist
  const [existingCompNums] = await pool.query(
    'SELECT DISTINCT comp_number FROM compositions WHERE raid_id = ? ORDER BY comp_number',
    [raidId]
  );
  const compNumbers = existingCompNums.map(r => r.comp_number);
  if (compNumbers.length === 0) compNumbers.push(1);

  const currentComp = parseInt(req.query.comp) || compNumbers[0];

  const [comps] = await pool.query(
    `SELECT co.*, c.id AS c_id, c.char_name, c.realm, c.char_class, c.spec, c.gearscore, c.role, c.discord_user_id AS char_discord_user_id
     FROM compositions co LEFT JOIN characters c ON co.character_id = c.id
     WHERE co.raid_id = ? AND co.comp_number = ?
     ORDER BY co.role_slot`,
    [raidId, currentComp]
  );

  const groups = { tank: [], healer: [], dps: [] };
  for (const comp of comps) {
    const entry = {
      ...comp,
      is_placeholder: !comp.character_id,
      placeholder_text: comp.placeholder_text || null,
      character: comp.character_id ? {
        id: comp.c_id,
        char_name: comp.char_name,
        realm: comp.realm,
        char_class: comp.char_class,
        spec: comp.spec,
        gearscore: comp.gearscore,
        role: comp.role,
        discord_user_id: comp.char_discord_user_id,
      } : null,
    };
    // Use slot_role column (populated during migration 005) for grouping
    const roleKey = comp.slot_role || 'dps';
    if (groups[roleKey]) {
      groups[roleKey].push(entry);
    } else {
      groups[roleKey] = [entry];
    }
  }

  const compLabels = await fetchCompLabels(raidId);

  res.render('raid_comp.html', {
    raid,
    groups,
    comp_numbers: compNumbers,
    comp_labels: compLabels,
    current_comp: currentComp,
    flash: popFlash(req),
    user: currentUser(req),
  });
});

// POST /raids/:raid_id/lock
router.post('/:raid_id/lock', async (req, res) => {
  if (!requireAdmin(req, res)) return;

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
  if (!requireAdmin(req, res)) return;

  const raidId = parseInt(req.params.raid_id);
  const compNumber = req.query.comp ? parseInt(req.query.comp) : null;

  const [[raid]] = await pool.query('SELECT * FROM raids WHERE id = ?', [raidId]);

  if (raid) {
    // Determine all comp numbers so we know if this is a multi-comp raid
    const [existingCompNums] = await pool.query(
      'SELECT DISTINCT comp_number FROM compositions WHERE raid_id = ? ORDER BY comp_number',
      [raidId]
    );
    const allCompNumbers = existingCompNums.map(r => r.comp_number);
    if (allCompNumbers.length === 0) allCompNumbers.push(1);

    // Post the selected comp (or all comps if no specific one was selected) to Discord
    const compsToPost = compNumber !== null ? [compNumber] : allCompNumbers;

    // Fetch custom comp labels for embed titles
    const compLabels = await fetchCompLabels(raidId);

    // Post the final composition to the main raid channel (not the log thread)
    const discordTargetId = raid.discord_channel_id;

    if (discordTargetId) {
      let allPosted = true;
      for (const cn of compsToPost) {
        const [comps] = await pool.query(
          `SELECT co.slot_role, co.character_id, co.placeholder_text,
                  c.char_name, c.char_class, c.spec, c.role, c.discord_user_id AS char_discord_user_id
           FROM compositions co
           LEFT JOIN characters c ON co.character_id = c.id
           WHERE co.raid_id = ? AND co.comp_number = ?
           ORDER BY co.role_slot`,
          [raidId, cn]
        );

        const groups = { tank: [], healer: [], dps: [] };
        for (const comp of comps) {
          const entry = {
            is_placeholder: !comp.character_id,
            placeholder_text: comp.placeholder_text || null,
            character: comp.character_id ? {
              char_name: comp.char_name,
              char_class: comp.char_class,
              spec: comp.spec,
              role: comp.role,
              discord_user_id: comp.char_discord_user_id ? String(comp.char_discord_user_id) : null,
            } : null,
          };
          const roleKey = comp.slot_role || 'dps';
          if (groups[roleKey]) groups[roleKey].push(entry);
        }

        const payload = buildCompEmbed(raid, groups, cn, allCompNumbers.length, compLabels);
        const result = await postToDiscordChannel(String(discordTargetId), payload);
        if (!result.ok) {
          allPosted = false;
          console.error(`[post_comp] Failed to post comp ${cn} for raid ${raidId}: ${result.reason}`);
          console.debug(`[post_comp] Debug — target channel id: ${discordTargetId} (channel_id: ${raid.discord_channel_id})`);
        }
      }
      if (allPosted) {
        req.session.flash = `📋 Composition for '${raid.name}' sent to Discord.`;
      } else {
        req.session.flash = `📋 Composition for '${raid.name}' could not be fully sent to Discord. Check server logs for details.`;
      }
    } else {
      req.session.flash = `📋 Composition posted. (No Discord channel linked — create the raid via bot to enable auto-posting.)`;
    }
  }

  const compParam = compNumber !== null ? `?comp=${compNumber}` : '';
  res.redirect(`/raids/${raidId}/comp${compParam}`);
});

// POST /raids/:raid_id/unlock
router.post('/:raid_id/unlock', async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const raidId = parseInt(req.params.raid_id);
  const [[raid]] = await pool.query('SELECT * FROM raids WHERE id = ?', [raidId]);

  if (raid && raid.status === 'locked') {
    await pool.query("UPDATE raids SET status = 'open' WHERE id = ?", [raidId]);
    req.session.flash = `🟢 Raid '${raid.name}' unlocked and open for sign-ups.`;
  } else if (raid) {
    req.session.flash = `ℹ️ Raid '${raid.name}' is already open.`;
  }

  res.redirect(`/raids/${raidId}/manage`);
});

module.exports = router;
