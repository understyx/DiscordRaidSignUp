/**
 * recruitment.js
 *
 * Guild-specific recruitment system.
 *
 * Applicant flow:
 *   GET  /recruitment/:form_id           — OAuth gate → show form
 *   GET  /recruitment/oauth-callback     — Discord OAuth callback for applicants
 *   POST /recruitment/:form_id/submit    — Save answers, optionally join guild
 *   GET  /recruitment/:form_id/edit      — Applicant views/edits their pending application
 *   POST /recruitment/:form_id/edit      — Save edits (pending only)
 *
 * Admin flow (requires session admin + active guild):
 *   GET  /recruitment                            — List forms
 *   GET  /recruitment/new                        — Form builder (blank)
 *   POST /recruitment/new                        — Create form + questions
 *   GET  /recruitment/:form_id/edit-form         — Edit form settings + questions
 *   POST /recruitment/:form_id/edit-form         — Save edits
 *   POST /recruitment/:form_id/toggle            — Toggle is_active
 *   GET  /recruitment/:form_id/applications      — List applications
 *   GET  /recruitment/:form_id/applications/:app_id        — View Q&A
 *   POST /recruitment/:form_id/applications/:app_id/accept — Accept
 *   POST /recruitment/:form_id/applications/:app_id/reject — Reject
 */

const express = require('express');
const crypto = require('crypto');
const fetch = require('node-fetch');
const { URLSearchParams } = require('url');
const pool = require('../db');
const { BIS_GS, parseGS, popFlash, currentUser } = require('./helpers');

const DISCORD_API = 'https://discord.com/api/v10';
const DISCORD_OAUTH_URL = 'https://discord.com/api/oauth2/authorize';
const DISCORD_TOKEN_URL = 'https://discord.com/api/oauth2/token';
const DISCORD_USER_URL = 'https://discord.com/api/users/@me';

// Notification Discord server — applicants are directed here to receive status updates
const NOTIFY_GUILD_ID   = '1495371293183180932';
const NOTIFY_CHANNEL_ID = '1495371294026366978';
const NOTIFY_INVITE_URL = 'https://discord.gg/VfgQ4UKSEP';

const router = express.Router();
router.use(express.urlencoded({ extended: true }));

// ── Helpers ───────────────────────────────────────────────────────────────────

// requireAdmin for recruitment uses middleware style (calls next()) and also
// enforces that an active guild is selected, so it differs from the shared
// sync variant in helpers.js and is kept local to this module.
function requireAdmin(req, res, next) {
  if (!req.session.user_id) {
    req.session.next_url = req.originalUrl;
    return res.redirect('/auth/login');
  }
  if (req.session.is_admin === false) {
    req.session.flash = '❌ You do not have permission to perform this action.';
    return res.redirect('/raids');
  }
  if (!req.session.active_guild_id) {
    req.session.post_guild_select_url = req.originalUrl;
    return res.redirect('/select-guild');
  }
  next();
}

/**
 * Post a message to the notification server channel, mentioning the user.
 * Used to ping applicants when their application status changes.
 */
async function sendNotificationChannelPing(userId, content) {
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!botToken) return { ok: false, reason: 'no bot token' };

  try {
    const msgResp = await fetch(`${DISCORD_API}/channels/${NOTIFY_CHANNEL_ID}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: `<@${userId}> ${content}` }),
    });
    if (!msgResp.ok) {
      const text = await msgResp.text().catch(() => '');
      return { ok: false, reason: `Channel message ${msgResp.status}: ${text}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `Network error: ${err.message}` };
  }
}

/**
 * Send a Discord DM to a user via the bot token.
 */
async function sendDiscordDM(userId, content) {
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!botToken) return { ok: false, reason: 'no bot token' };

  try {
    const dmResp = await fetch(`${DISCORD_API}/users/@me/channels`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ recipient_id: String(userId) }),
    });
    if (!dmResp.ok) {
      const text = await dmResp.text().catch(() => '');
      return { ok: false, reason: `DM channel ${dmResp.status}: ${text}` };
    }
    const dmData = await dmResp.json();

    const msgResp = await fetch(`${DISCORD_API}/channels/${dmData.id}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content }),
    });
    if (!msgResp.ok) {
      const text = await msgResp.text().catch(() => '');
      return { ok: false, reason: `Message ${msgResp.status}: ${text}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `Network error: ${err.message}` };
  }
}

// Slugs that must not collide with top-level or recruitment-router path segments
const RESERVED_SLUGS = [
  'new', 'oauth-callback',
  'auth', 'raids', 'admin', 'guild-settings', 'select-guild', 'recruitment',
];

/**
 * Validate and normalise a user-supplied slug value.
 * Returns the lowercase slug string, null (if blank), or throws a string error message.
 */
function normaliseSlug(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  // Must start and end with a letter or digit; allow hyphens in between
  if (!/^[a-z0-9][a-z0-9-]{0,98}[a-z0-9]$/.test(s) && !/^[a-z0-9]$/.test(s)) {
    throw '❌ Slug must start and end with a letter or digit and may only contain lowercase letters, numbers, and hyphens (max 100 characters).';
  }
  if (s.length > 100) {
    throw '❌ Slug may be at most 100 characters.';
  }
  if (RESERVED_SLUGS.includes(s)) {
    throw `❌ "${s}" is a reserved slug and cannot be used.`;
  }
  return s;
}

/**
 * Resolve a URL parameter (numeric ID or slug) to a recruitment_forms row.
 * Returns the form row or null.
 */
async function resolveFormParam(param, requireActive = false) {
  const numericId = parseInt(param, 10);
  const activeClause = requireActive ? ' AND is_active = 1' : '';
  if (numericId && String(numericId) === String(param)) {
    const [[form]] = await pool.query(
      `SELECT * FROM recruitment_forms WHERE id = ?${activeClause}`,
      [numericId]
    );
    return form || null;
  }
  // Treat as slug
  if (/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(param) || /^[a-z0-9]$/.test(param)) {
    const [[form]] = await pool.query(
      `SELECT * FROM recruitment_forms WHERE slug = ?${activeClause}`,
      [param]
    );
    return form || null;
  }
  return null;
}

