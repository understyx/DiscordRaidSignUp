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
  return {
    id: req.session.user_id,
    username: req.session.username,
    is_admin: req.session.is_admin !== false,
  };
}

// GET /characters
router.get('/characters', async (req, res) => {
  if (!requireLogin(req, res)) return;

  const userId = req.session.user_id;
  const [chars] = await pool.query(
    'SELECT * FROM characters WHERE discord_user_id = ? AND is_deleted = 0 ORDER BY char_name ASC, id ASC',
    [userId]
  );

  // Group rows by char_name so the template can render merged rows
  const charGroups = [];
  const nameMap = {};
  for (const c of chars) {
    if (!nameMap[c.char_name]) {
      const group = { name: c.char_name, realm: c.realm, char_class: c.char_class, rows: [c] };
      nameMap[c.char_name] = group;
      charGroups.push(group);
    } else {
      nameMap[c.char_name].rows.push(c);
    }
  }

  res.render('characters.html', {
    charGroups,
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
  const gearscore = gsRaw !== '' && !isNaN(parseFloat(gsRaw)) ? parseFloat(gsRaw) : null;

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
      `INSERT INTO characters (discord_user_id, char_name, realm, char_class, spec, gearscore, last_updated)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
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
  const gearscore = gsRaw !== '' && !isNaN(parseFloat(gsRaw)) ? parseFloat(gsRaw) : null;

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

module.exports = router;
