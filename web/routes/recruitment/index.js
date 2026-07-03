const express = require('express');
const pool = require('../../db');
const { BIS_GS, parseGS, popFlash, currentUser } = require('../helpers');
const {
  DISCORD_API,
  DISCORD_OAUTH_URL,
  DISCORD_TOKEN_URL,
  DISCORD_USER_URL,
  NOTIFY_GUILD_ID,
  NOTIFY_CHANNEL_ID,
  NOTIFY_INVITE_URL,
  sendNotificationChannelPing,
  sendDiscordDM,
  redirectToRecruitmentOAuth,
} = require('./discord');
const {
  RESERVED_SLUGS,
  normaliseSlug,
  resolveFormParam,
  parseQuestions,
  buildQuestionBlocks,
  buildExistingGroupInstances,
} = require('./helpers');

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

  const guildId = req.session.recruit_guild_id || null;

  const [[existing]] = await pool.query(
    `SELECT id FROM characters
     WHERE discord_user_id = ? AND guild_id <=> ? AND char_name = ? AND realm = ?
       AND (spec <=> ?)
     LIMIT 1`,
    [userId, guildId, charNameCap, realmCap, specNorm]
  );

  let charId;
  if (existing) {
    await pool.query(
      'UPDATE characters SET char_class = ?, gearscore = ?, is_deleted = 0, last_updated = NOW() WHERE id = ? AND guild_id <=> ?',
      [charClass, gearscore, existing.id, guildId]
    );
    charId = existing.id;
  } else {
    const [result] = await pool.query(
      `INSERT INTO characters (discord_user_id, guild_id, char_name, realm, char_class, spec, gearscore, is_deleted, last_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, NOW())`,
      [userId, guildId, charNameCap, realmCap, charClass, specNorm, gearscore]
    );
    charId = result.insertId;
  }

  const [[char]] = await pool.query(
    'SELECT id, char_name, realm, char_class, spec, gearscore FROM characters WHERE id = ? AND guild_id <=> ?',
    [charId, guildId]
  );

  return res.json({ ok: true, character: char });
});

// ── Recruitment applicant: update character name ──────────────────────────────
router.post('/characters/:char_id/update-name', express.json(), async (req, res) => {
  if (!req.session.recruit_discord_id) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }

  const userId = req.session.recruit_discord_id;
  const guildId = req.session.recruit_guild_id || null;
  const charId = parseInt(req.params.char_id);
  const newName = (req.body.char_name || '').trim();

  if (!newName) {
    return res.status(400).json({ error: 'Character name is required.' });
  }

  const [[char]] = await pool.query(
    'SELECT id, char_name FROM characters WHERE id = ? AND discord_user_id = ? AND guild_id <=> ? AND is_deleted = 0',
    [charId, userId, guildId]
  );

  if (!char) {
    return res.status(404).json({ error: 'Character not found.' });
  }

  const nameCap = newName.charAt(0).toUpperCase() + newName.slice(1).toLowerCase();

  await pool.query(
    'UPDATE characters SET char_name = ?, last_updated = NOW() WHERE char_name = ? AND discord_user_id = ? AND guild_id <=> ? AND is_deleted = 0',
    [nameCap, char.char_name, userId, guildId]
  );

  return res.json({ ok: true });
});

// ── Recruitment applicant: update character realm ─────────────────────────────
router.post('/characters/:char_id/update-realm', express.json(), async (req, res) => {
  if (!req.session.recruit_discord_id) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }

  const userId = req.session.recruit_discord_id;
  const guildId = req.session.recruit_guild_id || null;
  const charId = parseInt(req.params.char_id);
  const realm = (req.body.realm || 'Icecrown').trim();

  const [[char]] = await pool.query(
    'SELECT id, char_name FROM characters WHERE id = ? AND discord_user_id = ? AND guild_id <=> ? AND is_deleted = 0',
    [charId, userId, guildId]
  );

  if (!char) {
    return res.status(404).json({ error: 'Character not found.' });
  }

  const realmCap = realm.charAt(0).toUpperCase() + realm.slice(1).toLowerCase();

  await pool.query(
    'UPDATE characters SET realm = ?, last_updated = NOW() WHERE char_name = ? AND discord_user_id = ? AND guild_id <=> ? AND is_deleted = 0',
    [realmCap, char.char_name, userId, guildId]
  );

  return res.json({ ok: true });
});

