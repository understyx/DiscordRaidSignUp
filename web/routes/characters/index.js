const express = require('express');
const pool = require('../../db');
const { canStartCharacterGuide } = require('../../services/guildAccess');
const { saveSignupPreset } = require('../../services/presets');
const { resolveIsAdmin } = require('../adminCheck');
const {
  BIS_GS,
  parseGS,
  requireLogin,
  popFlash,
  currentUser,
  getRoleFromSpec,
} = require('../helpers');

const router = express.Router();

// GET /help/add-characters/:guild_id
// Entry point used by the Discord help launcher. Login is required and the
// requested guild is activated only when Discord reported the user as a member.
router.get('/help/add-characters/:guild_id', async (req, res) => {
  if (!requireLogin(req, res)) return;

  const guildId = String(req.params.guild_id || '');
  if (!canStartCharacterGuide(req.session.user_guild_ids, guildId)) {
    req.session.flash = '❌ You must be a member of that server to add characters to it.';
    return res.redirect('/raids');
  }

  const [[guild]] = await pool.query(
    'SELECT guild_id, guild_name FROM bot_guilds WHERE guild_id = ? LIMIT 1',
    [guildId]
  );
  if (!guild) {
    req.session.flash = '❌ That server is not available in RaidBot.';
    return res.redirect('/raids');
  }

  req.session.active_guild_id = String(guild.guild_id);
  req.session.active_guild_name = guild.guild_name;
  try {
    req.session.is_admin = await resolveIsAdmin(req.session.user_id, guildId);
  } catch (_err) {
    req.session.is_admin = false;
  }

  res.redirect('/characters?guided=1');
});

// Instances that share the same weekly lockout are collapsed to a single
// canonical name — mirrors LOCKOUT_CANONICAL in bot/cogs/saves.py.
const LOCKOUT_CANONICAL = {
  'ICC10 HC': 'ICC10',
  'ICC25 HC': 'ICC25',
  TOGC10: 'TOC10',
  TOGC25: 'TOC25',
  'RS10 HC': 'RS10',
  'RS25 HC': 'RS25',
};

function canonicalizeInstance(name) {
  const trimmed = (name || '').trim();
  return LOCKOUT_CANONICAL[trimmed] || trimmed;
}

// GET /characters/presets
router.get('/characters/presets', async (req, res) => {
  if (!req.session.user_id) return res.status(401).json({ ok: false });
  const userId = req.session.user_id;
  const guildId = req.session.active_guild_id || null;
  if (!guildId) return res.status(400).json({ ok: false, error: 'No active guild' });

  try {
    const [rows] = await pool.query(
      'SELECT id, name, character_ids, priority_ids, notes FROM signup_presets WHERE discord_user_id = ? AND guild_id = ? ORDER BY created_at DESC',
      [userId, guildId]
    );
    res.json({ ok: true, presets: rows });
  } catch (err) {
    console.error('[presets] Failed to load presets:', err.message);
    res.status(500).json({ ok: false, error: 'Database error' });
  }
});