/** Parse questions from a form builder POST body. Returns array of question objects. */
function parseQuestions(body) {
  const texts     = [].concat(body.q_text     || []);
  const types     = [].concat(body.q_type     || []);
  const opts      = [].concat(body.q_options  || []);
  const reqs      = [].concat(body.q_required || []);
  const defaults  = [].concat(body.q_default  || []);
  const groupKeys = [].concat(body.q_group_key        || []);
  const groupLabels = [].concat(body.q_group_label    || []);
  const groupReps = [].concat(body.q_group_repeatable || []);
  const colWidths = [].concat(body.q_col_width        || []);

  const questions = [];
  const MAX_QUESTIONS = 50;
  const limit = Math.min(texts.length, MAX_QUESTIONS);
  for (let i = 0; i < limit; i++) {
    const text = String(texts[i] || '').trim();
    const type = ['text', 'textarea', 'select', 'radio', 'characters', 'checkbox', 'header', 'separator'].includes(types[i])
      ? types[i]
      : 'text';

    if (!text && type !== 'separator') continue;

    let options = null;
    if (['select', 'radio', 'checkbox'].includes(type)) {
      const rawOpts = String(opts[i] || '').trim();
      if (rawOpts) {
        options = JSON.stringify(rawOpts.split('\n').map(o => o.trim()).filter(Boolean));
      }
    }

    const isLayout = ['header', 'separator'].includes(type);
    const defaultValue = (type === 'characters' || isLayout) ? null : (String(defaults[i] || '').trim() || null);
    const rawGroupKey  = (type === 'characters' || isLayout) ? '' : String(groupKeys[i] || '').trim().toLowerCase();
    const groupKey     = rawGroupKey.replace(/[^a-z0-9-]/g, '') || null;
    const groupLabel   = groupKey ? (String(groupLabels[i] || '').trim() || null) : null;
    const isGroupRepeatable = (groupKey && groupReps[i] === 'on') ? 1 : 0;
    // 'characters', 'header', 'separator' are always full-width; group settings do not apply to them
    const colWidth = (type === 'characters' || isLayout)
      ? 'full'
      : (['full', 'half', 'third'].includes(colWidths[i]) ? colWidths[i] : 'full');

    questions.push({
      question_text:       text,
      question_type:       type,
      options:             (type === 'characters' || isLayout) ? null : options,
      is_required:         isLayout ? 0 : (reqs[i] === 'on' ? 1 : 0),
      sort_order:          i,
      default_value:       defaultValue,
      group_key:           groupKey,
      group_label:         groupLabel,
      is_group_repeatable: isGroupRepeatable,
      col_width:           colWidth,
    });
  }

  // Only one 'characters' question is allowed per form — keep the first occurrence.
  let seenCharacters = false;
  return questions.filter(q => {
    if (q.question_type !== 'characters') return true;
    if (!seenCharacters) { seenCharacters = true; return true; }
    return false;
  });
}

/**
 * Organise a flat list of questions into rendering blocks.
 * Questions without a group_key become individual 'question' blocks.
 * Questions sharing a group_key are merged into a 'group' block.
 */
function buildQuestionBlocks(questions) {
  const blocks   = [];
  const groupMap = new Map();

  for (const q of questions) {
    if (!q.group_key) {
      blocks.push({ type: 'question', question: q });
    } else {
      if (groupMap.has(q.group_key)) {
        const grp = groupMap.get(q.group_key);
        grp.questions.push(q);
        if (q.is_group_repeatable) grp.is_repeatable = true;
        if (q.group_label && !grp._has_label) {
          grp.label       = q.group_label;
          grp._has_label  = true;
        }
      } else {
        const grp = {
          type:          'group',
          key:           q.group_key,
          label:         q.group_label || q.group_key,
          _has_label:    !!q.group_label,
          is_repeatable: !!q.is_group_repeatable,
          questions:     [q],
          instances:     [{}], // default: one blank instance
        };
        groupMap.set(q.group_key, grp);
        blocks.push(grp);
      }
    }
  }

  // Remove internal flag
  for (const b of blocks) {
    if (b.type === 'group') delete b._has_label;
  }

  return blocks;
}

/**
 * For repeatable groups, build a per-group array of per-instance answer maps.
 * Answers for repeatable questions are stored as a JSON array in answer_text.
 * Returns { group_key: [ { question_id: value, … }, … ] }
 */
function buildExistingGroupInstances(blocks, existingAnswers) {
  const result = {};

  for (const block of blocks) {
    if (block.type !== 'group' || !block.is_repeatable) continue;

    // Determine how many instances exist
    let maxInstances = 1;
    for (const q of block.questions) {
      const raw = existingAnswers[String(q.id)] || '';
      if (raw.startsWith('[')) {
        try {
          const arr = JSON.parse(raw);
          if (Array.isArray(arr)) maxInstances = Math.max(maxInstances, arr.length);
        } catch { /* ignore */ }
      }
    }

    const instances = [];
    for (let i = 0; i < maxInstances; i++) {
      const inst = {};
      for (const q of block.questions) {
        const raw = existingAnswers[String(q.id)] || '';
        if (raw.startsWith('[')) {
          try {
            const arr = JSON.parse(raw);
            inst[String(q.id)] = Array.isArray(arr) ? (arr[i] !== undefined ? arr[i] : '') : '';
          } catch {
            inst[String(q.id)] = i === 0 ? raw : '';
          }
        } else {
          inst[String(q.id)] = i === 0 ? raw : '';
        }
      }
      instances.push(inst);
    }
    result[block.key] = instances;
  }

  return result;
}

// ── Recruitment applicant: register a character ───────────────────────────────
// Used by the 'characters' question type in the apply form.
// Requires a valid recruitment OAuth session (recruit_discord_id).

router.post('/characters/register', express.json(), async (req, res) => {
  if (!req.session.recruit_discord_id) {
    return res.status(401).json({ error: 'Not authenticated. Please reload the page and try again.' });
  }

  const userId = req.session.recruit_discord_id;
  const charName = (req.body.char_name || '').trim();
  const realm = (req.body.realm || 'Icecrown').trim();
  const charClass = (req.body.char_class || '').trim() || null;
  const spec = (req.body.spec || '').trim() || null;
  const gearscore = parseGS(req.body.gearscore);

  if (!charName) {
    return res.status(400).json({ error: 'Character name is required.' });
  }

  const charNameCap = charName.charAt(0).toUpperCase() + charName.slice(1).toLowerCase();
  const realmCap = realm.charAt(0).toUpperCase() + realm.slice(1).toLowerCase();
  const specNorm = spec || null;

  const [[existing]] = await pool.query(
    `SELECT id FROM characters
     WHERE discord_user_id = ? AND char_name = ? AND realm = ?
       AND (spec <=> ?)
     LIMIT 1`,
    [userId, charNameCap, realmCap, specNorm]
  );

  let charId;
  if (existing) {
    await pool.query(
      'UPDATE characters SET char_class = ?, gearscore = ?, is_deleted = 0, last_updated = NOW() WHERE id = ?',
      [charClass, gearscore, existing.id]
    );
    charId = existing.id;
  } else {
    const [result] = await pool.query(
      `INSERT INTO characters (discord_user_id, char_name, realm, char_class, spec, gearscore, is_deleted, last_updated)
       VALUES (?, ?, ?, ?, ?, ?, 0, NOW())`,
      [userId, charNameCap, realmCap, charClass, specNorm, gearscore]
    );
    charId = result.insertId;
  }

  const [[char]] = await pool.query(
    'SELECT id, char_name, realm, char_class, spec, gearscore FROM characters WHERE id = ?',
    [charId]
  );

  return res.json({ ok: true, character: char });
});