// ── Recruitment applicant: update character class ─────────────────────────────
router.post('/characters/:char_id/update-class', express.json(), async (req, res) => {
  if (!req.session.recruit_discord_id) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }

  const userId = req.session.recruit_discord_id;
  const guildId = req.session.recruit_guild_id || null;
  const charId = parseInt(req.params.char_id);
  const charClass = (req.body.char_class || '').trim() || null;

  const [[char]] = await pool.query(
    'SELECT id, char_name FROM characters WHERE id = ? AND discord_user_id = ? AND guild_id <=> ? AND is_deleted = 0',
    [charId, userId, guildId]
  );

  if (!char) {
    return res.status(404).json({ error: 'Character not found.' });
  }

  await pool.query(
    'UPDATE characters SET char_class = ?, last_updated = NOW() WHERE char_name = ? AND discord_user_id = ? AND guild_id <=> ? AND is_deleted = 0',
    [charClass, char.char_name, userId, guildId]
  );

  return res.json({ ok: true });
});

// ── Recruitment applicant: update character spec ──────────────────────────────
router.post('/characters/:char_id/update-spec', express.json(), async (req, res) => {
  if (!req.session.recruit_discord_id) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }

  const userId = req.session.recruit_discord_id;
  const guildId = req.session.recruit_guild_id || null;
  const charId = parseInt(req.params.char_id);
  const spec = (req.body.spec || '').trim() || null;

  const [[char]] = await pool.query(
    'SELECT id FROM characters WHERE id = ? AND discord_user_id = ? AND guild_id <=> ? AND is_deleted = 0',
    [charId, userId, guildId]
  );

  if (!char) {
    return res.status(404).json({ error: 'Character not found.' });
  }

  await pool.query('UPDATE characters SET spec = ?, last_updated = NOW() WHERE id = ? AND guild_id <=> ?', [spec, charId, guildId]);

  return res.json({ ok: true });
});

// ── Recruitment applicant: update character gearscore ────────────────────────
router.post('/characters/:char_id/update-gs', express.json(), async (req, res) => {
  if (!req.session.recruit_discord_id) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }

  const userId = req.session.recruit_discord_id;
  const guildId = req.session.recruit_guild_id || null;
  const charId = parseInt(req.params.char_id);
  const gearscore = parseGS(req.body.gearscore);

  const [[char]] = await pool.query(
    'SELECT id FROM characters WHERE id = ? AND discord_user_id = ? AND guild_id <=> ? AND is_deleted = 0',
    [charId, userId, guildId]
  );

  if (!char) {
    return res.status(404).json({ error: 'Character not found.' });
  }

  await pool.query('UPDATE characters SET gearscore = ?, last_updated = NOW() WHERE id = ? AND guild_id <=> ?', [gearscore, charId, guildId]);

  return res.json({ ok: true });
});

// ── Recruitment applicant: delete (soft-delete) a character spec ──────────────
router.post('/characters/:char_id/delete', express.json(), async (req, res) => {
  if (!req.session.recruit_discord_id) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }

  const userId = req.session.recruit_discord_id;
  const guildId = req.session.recruit_guild_id || null;
  const charId = parseInt(req.params.char_id);

  const [[char]] = await pool.query(
    'SELECT id FROM characters WHERE id = ? AND discord_user_id = ? AND guild_id <=> ? AND is_deleted = 0',
    [charId, userId, guildId]
  );

  if (!char) {
    return res.status(404).json({ error: 'Character not found.' });
  }

  await pool.query('UPDATE characters SET is_deleted = 1 WHERE id = ? AND guild_id <=> ?', [charId, guildId]);

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
      `SELECT id, char_name, char_class, spec, gearscore FROM characters WHERE id IN (${placeholders}) AND guild_id = ? AND is_deleted = 0`,
      [...allCharIds, form.guild_id]
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

  // Store the guild context for character registration/updates
  req.session.recruit_guild_id = form.guild_id;

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
      'SELECT id, char_name, realm, char_class, spec, gearscore FROM characters WHERE discord_user_id = ? AND guild_id = ? AND is_deleted = 0 ORDER BY char_name ASC',
      [req.session.recruit_discord_id, form.guild_id]
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

  // Store the guild context for character registration/updates
  req.session.recruit_guild_id = form.guild_id;

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

  // Store the guild context for character registration/updates
  req.session.recruit_guild_id = form.guild_id;

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
      'SELECT id, char_name, realm, char_class, spec, gearscore FROM characters WHERE discord_user_id = ? AND guild_id = ? AND is_deleted = 0 ORDER BY char_name ASC',
      [req.session.recruit_discord_id, form.guild_id]
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
              `SELECT id, char_name, char_class, spec, gearscore FROM characters WHERE id IN (${placeholders}) AND guild_id = ? AND is_deleted = 0`,
              [...missingIds, form.guild_id]
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

  // Store the guild context for character registration/updates
  req.session.recruit_guild_id = form.guild_id;

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


module.exports = router;