// POST /characters/presets
router.post('/characters/presets', express.json(), async (req, res) => {
  if (!req.session.user_id) return res.status(401).json({ ok: false });
  const userId = req.session.user_id;
  const guildId = req.session.active_guild_id || null;
  if (!guildId) return res.status(400).json({ ok: false, error: 'No active guild' });

  const { name, character_ids, priority_ids, notes } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ ok: false, error: 'name is required' });
  }
  if (!Array.isArray(character_ids)) {
    return res.status(400).json({ ok: false, error: 'character_ids must be an array' });
  }
  if (!Array.isArray(priority_ids)) {
    return res.status(400).json({ ok: false, error: 'priority_ids must be an array' });
  }
  if (!notes || typeof notes !== 'object' || Array.isArray(notes)) {
    return res.status(400).json({ ok: false, error: 'notes must be an object' });
  }

  const normalizeIds = (ids) => {
    const normalized = ids.map((id) => Number(id));
    return normalized.every(Number.isInteger) ? [...new Set(normalized)] : null;
  };
  const characterIds = normalizeIds(character_ids);
  const priorityIds = normalizeIds(priority_ids);
  if (!characterIds || characterIds.length === 0) {
    return res.status(400).json({ ok: false, error: 'character_ids must contain valid IDs' });
  }
  if (!priorityIds || priorityIds.some((id) => !characterIds.includes(id))) {
    return res
      .status(400)
      .json({ ok: false, error: 'priority_ids must refer to selected characters' });
  }

  const charPlaceholders = characterIds.map(() => '?').join(', ');
  const [ownedRows] = await pool.query(
    `SELECT id FROM characters
     WHERE id IN (${charPlaceholders}) AND discord_user_id = ? AND guild_id = ? AND is_deleted = 0`,
    [...characterIds, userId, guildId]
  );
  if (ownedRows.length !== characterIds.length) {
    return res
      .status(400)
      .json({ ok: false, error: 'character_ids must belong to the current user and guild' });
  }

  const normalizedNotes = {};
  for (const [id, rawNote] of Object.entries(notes)) {
    const charId = Number(id);
    const note = String(rawNote ?? '').trim();
    if (!Number.isInteger(charId) || !characterIds.includes(charId)) continue;
    if (note.length > 500) {
      return res.status(400).json({ ok: false, error: 'notes must be 500 characters or fewer' });
    }
    if (note) normalizedNotes[String(charId)] = note;
  }

  const trimmedName = name.trim().slice(0, 100);
  try {
    const presetId = await saveSignupPreset(pool, {
      userId,
      guildId,
      name: trimmedName,
      characterIds,
      priorityIds,
      notes: normalizedNotes,
    });
    res.json({ ok: true, id: presetId, name: trimmedName });
  } catch (err) {
    console.error('[presets] Failed to save preset:', err.message);
    res.status(500).json({ ok: false, error: 'Database error' });
  }
});