// ── Recruitment applicant: update character name ──────────────────────────────
router.post('/characters/:char_id/update-name', express.json(), async (req, res) => {
  if (!req.session.recruit_discord_id) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }

  const userId = req.session.recruit_discord_id;
  const charId = parseInt(req.params.char_id);
  const newName = (req.body.char_name || '').trim();

  if (!newName) {
    return res.status(400).json({ error: 'Character name is required.' });
  }

  const [[char]] = await pool.query(
    'SELECT id, char_name FROM characters WHERE id = ? AND discord_user_id = ? AND is_deleted = 0',
    [charId, userId]
  );

  if (!char) {
    return res.status(404).json({ error: 'Character not found.' });
  }

  const nameCap = newName.charAt(0).toUpperCase() + newName.slice(1).toLowerCase();

  await pool.query(
    'UPDATE characters SET char_name = ?, last_updated = NOW() WHERE char_name = ? AND discord_user_id = ? AND is_deleted = 0',
    [nameCap, char.char_name, userId]
  );

  return res.json({ ok: true });
});

// ── Recruitment applicant: update character realm ─────────────────────────────
router.post('/characters/:char_id/update-realm', express.json(), async (req, res) => {
  if (!req.session.recruit_discord_id) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }

  const userId = req.session.recruit_discord_id;
  const charId = parseInt(req.params.char_id);
  const realm = (req.body.realm || 'Icecrown').trim();

  const [[char]] = await pool.query(
    'SELECT id, char_name FROM characters WHERE id = ? AND discord_user_id = ? AND is_deleted = 0',
    [charId, userId]
  );

  if (!char) {
    return res.status(404).json({ error: 'Character not found.' });
  }

  const realmCap = realm.charAt(0).toUpperCase() + realm.slice(1).toLowerCase();

  await pool.query(
    'UPDATE characters SET realm = ?, last_updated = NOW() WHERE char_name = ? AND discord_user_id = ? AND is_deleted = 0',
    [realmCap, char.char_name, userId]
  );

  return res.json({ ok: true });
});

// ── Recruitment applicant: update character class ─────────────────────────────
router.post('/characters/:char_id/update-class', express.json(), async (req, res) => {
  if (!req.session.recruit_discord_id) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }

  const userId = req.session.recruit_discord_id;
  const charId = parseInt(req.params.char_id);
  const charClass = (req.body.char_class || '').trim() || null;

  const [[char]] = await pool.query(
    'SELECT id, char_name FROM characters WHERE id = ? AND discord_user_id = ? AND is_deleted = 0',
    [charId, userId]
  );

  if (!char) {
    return res.status(404).json({ error: 'Character not found.' });
  }

  await pool.query(
    'UPDATE characters SET char_class = ?, last_updated = NOW() WHERE char_name = ? AND discord_user_id = ? AND is_deleted = 0',
    [charClass, char.char_name, userId]
  );

  return res.json({ ok: true });
});

// ── Recruitment applicant: update character spec ──────────────────────────────
router.post('/characters/:char_id/update-spec', express.json(), async (req, res) => {
  if (!req.session.recruit_discord_id) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }

  const userId = req.session.recruit_discord_id;
  const charId = parseInt(req.params.char_id);
  const spec = (req.body.spec || '').trim() || null;

  const [[char]] = await pool.query(
    'SELECT id FROM characters WHERE id = ? AND discord_user_id = ? AND is_deleted = 0',
    [charId, userId]
  );

  if (!char) {
    return res.status(404).json({ error: 'Character not found.' });
  }

  await pool.query('UPDATE characters SET spec = ?, last_updated = NOW() WHERE id = ?', [spec, charId]);

  return res.json({ ok: true });
});

// ── Recruitment applicant: update character gearscore ────────────────────────
router.post('/characters/:char_id/update-gs', express.json(), async (req, res) => {
  if (!req.session.recruit_discord_id) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }

  const userId = req.session.recruit_discord_id;
  const charId = parseInt(req.params.char_id);
  const gearscore = parseGS(req.body.gearscore);

  const [[char]] = await pool.query(
    'SELECT id FROM characters WHERE id = ? AND discord_user_id = ? AND is_deleted = 0',
    [charId, userId]
  );

  if (!char) {
    return res.status(404).json({ error: 'Character not found.' });
  }

  await pool.query('UPDATE characters SET gearscore = ?, last_updated = NOW() WHERE id = ?', [gearscore, charId]);

  return res.json({ ok: true });
});

// ── Recruitment applicant: delete (soft-delete) a character spec ──────────────
router.post('/characters/:char_id/delete', express.json(), async (req, res) => {
  if (!req.session.recruit_discord_id) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }

  const userId = req.session.recruit_discord_id;
  const charId = parseInt(req.params.char_id);

  const [[char]] = await pool.query(
    'SELECT id FROM characters WHERE id = ? AND discord_user_id = ? AND is_deleted = 0',
    [charId, userId]
  );

  if (!char) {
    return res.status(404).json({ error: 'Character not found.' });
  }

  await pool.query('UPDATE characters SET is_deleted = 1 WHERE id = ?', [charId]);

  return res.json({ ok: true });
});

// ── OAuth callback (must be before /:form_id) ─────────────────────────────────

