const express = require('express');
const pool = require('../db');

const router = express.Router();

// Sentinel value stored in the database to represent "Best in Slot".
const BIS_GS = 99999;

/**
 * Parse a gearscore string into a number (or null).
 * Accepts plain numbers, "k" shorthand, and "bis" (case-insensitive).
 * Returns null when the input is empty or unrecognisable.
 */
function parseGS(raw) {
  const s = (raw || '').trim();
  if (s === '') return null;
  if (s.toLowerCase() === 'bis') return BIS_GS;
  const v = parseFloat(s);
  if (isNaN(v)) return null;
  return v;
}

function requireLogin(req, res) {
  if (!req.session.user_id) {
    req.session.next_url = req.originalUrl;
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
  return {
    id: req.session.user_id,
    username: req.session.username,
    is_admin: req.session.is_admin !== false,
  };
}

// Instances that share the same weekly lockout are collapsed to a single
// canonical name — mirrors LOCKOUT_CANONICAL in bot/cogs/saves.py.
const LOCKOUT_CANONICAL = {
  'ICC10 HC': 'ICC10',
  'ICC25 HC': 'ICC25',
  'TOGC10':   'TOC10',
  'TOGC25':   'TOC25',
  'RS10 HC':  'RS10',
  'RS25 HC':  'RS25',
};

function canonicalizeInstance(name) {
  const trimmed = (name || '').trim();
  return LOCKOUT_CANONICAL[trimmed] || trimmed;
}

// GET /characters
router.get('/characters', async (req, res) => {
  if (!requireLogin(req, res)) return;

  const userId = req.session.user_id;

  const [chars] = await pool.query(
    'SELECT * FROM characters WHERE discord_user_id = ? AND is_deleted = 0 ORDER BY char_name ASC, id ASC',
    [userId]
  );

  // Group rows by name+realm so characters with same name on different realms are distinct.
  // This matches the template's expectation of merged rows for multi-spec characters.
  const charGroups = [];
  const groupMap = {}; // key: "Name|Realm"
  for (const c of chars) {
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
    'RS10', 'RS25',
    'ICC10', 'ICC25',
    'TOC10', 'TOC25',
    'ONY10', 'ONY25',
    'ULD10', 'ULD25',
    'EOE10', 'EOE25',
    'OS10', 'OS25',
    'NAXX10', 'NAXX25',
  ];

  // Build a flat list of character rows for the grid (one row per character name).
  // We use the first spec row's id as a stable representative ID for the character,
  // since raid saves are tracked per-character-name, not per-spec.
  const gridChars = charGroups.map(g => ({ id: g.rows[0].id, name: g.name }));

  // Fetch all save records for this user's characters
  const charIds = chars.map(c => c.id);
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
  });
});

// GET /profile -> redirect for backwards-compat
router.get('/profile', (req, res) => {
  res.redirect('/characters');
});

// POST /characters/register
router.post('/characters/register', express.urlencoded({ extended: false }), async (req, res) => {
  if (!requireLogin(req, res)) return;

  const userId = req.session.user_id;
  const charName = (req.body.char_name || '').trim();
  const realm = (req.body.realm || 'Icecrown').trim();
  const charClass = (req.body.char_class || '').trim() || null;
  const spec = (req.body.spec || '').trim() || null;
  const gsRaw = (req.body.gearscore || '').trim();
  const gearscore = parseGS(gsRaw);

  if (!charName) {
    req.session.flash = '❌ Character name is required.';
    return res.redirect('/characters');
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
     WHERE discord_user_id = ? AND char_name = ? AND realm = ?
       AND (spec <=> ?)
     LIMIT 1`,
    [userId, charNameCap, realmCap, specNorm]
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
      [userId, charNameCap, realmCap, charClass, spec, gearscore]
    );
  }

  req.session.flash = `✅ Character ${charNameCap} registered!`;
  res.redirect('/characters');
});

// POST /characters/:char_id/update-gs
router.post('/characters/:char_id/update-gs', express.urlencoded({ extended: false }), async (req, res) => {
  if (!requireLogin(req, res)) return;

  const userId = req.session.user_id;
  const charId = parseInt(req.params.char_id);
  const gsRaw = (req.body.gearscore || '').trim();
  const gearscore = parseGS(gsRaw);

  const [[char]] = await pool.query(
    'SELECT id, char_name FROM characters WHERE id = ? AND discord_user_id = ? AND is_deleted = 0',
    [charId, userId]
  );

  if (char) {
    await pool.query('UPDATE characters SET gearscore = ?, last_updated = NOW() WHERE id = ?', [gearscore, char.id]);
    req.session.flash = `✅ GS updated for ${char.char_name}.`;
  } else {
    req.session.flash = '❌ Character not found.';
  }

  res.redirect('/characters');
});

// POST /characters/:char_id/update-spec
router.post('/characters/:char_id/update-spec', express.urlencoded({ extended: false }), async (req, res) => {
  if (!requireLogin(req, res)) return;

  const userId = req.session.user_id;
  const charId = parseInt(req.params.char_id);
  const spec = (req.body.spec || '').trim() || null;

  const [[char]] = await pool.query(
    'SELECT id, char_name FROM characters WHERE id = ? AND discord_user_id = ? AND is_deleted = 0',
    [charId, userId]
  );

  if (char) {
    await pool.query('UPDATE characters SET spec = ?, last_updated = NOW() WHERE id = ?', [spec, char.id]);
    req.session.flash = `✅ Spec updated for ${char.char_name}.`;
  } else {
    req.session.flash = '❌ Character not found.';
  }

  res.redirect('/characters');
});

// POST /characters/:char_id/delete
router.post('/characters/:char_id/delete', async (req, res) => {
  if (!requireLogin(req, res)) return;

  const userId = req.session.user_id;
  const charId = parseInt(req.params.char_id);

  const [[char]] = await pool.query(
    'SELECT id, char_name FROM characters WHERE id = ? AND discord_user_id = ? AND is_deleted = 0',
    [charId, userId]
  );

  if (char) {
    await pool.query('UPDATE characters SET is_deleted = 1 WHERE id = ?', [char.id]);
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
  const charId = parseInt(req.body.char_id);
  const instanceName = canonicalizeInstance(req.body.instance_name);

  if (!charId || !instanceName) {
    return res.status(400).json({ error: 'char_id and instance_name are required' });
  }

  // Verify this character belongs to the current user
  const [[char]] = await pool.query(
    'SELECT id FROM characters WHERE id = ? AND discord_user_id = ? AND is_deleted = 0',
    [charId, userId]
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