// DELETE /characters/presets/:id
router.delete('/characters/presets/:id', async (req, res) => {
  if (!req.session.user_id) return res.status(401).json({ ok: false });
  const userId = req.session.user_id;
  const guildId = req.session.active_guild_id || null;
  if (!guildId) return res.status(400).json({ ok: false, error: 'No active guild' });

  const presetId = parseInt(req.params.id);
  if (isNaN(presetId)) return res.status(400).json({ ok: false, error: 'Invalid preset id' });

  try {
    await pool.query(
      'DELETE FROM signup_presets WHERE id = ? AND discord_user_id = ? AND guild_id = ?',
      [presetId, userId, guildId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[presets] Failed to delete preset:', err.message);
    res.status(500).json({ ok: false, error: 'Database error' });
  }
});

// GET /characters
router.get('/characters', async (req, res) => {
  if (!requireLogin(req, res)) return;

  const userId = req.session.user_id;
  const guildId = req.session.active_guild_id;

  if (!guildId) {
    req.session.flash = '❌ No active guild selected.';
    return res.redirect('/select-guild');
  }

  const [chars] = await pool.query(
    'SELECT * FROM characters WHERE discord_user_id = ? AND guild_id = ? AND is_deleted = 0 ORDER BY char_name ASC, id ASC',
    [userId, guildId]
  );

  // Group rows by name+realm so characters with same name on different realms are distinct.
  // This matches the template's expectation of merged rows for multi-spec characters.
  const charGroups = [];
  const groupMap = {}; // key: "Name|Realm"
  for (const c of chars) {
    // Keep role-based preset actions accurate for older rows whose stored role may be stale.
    c.role = getRoleFromSpec(c.char_class, c.spec);
    const key = `${c.char_name}|${c.realm}`;
    if (!groupMap[key]) {
      const group = { name: c.char_name, realm: c.realm, char_class: c.char_class, rows: [c] };
      groupMap[key] = group;
      charGroups.push(group);
    } else {
      groupMap[key].rows.push(c);
    }
  }

  // Fixed list of raid instances for save tracking (do not pull from raids table).
  // HC variants and TOGC share a lockout with their canonical counterpart, so
  // only the canonical name is listed here (matching bot/cogs/saves.py).
  const instances = [
    'RS10',
    'RS25',
    'ICC10',
    'ICC25',
    'TOC10',
    'TOC25',
    'ONY10',
    'ONY25',
    'ULD10',
    'ULD25',
    'EOE10',
    'EOE25',
    'OS10',
    'OS25',
    'NAXX10',
    'NAXX25',
  ];

  // Build a flat list of character rows for the grid (one row per character name).
  // We use the first spec row's id as a stable representative ID for the character,
  // since raid saves are tracked per-character-name, not per-spec.
  const gridChars = charGroups.map((g) => ({ id: g.rows[0].id, name: g.name }));

  // Fetch all save records for this user's characters
  const charIds = chars.map((c) => c.id);
  let savesMap = {}; // key: `${char_id}:${instance_name}` → is_saved (0/1)
  if (charIds.length > 0) {
    // Build placeholder list from a known-safe integer array (charIds are parsed with parseInt).
    const placeholders = charIds.map(() => '?').join(',');
    const [saveRows] = await pool.query(
      `SELECT character_id, instance_name, is_saved FROM char_raid_saves
       WHERE character_id IN (${placeholders})`,
      charIds
    );
    for (const s of saveRows) {
      savesMap[`${s.character_id}:${s.instance_name}`] = s.is_saved;
    }
  }

  res.render('characters.html', {
    charGroups,
    instances,
    gridChars,
    savesMap,
    flash: popFlash(req),
    user: currentUser(req),
    guidedMode: req.query.guided === '1',
    guidedAdded: req.query.added === '1',
  });
});

// GET /profile -> redirect for backwards-compat
router.get('/profile', (req, res) => {
  res.redirect('/characters');
});

// POST /characters/:char_id/update-name
router.post(
  '/characters/:char_id/update-name',
  express.urlencoded({ extended: false }),
  async (req, res) => {
    if (!requireLogin(req, res)) return;

    const userId = req.session.user_id;
    const guildId = req.session.active_guild_id;
    const charId = parseInt(req.params.char_id);
    const newName = (req.body.char_name || '').trim();

    if (!newName) {
      req.session.flash = '❌ Character name cannot be empty.';
      return res.redirect('/characters');
    }

    const newNameCap = newName.charAt(0).toUpperCase() + newName.slice(1).toLowerCase();

    // Fetch the character to get its current name and realm
    const [[char]] = await pool.query(
      'SELECT char_name, realm FROM characters WHERE id = ? AND discord_user_id = ? AND guild_id = ? AND is_deleted = 0',
      [charId, userId, guildId]
    );

    if (char) {
      // Update all specs for this character (matched by old name + realm)
      await pool.query(
        'UPDATE characters SET char_name = ?, last_updated = NOW() WHERE discord_user_id = ? AND guild_id = ? AND char_name = ? AND realm = ?',
        [newNameCap, userId, guildId, char.char_name, char.realm]
      );
      req.session.flash = `✅ Character renamed to ${newNameCap}.`;
    } else {
      req.session.flash = '❌ Character not found.';
    }

    res.redirect('/characters');
  }
);

// POST /characters/register
router.post('/characters/register', express.urlencoded({ extended: false }), async (req, res) => {
  if (!requireLogin(req, res)) return;

  const userId = req.session.user_id;
  const guildId = req.session.active_guild_id;

  if (!guildId) {
    req.session.flash = '❌ No active guild selected.';
    return res.redirect('/select-guild');
  }

  const charName = (req.body.char_name || '').trim();
  const realm = (req.body.realm || 'Icecrown').trim();
  const charClass = (req.body.char_class || '').trim() || null;
  const spec = (req.body.spec || '').trim() || null;
  const gsRaw = (req.body.gearscore || '').trim();
  const gearscore = parseGS(gsRaw);
  const prof1 = (req.body.prof_1 || '').trim() || null;
  const prof2 = (req.body.prof_2 || '').trim() || null;
  const guidedMode = req.body.guided === '1';
  const characterPage = guidedMode ? '/characters?guided=1' : '/characters';

  if (!charName) {
    req.session.flash = '❌ Character name is required.';
    return res.redirect(characterPage);
  }
  if (guidedMode && !/^[A-Za-z]{1,12}$/.test(charName)) {
    req.session.flash = '❌ Character names must contain 1–12 letters only.';
    return res.redirect(characterPage);
  }
  if (guidedMode && (!charClass || !spec || !gsRaw || gearscore === null)) {
    req.session.flash = '❌ Choose a class and spec, then enter a valid gearscore.';
    return res.redirect(characterPage);
  }

  const charNameCap = charName.charAt(0).toUpperCase() + charName.slice(1).toLowerCase();
  const realmCap = realm.charAt(0).toUpperCase() + realm.slice(1).toLowerCase();

  // Look for an exact match on name + realm + spec so the same character+spec
  // just gets its GS refreshed, while a new spec creates a separate row.
  const specNorm = spec || null;
  // <=> is MySQL's NULL-safe equality operator: returns true when both sides are NULL,
  // unlike = which returns NULL for NULL comparisons.
  const [[existing]] = await pool.query(
    `SELECT id FROM characters
     WHERE discord_user_id = ? AND guild_id = ? AND char_name = ? AND realm = ?
       AND (spec <=> ?)
     LIMIT 1`,
    [userId, guildId, charNameCap, realmCap, specNorm]
  );

  const role = getRoleFromSpec(charClass, spec);

  // Try to get discord role if possible
  const { fetchUserGuildRoles } = require('../raids/embeds');
  const userGuildRolesMap = await fetchUserGuildRoles(guildId, [userId]);
  const discordRole = userGuildRolesMap[userId] || null;

  if (existing) {
    await pool.query(
      'UPDATE characters SET char_class = ?, role = ?, discord_role = ?, membership_status = "active", gearscore = ?, prof_1 = ?, prof_2 = ?, is_deleted = 0, last_updated = NOW() WHERE id = ? AND guild_id = ?',
      [charClass, role, discordRole, gearscore, prof1, prof2, existing.id, guildId]
    );
  } else {
    await pool.query(
      `INSERT INTO characters (discord_user_id, guild_id, char_name, realm, char_class, spec, role, discord_role, membership_status, gearscore, prof_1, prof_2, is_deleted, last_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, "active", ?, ?, ?, 0, NOW())`,
      [
        userId,
        guildId,
        charNameCap,
        realmCap,
        charClass,
        spec,
        role,
        discordRole,
        gearscore,
        prof1,
        prof2,
      ]
    );
  }

  // Propagation: if we just registered/updated a character, update professions for all its specs.
  await pool.query(
    'UPDATE characters SET prof_1 = ?, prof_2 = ?, last_updated = NOW() WHERE discord_user_id = ? AND guild_id = ? AND char_name = ? AND realm = ?',
    [prof1, prof2, userId, guildId, charNameCap, realmCap]
  );

  req.session.flash = `✅ Character ${charNameCap} registered!`;
  res.redirect(guidedMode ? '/characters?guided=1&added=1' : '/characters');
});

// POST /characters/:char_id/update-gs
router.post(
  '/characters/:char_id/update-gs',
  express.urlencoded({ extended: false }),
  async (req, res) => {
    if (!requireLogin(req, res)) return;

    const userId = req.session.user_id;
    const guildId = req.session.active_guild_id;
    const charId = parseInt(req.params.char_id);
    const gsRaw = (req.body.gearscore || '').trim();
    const gearscore = parseGS(gsRaw);

    const [[char]] = await pool.query(
      'SELECT id, char_name FROM characters WHERE id = ? AND discord_user_id = ? AND guild_id = ? AND is_deleted = 0',
      [charId, userId, guildId]
    );

    if (char) {
      await pool.query(
        'UPDATE characters SET gearscore = ?, last_updated = NOW() WHERE id = ? AND guild_id = ?',
        [gearscore, char.id, guildId]
      );
      req.session.flash = `✅ GS updated for ${char.char_name}.`;
    } else {
      req.session.flash = '❌ Character not found.';
    }

    res.redirect('/characters');
  }
);

// POST /characters/:char_id/update-professions
router.post(
  '/characters/:char_id/update-professions',
  express.urlencoded({ extended: false }),
  async (req, res) => {
    if (!requireLogin(req, res)) return;

    const userId = req.session.user_id;
    const guildId = req.session.active_guild_id;
    const charId = parseInt(req.params.char_id);
    const prof1 = (req.body.prof_1 || '').trim() || null;
    const prof2 = (req.body.prof_2 || '').trim() || null;

    const [[char]] = await pool.query(
      'SELECT char_name, realm FROM characters WHERE id = ? AND discord_user_id = ? AND guild_id = ? AND is_deleted = 0',
      [charId, userId, guildId]
    );

    if (char) {
      await pool.query(
        'UPDATE characters SET prof_1 = ?, prof_2 = ?, last_updated = NOW() WHERE discord_user_id = ? AND guild_id = ? AND char_name = ? AND realm = ?',
        [prof1, prof2, userId, guildId, char.char_name, char.realm]
      );
      req.session.flash = `✅ Professions updated for ${char.char_name}.`;
    } else {
      req.session.flash = '❌ Character not found.';
    }

    res.redirect('/characters');
  }
);

// POST /characters/:char_id/update-spec
router.post(
  '/characters/:char_id/update-spec',
  express.urlencoded({ extended: false }),
  async (req, res) => {
    if (!requireLogin(req, res)) return;

    const userId = req.session.user_id;
    const guildId = req.session.active_guild_id;
    const charId = parseInt(req.params.char_id);
    const spec = (req.body.spec || '').trim() || null;

    const [[char]] = await pool.query(
      'SELECT id, char_name, char_class FROM characters WHERE id = ? AND discord_user_id = ? AND guild_id = ? AND is_deleted = 0',
      [charId, userId, guildId]
    );

    if (char) {
      const role = getRoleFromSpec(char.char_class, spec);
      const { fetchUserGuildRoles } = require('../raids/embeds');
      const userGuildRolesMap = await fetchUserGuildRoles(guildId, [userId]);
      const discordRole = userGuildRolesMap[userId] || null;

      await pool.query(
        'UPDATE characters SET spec = ?, role = ?, discord_role = ?, membership_status = "active", last_updated = NOW() WHERE id = ? AND guild_id = ?',
        [spec, role, discordRole, char.id, guildId]
      );
      req.session.flash = `✅ Spec updated for ${char.char_name}.`;
    } else {
      req.session.flash = '❌ Character not found.';
    }

    res.redirect('/characters');
  }
);

// POST /characters/:char_id/delete
router.post('/characters/:char_id/delete', async (req, res) => {
  if (!requireLogin(req, res)) return;

  const userId = req.session.user_id;
  const guildId = req.session.active_guild_id;
  const charId = parseInt(req.params.char_id);

  const [[char]] = await pool.query(
    'SELECT id, char_name FROM characters WHERE id = ? AND discord_user_id = ? AND guild_id = ? AND is_deleted = 0',
    [charId, userId, guildId]
  );

  if (char) {
    await pool.query('UPDATE characters SET is_deleted = 1 WHERE id = ? AND guild_id = ?', [
      char.id,
      guildId,
    ]);
    req.session.flash = `✅ Character '${char.char_name}' hidden.`;
  } else {
    req.session.flash = '❌ Character not found.';
  }

  res.redirect('/characters');
});

// POST /characters/saves/toggle  { char_id, instance_name }
// Toggles the saved/not-saved state for a character+instance pair.
// Returns JSON: { is_saved: 0|1 }
router.post('/characters/saves/toggle', express.json(), async (req, res) => {
  if (!req.session.user_id) return res.status(401).json({ error: 'Not logged in' });

  const userId = req.session.user_id;
  const guildId = req.session.active_guild_id;
  const charId = parseInt(req.body.char_id);
  const instanceName = canonicalizeInstance(req.body.instance_name);

  if (!charId || !instanceName) {
    return res.status(400).json({ error: 'char_id and instance_name are required' });
  }

  // Verify this character belongs to the current user and the active guild
  const [[char]] = await pool.query(
    'SELECT id FROM characters WHERE id = ? AND discord_user_id = ? AND guild_id = ? AND is_deleted = 0',
    [charId, userId, guildId]
  );
  if (!char) return res.status(403).json({ error: 'Character not found' });

  // Fetch current state (default: not saved = 0)
  const [[existing]] = await pool.query(
    'SELECT is_saved FROM char_raid_saves WHERE character_id = ? AND instance_name = ?',
    [charId, instanceName]
  );

  const newState = existing ? (existing.is_saved ? 0 : 1) : 1;

  await pool.query(
    `INSERT INTO char_raid_saves (character_id, instance_name, is_saved)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE is_saved = VALUES(is_saved), updated_at = NOW()`,
    [charId, instanceName, newState]
  );

  res.json({ is_saved: newState });
});

module.exports = router;