router.get('/oauth-callback', async (req, res) => {
  const { code, state } = req.query;

  if (!code) {
    req.session.flash = '❌ Discord authorisation failed.';
    return res.redirect('/');
  }

  const expectedState = req.session.recruit_oauth_state;
  delete req.session.recruit_oauth_state;

  if (!expectedState || state !== expectedState) {
    req.session.flash = '❌ Invalid OAuth state. Please try again.';
    return res.redirect('/');
  }

  const redirectUri =
    process.env.RECRUITMENT_DISCORD_REDIRECT_URI ||
    `${process.env.WEB_BASE_URL || 'http://localhost:8000'}/recruitment/oauth-callback`;

  try {
    const tokenRes = await fetch(DISCORD_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID || '',
        client_secret: process.env.DISCORD_CLIENT_SECRET || '',
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenRes.ok) {
      req.session.flash = '❌ Failed to exchange Discord token.';
      return res.redirect('/');
    }

    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

    const userRes = await fetch(DISCORD_USER_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!userRes.ok) {
      req.session.flash = '❌ Failed to fetch Discord user info.';
      return res.redirect('/');
    }
    const userData = await userRes.json();

    // Store recruit session data
    req.session.recruit_discord_id = userData.id;
    req.session.recruit_username = userData.username;
    req.session.recruit_display_name = userData.global_name || userData.username;

    const returnFormId = req.session.recruit_return_form_id || null;
    delete req.session.recruit_return_form_id;

    if (returnFormId) {
      return res.redirect(`/recruitment/${returnFormId}`);
    }
    return res.redirect('/');
  } catch (err) {
    console.error('[recruitment] OAuth callback error:', err);
    req.session.flash = '❌ An error occurred during Discord login. Please try again.';
    return res.redirect('/');
  }
});

// ── Admin: list forms ─────────────────────────────────────────────────────────

router.get('/', requireAdmin, async (req, res) => {
  const guildId = req.session.active_guild_id;

  const [forms] = await pool.query(
    `SELECT f.*,
            (SELECT COUNT(*) FROM recruitment_applications a WHERE a.form_id = f.id) AS application_count
       FROM recruitment_forms f
      WHERE f.guild_id = ?
      ORDER BY f.created_at DESC`,
    [guildId]
  );

  const baseUrl = process.env.WEB_BASE_URL || 'http://localhost:8000';

  res.render('recruitment_list.html', {
    forms,
    base_url: baseUrl,
    flash: popFlash(req),
    user: currentUser(req),
  });
});

// ── Admin: new form ───────────────────────────────────────────────────────────

router.get('/new', requireAdmin, async (req, res) => {
  res.render('recruitment_form_builder.html', {
    form: null,
    questions: [],
    flash: popFlash(req),
    user: currentUser(req),
  });
});

router.post('/new', requireAdmin, async (req, res) => {
  const guildId = req.session.active_guild_id;
  const title = String(req.body.title || '').trim();
  if (!title) {
    req.session.flash = '❌ Form title is required.';
    return res.redirect('/recruitment/new');
  }

  const description = String(req.body.description || '').trim() || null;

  let slug;
  try {
    slug = normaliseSlug(req.body.slug);
  } catch (msg) {
    req.session.flash = msg;
    return res.redirect('/recruitment/new');
  }

  let result;
  try {
    [result] = await pool.query(
      `INSERT INTO recruitment_forms
         (guild_id, title, description, is_active, created_by, slug)
       VALUES (?, ?, ?, 1, ?, ?)`,
      [guildId, title, description, req.session.user_id, slug]
    );
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      req.session.flash = '❌ That slug is already in use. Please choose a different one.';
      return res.redirect('/recruitment/new');
    }
    throw err;
  }
  const formId = result.insertId;

  const questions = parseQuestions(req.body);
  for (const q of questions) {
    await pool.query(
      `INSERT INTO recruitment_questions
         (form_id, question_text, question_type, options, is_required, sort_order,
          default_value, group_key, group_label, is_group_repeatable, col_width)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [formId, q.question_text, q.question_type, q.options, q.is_required, q.sort_order,
       q.default_value, q.group_key, q.group_label, q.is_group_repeatable, q.col_width]
    );
  }
  res.redirect(`/recruitment/${formId}/applications`);
});

// ── Admin: edit form ──────────────────────────────────────────────────────────

router.get('/:form_id/edit-form', requireAdmin, async (req, res) => {
  const guildId = req.session.active_guild_id;
  const formId = parseInt(req.params.form_id, 10);
  if (!formId) return res.redirect('/recruitment');

  const [[form]] = await pool.query(
    'SELECT * FROM recruitment_forms WHERE id = ? AND guild_id = ?',
    [formId, guildId]
  );
  if (!form) {
    req.session.flash = '❌ Form not found.';
    return res.redirect('/recruitment');
  }

  const [questions] = await pool.query(
    'SELECT * FROM recruitment_questions WHERE form_id = ? ORDER BY sort_order',
    [formId]
  );

  // Pre-process options_parsed so the builder template can render existing option lists
  const questionsForBuilder = questions.map(q => ({
    ...q,
    options_parsed: q.options ? JSON.parse(q.options) : [],
  }));

  res.render('recruitment_form_builder.html', {
    form,
    questions: questionsForBuilder,
    flash: popFlash(req),
    user: currentUser(req),
  });
});

router.post('/:form_id/edit-form', requireAdmin, async (req, res) => {
  const guildId = req.session.active_guild_id;
  const formId = parseInt(req.params.form_id, 10);
  if (!formId) return res.redirect('/recruitment');

  const [[form]] = await pool.query(
    'SELECT id FROM recruitment_forms WHERE id = ? AND guild_id = ?',
    [formId, guildId]
  );
  if (!form) {
    req.session.flash = '❌ Form not found.';
    return res.redirect('/recruitment');
  }

  const title = String(req.body.title || '').trim();
  if (!title) {
    req.session.flash = '❌ Form title is required.';
    return res.redirect(`/recruitment/${formId}/edit-form`);
  }

  const description = String(req.body.description || '').trim() || null;

  let slug;
  try {
    slug = normaliseSlug(req.body.slug);
  } catch (msg) {
    req.session.flash = msg;
    return res.redirect(`/recruitment/${formId}/edit-form`);
  }

  try {
    await pool.query(
      `UPDATE recruitment_forms
          SET title = ?, description = ?, slug = ?
        WHERE id = ?`,
      [title, description, slug, formId]
    );
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      req.session.flash = '❌ That slug is already in use. Please choose a different one.';
      return res.redirect(`/recruitment/${formId}/edit-form`);
    }
    throw err;
  }

  // Replace questions
  await pool.query('DELETE FROM recruitment_questions WHERE form_id = ?', [formId]);
  const questions = parseQuestions(req.body);
  for (const q of questions) {
    await pool.query(
      `INSERT INTO recruitment_questions
         (form_id, question_text, question_type, options, is_required, sort_order,
          default_value, group_key, group_label, is_group_repeatable, col_width)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [formId, q.question_text, q.question_type, q.options, q.is_required, q.sort_order,
       q.default_value, q.group_key, q.group_label, q.is_group_repeatable, q.col_width]
    );
  }

  req.session.flash = '✅ Form updated.';
  res.redirect(`/recruitment/${formId}/edit-form`);
});

// ── Admin: toggle active ──────────────────────────────────────────────────────

