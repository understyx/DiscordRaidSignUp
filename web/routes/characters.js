const express = require('express');
const pool = require('../db');
const { fetchArmory } = require('../warmane');

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
    'SELECT * FROM characters WHERE discord_user_id = ?',
    [userId]
  );

  res.render('characters.html', {
    chars,
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

  if (!charName) {
    req.session.flash = '❌ Character name is required.';
    return res.redirect('/characters');
  }

  const charNameCap = charName.charAt(0).toUpperCase() + charName.slice(1).toLowerCase();
  const realmCap = realm.charAt(0).toUpperCase() + realm.slice(1).toLowerCase();

  const armory = await fetchArmory(charNameCap, realmCap);

  const [[existing]] = await pool.query(
    'SELECT id FROM characters WHERE discord_user_id = ? AND char_name = ? AND realm = ?',
    [userId, charNameCap, realmCap]
  );

  if (existing) {
    if (armory && armory.char_class) {
      await pool.query(
        'UPDATE characters SET char_class = ?, spec = ?, gearscore = ?, last_updated = NOW() WHERE id = ?',
        [armory.char_class, armory.spec, armory.gearscore || 0.0, existing.id]
      );
    } else {
      await pool.query(
        'UPDATE characters SET last_updated = NOW() WHERE id = ?',
        [existing.id]
      );
    }
  } else {
    await pool.query(
      `INSERT INTO characters (discord_user_id, char_name, realm, char_class, spec, gearscore, last_updated)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [
        userId,
        charNameCap,
        realmCap,
        armory.char_class || null,
        armory.spec || null,
        armory.gearscore || 0.0,
      ]
    );
  }

  req.session.flash = `✅ Character ${charNameCap} registered!`;
  res.redirect('/characters');
});

// POST /characters/:char_id/delete
router.post('/characters/:char_id/delete', async (req, res) => {
  if (!requireLogin(req, res)) return;

  const userId = req.session.user_id;
  const charId = parseInt(req.params.char_id);

  const [[char]] = await pool.query(
    'SELECT id, char_name FROM characters WHERE id = ? AND discord_user_id = ?',
    [charId, userId]
  );

  if (char) {
    await pool.query('DELETE FROM signups WHERE character_id = ?', [char.id]);
    await pool.query('DELETE FROM characters WHERE id = ?', [char.id]);
    req.session.flash = `✅ Character '${char.char_name}' deleted.`;
  } else {
    req.session.flash = '❌ Character not found.';
  }

  res.redirect('/characters');
});

module.exports = router;