router.post('/:form_id/toggle', requireAdmin, async (req, res) => {
  const guildId = req.session.active_guild_id;
  const formId = parseInt(req.params.form_id, 10);
  if (!formId) return res.redirect('/recruitment');

  await pool.query(
    `UPDATE recruitment_forms
        SET is_active = 1 - is_active
      WHERE id = ? AND guild_id = ?`,
    [formId, guildId]
  );
  res.redirect('/recruitment');
});

// ── Admin: applications list ──────────────────────────────────────────────────

router.get('/:form_id/applications', requireAdmin, async (req, res) => {
  const guildId = req.session.active_guild_id;
  const formId = parseInt(req.params.form_id, 10);
  if (!formId) return res.redirect('/recruitment');

  const [[form]] = await pool.query(
    'SELECT * FROM recruitment_forms WHERE id = ? AND guild_id = ?',
    [formId, guildId]
  );
  if (!form) {
    req.session.flash = '❌ Form not found.';
    return res.redirect('/recruitment');
  }

  const statusFilter = req.query.status || 'all';
  let query =
    'SELECT * FROM recruitment_applications WHERE form_id = ? ORDER BY submitted_at DESC';
  let params = [formId];

  if (['pending', 'accepted', 'rejected'].includes(statusFilter)) {
    query =
      'SELECT * FROM recruitment_applications WHERE form_id = ? AND status = ? ORDER BY submitted_at DESC';
    params = [formId, statusFilter];
  }

  const [applications] = await pool.query(query, params);

  res.render('recruitment_applications.html', {
    form,
    applications,
    status_filter: statusFilter,
    flash: popFlash(req),
    user: currentUser(req),
  });
});

// ── Admin: view single application ────────────────────────────────────────────

router.get('/:form_id/applications/:app_id', requireAdmin, async (req, res) => {
  const guildId = req.session.active_guild_id;
  const formId = parseInt(req.params.form_id, 10);
  const appId = parseInt(req.params.app_id, 10);
  if (!formId || !appId) return res.redirect('/recruitment');

  const [[form]] = await pool.query(
    'SELECT * FROM recruitment_forms WHERE id = ? AND guild_id = ?',
    [formId, guildId]
  );
  if (!form) {
    req.session.flash = '❌ Form not found.';
    return res.redirect('/recruitment');
  }

  const [[application]] = await pool.query(
    'SELECT * FROM recruitment_applications WHERE id = ? AND form_id = ?',
    [appId, formId]
  );
  if (!application) {
    req.session.flash = '❌ Application not found.';
    return res.redirect(`/recruitment/${formId}/applications`);
  }

  const [questions] = await pool.query(
    'SELECT * FROM recruitment_questions WHERE form_id = ? ORDER BY sort_order',
    [formId]
  );

  const [answers] = await pool.query(
    'SELECT * FROM recruitment_answers WHERE application_id = ?',
    [appId]
  );

  // Build Q&A pairs; format JSON-array answers (repeatable groups) as readable lists.
  // For 'characters' type, resolve IDs to character names.
  const answerMap = {};
  for (const a of answers) answerMap[String(a.question_id)] = a.answer_text;

  // Pre-fetch characters referenced by any 'characters' type answer
  const allCharIds = [];
  for (const q of questions) {
    if (q.question_type !== 'characters') continue;
    const raw = answerMap[String(q.id)] || '[]';
    try {
      const ids = JSON.parse(raw);
      if (Array.isArray(ids)) allCharIds.push(...ids.map(id => parseInt(id)).filter(id => !isNaN(id)));
    } catch { /* ignore */ }
  }
  const charsById = {};
  if (allCharIds.length > 0) {
    const placeholders = allCharIds.map(() => '?').join(',');
    const [charRows] = await pool.query(
      `SELECT id, char_name, char_class, spec, gearscore FROM characters WHERE id IN (${placeholders}) AND is_deleted = 0`,
      allCharIds
    );
    for (const c of charRows) charsById[c.id] = c;
  }

  const qa = questions.map(q => {
    const raw = answerMap[String(q.id)] || '';
    let answer = raw;
    if (q.question_type === 'characters') {
      try {
        const ids = JSON.parse(raw || '[]');
        if (Array.isArray(ids) && ids.length > 0) {
          answer = ids.map(id => {
            const c = charsById[id];
            if (!c) return `#${id}`;
            let s = c.char_name;
            if (c.char_class) s += ` (${c.char_class}`;
            if (c.spec) s += `/${c.spec}`;
            if (c.gearscore) s += ` – ${c.gearscore >= BIS_GS ? 'BiS' : Math.floor(c.gearscore)} GS`;
            if (c.char_class) s += ')';
            return s;
          }).join(', ');
        } else {
          answer = '(no characters selected)';
        }
      } catch {
        answer = raw;
      }
    } else if (raw.startsWith('[')) {
      try {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          // If it's a 2D array (repeatable group with checkboxes), flatten or join specially
          if (arr.length > 0 && Array.isArray(arr[0])) {
            answer = arr.map(sub => sub.join(', ')).join(' | ');
          } else {
            answer = arr.join(', ');
          }
        }
      } catch { /* keep raw */ }
    }
    return { question: q.question_text, answer };
  });

  res.render('recruitment_application_detail.html', {
    form,
    application,
    qa,
    flash: popFlash(req),
    user: currentUser(req),
  });
});

// ── Admin: accept application ─────────────────────────────────────────────────

router.post('/:form_id/applications/:app_id/accept', requireAdmin, async (req, res) => {
  const guildId = req.session.active_guild_id;
  const formId = parseInt(req.params.form_id, 10);
  const appId = parseInt(req.params.app_id, 10);
  if (!formId || !appId) return res.redirect('/recruitment');

  const [[form]] = await pool.query(
    'SELECT * FROM recruitment_forms WHERE id = ? AND guild_id = ?',
    [formId, guildId]
  );
  const [[application]] = await pool.query(
    'SELECT * FROM recruitment_applications WHERE id = ? AND form_id = ?',
    [appId, formId]
  );

  if (!form || !application) {
    req.session.flash = '❌ Application not found.';
    return res.redirect(`/recruitment/${formId}/applications`);
  }

  await pool.query(
    `UPDATE recruitment_applications
        SET status = 'accepted', reviewed_by = ?, reviewed_at = NOW()
      WHERE id = ?`,
    [req.session.user_id, appId]
  );

  // Send acceptance DM and notification channel ping
  const guildName = req.session.active_guild_name || 'the guild';
  const acceptMsg = `🎉 Congratulations, **${application.applicant_display_name}**! Your application to **${guildName}** has been **accepted**. Welcome aboard!`;
  const dmResult = await sendDiscordDM(application.applicant_discord_id, acceptMsg);
  if (!dmResult.ok) {
    console.warn('[recruitment] Failed to send acceptance DM:', dmResult.reason);
  }
  const pingResult = await sendNotificationChannelPing(
    application.applicant_discord_id,
    acceptMsg
  );
  if (!pingResult.ok) {
    console.warn('[recruitment] Failed to send acceptance channel ping:', pingResult.reason);
  }

  req.session.flash = `✅ Application from ${application.applicant_display_name} accepted.`;
  res.redirect(`/recruitment/${formId}/applications`);
});

// ── Admin: reject application ─────────────────────────────────────────────────

router.post('/:form_id/applications/:app_id/reject', requireAdmin, async (req, res) => {
  const guildId = req.session.active_guild_id;
  const formId = parseInt(req.params.form_id, 10);
  const appId = parseInt(req.params.app_id, 10);
  if (!formId || !appId) return res.redirect('/recruitment');

  const [[form]] = await pool.query(
    'SELECT id FROM recruitment_forms WHERE id = ? AND guild_id = ?',
    [formId, guildId]
  );
  const [[application]] = await pool.query(
    'SELECT * FROM recruitment_applications WHERE id = ? AND form_id = ?',
    [appId, formId]
  );

  if (!form || !application) {
    req.session.flash = '❌ Application not found.';
    return res.redirect(`/recruitment/${formId}/applications`);
  }

  await pool.query(
    `UPDATE recruitment_applications
        SET status = 'rejected', reviewed_by = ?, reviewed_at = NOW()
      WHERE id = ?`,
    [req.session.user_id, appId]
  );

  // Send rejection DM and notification channel ping
  const guildName = req.session.active_guild_name || 'the guild';
  const rejectMsg = `Thank you for your interest in **${guildName}**. After reviewing your application, we have decided not to proceed at this time. We wish you the best!`;
  const dmResult = await sendDiscordDM(application.applicant_discord_id, rejectMsg);
  if (!dmResult.ok) {
    console.warn('[recruitment] Failed to send rejection DM:', dmResult.reason);
  }
  const pingResult = await sendNotificationChannelPing(
    application.applicant_discord_id,
    rejectMsg
  );
  if (!pingResult.ok) {
    console.warn('[recruitment] Failed to send rejection channel ping:', pingResult.reason);
  }

  req.session.flash = `Application from ${application.applicant_display_name} rejected.`;
  res.redirect(`/recruitment/${formId}/applications`);
});

// ── Public: view / start application ─────────────────────────────────────────
// This must come AFTER all more specific GET routes above.

router.get('/:form_id', async (req, res) => {
  const form = await resolveFormParam(req.params.form_id, true);
  if (!form) {
    req.session.flash = '❌ This recruitment form is not available.';
    return res.redirect('/');
  }
  const formId = form.id;

  // Require Discord recruitment auth
  if (!req.session.recruit_discord_id) {
    req.session.recruit_return_form_id = formId;
    return redirectToRecruitmentOAuth(req, res, formId);
  }

  // Duplicate application guard: pending or accepted → redirect to edit
  const [[existing]] = await pool.query(
    `SELECT id FROM recruitment_applications
      WHERE form_id = ? AND applicant_discord_id = ? AND status IN ('pending','accepted')`,
    [formId, req.session.recruit_discord_id]
  );
  if (existing) {
    req.session.flash =
      '📝 You already have an active application — you can view or edit it below.';
    return res.redirect(`/recruitment/${formId}/edit`);
  }

  const [questions] = await pool.query(
    'SELECT * FROM recruitment_questions WHERE form_id = ? ORDER BY sort_order',
    [formId]
  );

  // Parse options for select/radio questions
  const questionsForTemplate = questions.map(q => ({
    ...q,
    options_parsed: q.options ? JSON.parse(q.options) : [],
  }));

  const blocks = buildQuestionBlocks(questionsForTemplate);
  // For a new application, all group blocks start with one blank instance
  for (const b of blocks) {
    if (b.type === 'group') b.instances = [{}];
  }

  // Fetch the applicant's registered characters for any 'characters' type questions.
  // All characters are pre-selected by default on a fresh application.
  let applicantCharacters = [];
  const preselectedCharsByQuestion = {};
  const hasCharsQuestion = questionsForTemplate.some(q => q.question_type === 'characters');
  if (hasCharsQuestion) {
    [applicantCharacters] = await pool.query(
      'SELECT id, char_name, realm, char_class, spec, gearscore FROM characters WHERE discord_user_id = ? AND is_deleted = 0 ORDER BY char_name ASC',
      [req.session.recruit_discord_id]
    );
    for (const q of questionsForTemplate.filter(q => q.question_type === 'characters')) {
      preselectedCharsByQuestion[String(q.id)] = applicantCharacters.map(c => c.id);
    }
  }

  res.render('recruitment_apply.html', {
    form,
    questions: questionsForTemplate,
    blocks,
    recruit_username: req.session.recruit_username,
    recruit_display_name: req.session.recruit_display_name,
    is_editing: false,
    application: null,
    existing_answers: {},
    display_answers: {},
    applicant_characters: applicantCharacters,
    preselected_chars_by_question: preselectedCharsByQuestion,
    flash: popFlash(req),
    user: currentUser(req),
  });
});

// ── Public: submit application ────────────────────────────────────────────────

router.post('/:form_id/submit', async (req, res) => {
  const form = await resolveFormParam(req.params.form_id, true);
  if (!form) {
    req.session.flash = '❌ This recruitment form is not available.';
    return res.redirect('/');
  }
  const formId = form.id;

  if (!req.session.recruit_discord_id) {
    req.session.recruit_return_form_id = formId;
    return redirectToRecruitmentOAuth(req, res, formId);
  }

  // Duplicate guard
  const [[existing]] = await pool.query(
    `SELECT id FROM recruitment_applications
      WHERE form_id = ? AND applicant_discord_id = ? AND status IN ('pending','accepted')`,
    [formId, req.session.recruit_discord_id]
  );
  if (existing) {
    req.session.flash =
      '📝 You already have an active application — you can view or edit it below.';
    return res.redirect(`/recruitment/${formId}/edit`);
  }

  const [questions] = await pool.query(
    'SELECT * FROM recruitment_questions WHERE form_id = ? ORDER BY sort_order',
    [formId]
  );

  // Validate required fields
  for (const q of questions) {
    if (q.is_required) {
      if (q.question_type === 'characters') {
        const selected = [].concat(req.body[`char_sel_${q.id}`] || []);
        if (selected.length === 0) {
          req.session.flash = `❌ Please select at least one character for: "${q.question_text}"`;
          return res.redirect(`/recruitment/${formId}`);
        }
      } else if (q.question_type === 'checkbox') {
        const key = (q.is_group_repeatable && q.group_key) ? `answer_${q.id}_0` : `answer_${q.id}`;
        const selected = [].concat(req.body[key] || []);
        if (selected.filter(Boolean).length === 0) {
          req.session.flash = `❌ Please select at least one option for: "${q.question_text}"`;
          return res.redirect(`/recruitment/${formId}`);
        }
      } else {
        // Repeatable-group questions are indexed; check index 0
        const key = (q.is_group_repeatable && q.group_key)
          ? `answer_${q.id}_0`
          : `answer_${q.id}`;
        const answer = String(req.body[key] || '').trim();
        if (!answer) {
          req.session.flash = `❌ Please answer: "${q.question_text}"`;
          return res.redirect(`/recruitment/${formId}`);
        }
      }
    }
  }

  const [appResult] = await pool.query(
    `INSERT INTO recruitment_applications
       (form_id, guild_id, applicant_discord_id, applicant_username, applicant_display_name,
        status)
     VALUES (?, ?, ?, ?, ?, 'pending')`,
    [
      formId,
      form.guild_id,
      req.session.recruit_discord_id,
      req.session.recruit_username,
      req.session.recruit_display_name,
    ]
  );
  const appId = appResult.insertId;

  for (const q of questions) {
    let answerText;
    if (q.question_type === 'characters') {
      // Store selected character IDs as a JSON array
      const selected = [].concat(req.body[`char_sel_${q.id}`] || []);
      answerText = JSON.stringify(selected.map(id => parseInt(id)).filter(id => !isNaN(id)));
    } else if (q.question_type === 'checkbox') {
      if (q.is_group_repeatable && q.group_key) {
        const values = [];
        let idx = 0;
        while (req.body[`answer_${q.id}_${idx}`] !== undefined) {
          const selected = [].concat(req.body[`answer_${q.id}_${idx}`] || []);
          values.push(selected.filter(Boolean));
          idx++;
        }
        answerText = values.length > 0 ? JSON.stringify(values) : '';
      } else {
        const selected = [].concat(req.body[`answer_${q.id}`] || []);
        answerText = JSON.stringify(selected.filter(Boolean));
      }
    } else if (q.is_group_repeatable && q.group_key) {
      // Collect all indexed values and store as JSON array
      const values = [];
      let idx = 0;
      while (req.body[`answer_${q.id}_${idx}`] !== undefined) {
        values.push(String(req.body[`answer_${q.id}_${idx}`] || '').trim());
        idx++;
      }
      answerText = values.length > 0 ? JSON.stringify(values) : '';
    } else {
      answerText = String(req.body[`answer_${q.id}`] || '').trim();
    }
    await pool.query(
      'INSERT INTO recruitment_answers (application_id, question_id, answer_text) VALUES (?, ?, ?)',
      [appId, q.id, answerText]
    );
  }

  req.session.flash = '✅ Your application has been submitted successfully!';
  res.redirect(`/recruitment/${formId}/edit`);
});

// ── Public: edit / view own application ───────────────────────────────────────

router.get('/:form_id/edit', async (req, res) => {
  const form = await resolveFormParam(req.params.form_id);
  if (!form) {
    req.session.flash = '❌ Form not found.';
    return res.redirect('/');
  }
  const formId = form.id;

  if (!req.session.recruit_discord_id) {
    req.session.recruit_return_form_id = formId;
    return redirectToRecruitmentOAuth(req, res, formId);
  }

  const [[application]] = await pool.query(
    `SELECT * FROM recruitment_applications
      WHERE form_id = ? AND applicant_discord_id = ?
      ORDER BY submitted_at DESC LIMIT 1`,
    [formId, req.session.recruit_discord_id]
  );

  if (!application) {
    return res.redirect(`/recruitment/${formId}`);
  }

  const [questions] = await pool.query(
    'SELECT * FROM recruitment_questions WHERE form_id = ? ORDER BY sort_order',
    [formId]
  );

  const [answers] = await pool.query(
    'SELECT * FROM recruitment_answers WHERE application_id = ?',
    [application.id]
  );

  const existingAnswers = {};
  for (const a of answers) existingAnswers[String(a.question_id)] = a.answer_text;

  const questionsForTemplate = questions.map(q => ({
    ...q,
    options_parsed: q.options ? JSON.parse(q.options) : [],
  }));

  const blocks = buildQuestionBlocks(questionsForTemplate);
  const groupInstances = buildExistingGroupInstances(blocks, existingAnswers);
  // Attach instances to group blocks
  for (const b of blocks) {
    if (b.type === 'group') {
      const inst = groupInstances[b.key];
      b.instances = (inst && inst.length > 0) ? inst : [{}];
    }
  }

  // Fetch the applicant's registered characters for any 'characters' type questions.
  // Pre-select only the IDs stored in the existing answer (or all if no answer yet).
  let applicantCharacters = [];
  const preselectedCharsByQuestion = {};
  const hasCharsQuestion = questionsForTemplate.some(q => q.question_type === 'characters');
  if (hasCharsQuestion) {
    [applicantCharacters] = await pool.query(
      'SELECT id, char_name, realm, char_class, spec, gearscore FROM characters WHERE discord_user_id = ? AND is_deleted = 0 ORDER BY char_name ASC',
      [req.session.recruit_discord_id]
    );
    for (const q of questionsForTemplate.filter(q => q.question_type === 'characters')) {
      const raw = existingAnswers[String(q.id)];
      if (raw && raw.startsWith('[')) {
        try {
          const ids = JSON.parse(raw);
          preselectedCharsByQuestion[String(q.id)] = Array.isArray(ids)
            ? ids.map(id => parseInt(id)).filter(id => !isNaN(id))
            : applicantCharacters.map(c => c.id);
        } catch {
          preselectedCharsByQuestion[String(q.id)] = applicantCharacters.map(c => c.id);
        }
      } else {
        preselectedCharsByQuestion[String(q.id)] = applicantCharacters.map(c => c.id);
      }
    }
  }

  // Build display-friendly answers (format JSON arrays for read-only view).
  // For 'characters' questions, look up names from the DB.
  const charsById = Object.fromEntries(applicantCharacters.map(c => [c.id, c]));
  const displayAnswers = {};
  for (const [qid, raw] of Object.entries(existingAnswers)) {
    const q = questionsForTemplate.find(qq => String(qq.id) === qid);
    if (q && q.question_type === 'characters' && raw && raw.startsWith('[')) {
      try {
        const ids = JSON.parse(raw);
        if (Array.isArray(ids) && ids.length > 0) {
          // Fetch full details for any chars not already in applicantCharacters
          const missingIds = ids.filter(id => !charsById[id]);
          let extraChars = [];
          if (missingIds.length > 0) {
            const placeholders = missingIds.map(() => '?').join(',');
            [extraChars] = await pool.query(
              `SELECT id, char_name, char_class, spec, gearscore FROM characters WHERE id IN (${placeholders}) AND is_deleted = 0`,
              missingIds
            );
            for (const c of extraChars) charsById[c.id] = c;
          }
          displayAnswers[qid] = ids.map(id => {
            const c = charsById[id];
            if (!c) return `#${id}`;
            let s = c.char_name;
            if (c.char_class) s += ` (${c.char_class}`;
            if (c.spec) s += `/${c.spec}`;
            if (c.gearscore) s += ` – ${c.gearscore >= BIS_GS ? 'BiS' : Math.floor(c.gearscore)} GS`;
            if (c.char_class) s += ')';
            return s;
          }).join(', ');
        } else {
          displayAnswers[qid] = '(no characters selected)';
        }
      } catch {
        displayAnswers[qid] = raw;
      }
    } else if (raw && raw.startsWith('[')) {
      try {
        const arr = JSON.parse(raw);
        displayAnswers[qid] = Array.isArray(arr) ? arr.join(' | ') : raw;
      } catch {
        displayAnswers[qid] = raw;
      }
    } else {
      displayAnswers[qid] = raw;
    }
  }

  res.render('recruitment_apply.html', {
    form,
    questions: questionsForTemplate,
    blocks,
    recruit_username: req.session.recruit_username,
    recruit_display_name: req.session.recruit_display_name,
    is_editing: true,
    application,
    existing_answers: existingAnswers,
    display_answers: displayAnswers,
    applicant_characters: applicantCharacters,
    preselected_chars_by_question: preselectedCharsByQuestion,
    flash: popFlash(req),
    user: currentUser(req),
  });
});

router.post('/:form_id/edit', async (req, res) => {
  const form = await resolveFormParam(req.params.form_id);
  if (!form) return res.redirect('/');
  const formId = form.id;

  if (!req.session.recruit_discord_id) {
    req.session.recruit_return_form_id = formId;
    return redirectToRecruitmentOAuth(req, res, formId);
  }

  const [[application]] = await pool.query(
    `SELECT * FROM recruitment_applications
      WHERE form_id = ? AND applicant_discord_id = ? AND status = 'pending'
      ORDER BY submitted_at DESC LIMIT 1`,
    [formId, req.session.recruit_discord_id]
  );

  if (!application) {
    req.session.flash = '❌ No editable application found.';
    return res.redirect(`/recruitment/${formId}/edit`);
  }

  const [questions] = await pool.query(
    'SELECT * FROM recruitment_questions WHERE form_id = ? ORDER BY sort_order',
    [formId]
  );

  // Validate required fields
  for (const q of questions) {
    if (q.is_required) {
      if (q.question_type === 'characters') {
        const selected = [].concat(req.body[`char_sel_${q.id}`] || []);
        if (selected.length === 0) {
          req.session.flash = `❌ Please select at least one character for: "${q.question_text}"`;
          return res.redirect(`/recruitment/${formId}/edit`);
        }
      } else if (q.question_type === 'checkbox') {
        const key = (q.is_group_repeatable && q.group_key) ? `answer_${q.id}_0` : `answer_${q.id}`;
        const selected = [].concat(req.body[key] || []);
        if (selected.filter(Boolean).length === 0) {
          req.session.flash = `❌ Please select at least one option for: "${q.question_text}"`;
          return res.redirect(`/recruitment/${formId}/edit`);
        }
      } else {
        const key = (q.is_group_repeatable && q.group_key)
          ? `answer_${q.id}_0`
          : `answer_${q.id}`;
        const answer = String(req.body[key] || '').trim();
        if (!answer) {
          req.session.flash = `❌ Please answer: "${q.question_text}"`;
          return res.redirect(`/recruitment/${formId}/edit`);
        }
      }
    }
  }

  // Delete old answers and re-insert
  await pool.query('DELETE FROM recruitment_answers WHERE application_id = ?', [application.id]);
  for (const q of questions) {
    let answerText;
    if (q.question_type === 'characters') {
      const selected = [].concat(req.body[`char_sel_${q.id}`] || []);
      answerText = JSON.stringify(selected.map(id => parseInt(id)).filter(id => !isNaN(id)));
    } else if (q.question_type === 'checkbox') {
      if (q.is_group_repeatable && q.group_key) {
        const values = [];
        let idx = 0;
        while (req.body[`answer_${q.id}_${idx}`] !== undefined) {
          const selected = [].concat(req.body[`answer_${q.id}_${idx}`] || []);
          values.push(selected.filter(Boolean));
          idx++;
        }
        answerText = values.length > 0 ? JSON.stringify(values) : '';
      } else {
        const selected = [].concat(req.body[`answer_${q.id}`] || []);
        answerText = JSON.stringify(selected.filter(Boolean));
      }
    } else if (q.is_group_repeatable && q.group_key) {
      const values = [];
      let idx = 0;
      while (req.body[`answer_${q.id}_${idx}`] !== undefined) {
        values.push(String(req.body[`answer_${q.id}_${idx}`] || '').trim());
        idx++;
      }
      answerText = values.length > 0 ? JSON.stringify(values) : '';
    } else {
      answerText = String(req.body[`answer_${q.id}`] || '').trim();
    }
    await pool.query(
      'INSERT INTO recruitment_answers (application_id, question_id, answer_text) VALUES (?, ?, ?)',
      [application.id, q.id, answerText]
    );
  }

  req.session.flash = '✅ Your application has been updated.';
  res.redirect(`/recruitment/${formId}/edit`);
});

// ── OAuth redirect helper ─────────────────────────────────────────────────────

function redirectToRecruitmentOAuth(req, res) {
  const state = crypto.randomBytes(32).toString('hex');
  req.session.recruit_oauth_state = state;

  const redirectUri =
    process.env.RECRUITMENT_DISCORD_REDIRECT_URI ||
    `${process.env.WEB_BASE_URL || 'http://localhost:8000'}/recruitment/oauth-callback`;

  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID || '',
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'identify',
    state,
  });

  res.redirect(`${DISCORD_OAUTH_URL}?${params.toString()}`);
}

module.exports = router;
