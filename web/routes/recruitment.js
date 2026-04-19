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

const DISCORD_API = 'https://discord.com/api/v10';
const DISCORD_OAUTH_URL = 'https://discord.com/api/oauth2/authorize';
const DISCORD_TOKEN_URL = 'https://discord.com/api/oauth2/token';
const DISCORD_USER_URL = 'https://discord.com/api/users/@me';

const router = express.Router();
router.use(express.urlencoded({ extended: true }));

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function popFlash(req) {
  const msg = req.session.flash || null;
  delete req.session.flash;
  return msg;
}

function currentUser(req) {
  if (!req.session.user_id) return null;
  return {
    id: req.session.user_id,
    username: req.session.username,
    is_admin: req.session.is_admin !== false,
  };
}

/** Fetch guild roles via bot token; returns [] on error. */
async function fetchGuildRoles(guildId) {
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!guildId || !botToken) return [];
  try {
    const resp = await fetch(`${DISCORD_API}/guilds/${guildId}/roles`, {
      headers: { Authorization: `Bot ${botToken}` },
    });
    if (!resp.ok) return [];
    const roles = await resp.json();
    return roles
      .filter(r => r.id !== guildId)
      .sort((a, b) => b.position - a.position)
      .map(r => ({
        id: r.id,
        name: r.name,
        color_hex: r.color ? r.color.toString(16).padStart(6, '0') : null,
      }));
  } catch (_) {
    return [];
  }
}

/** Fetch text channels for a guild via bot token; returns [] on error. */
async function fetchGuildChannels(guildId) {
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!guildId || !botToken) return [];
  try {
    const resp = await fetch(`${DISCORD_API}/guilds/${guildId}/channels`, {
      headers: { Authorization: `Bot ${botToken}` },
    });
    if (!resp.ok) return [];
    const channels = await resp.json();
    return channels
      .filter(c => c.type === 0) // text channels only
      .sort((a, b) => (a.position || 0) - (b.position || 0))
      .map(c => ({ id: c.id, name: c.name }));
  } catch (_) {
    return [];
  }
}

/**
 * Add a Discord user to a guild using their guilds.join OAuth token.
 * Optionally assigns a role on join. If already a member, assigns role separately.
 */
async function addUserToGuild(guildId, userId, accessToken, roleId) {
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!botToken || !accessToken) return { ok: false, reason: 'missing tokens' };

  try {
    const body = { access_token: accessToken };
    if (roleId) body.roles = [String(roleId)];

    const resp = await fetch(`${DISCORD_API}/guilds/${guildId}/members/${userId}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (resp.status === 201) {
      // Successfully added to guild
      return { ok: true, added: true };
    }

    if (resp.status === 204) {
      // Already a member — assign role separately if needed
      if (roleId) {
        const roleResp = await fetch(
          `${DISCORD_API}/guilds/${guildId}/members/${userId}/roles/${roleId}`,
          {
            method: 'PUT',
            headers: { Authorization: `Bot ${botToken}` },
          }
        );
        return { ok: roleResp.ok || roleResp.status === 204, added: false };
      }
      return { ok: true, added: false };
    }

    const text = await resp.text().catch(() => '');
    return { ok: false, reason: `Discord API ${resp.status}: ${text}` };
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
    if (!text) continue;

    const type = ['text', 'textarea', 'select', 'radio'].includes(types[i])
      ? types[i]
      : 'text';

    let options = null;
    if (type === 'select' || type === 'radio') {
      const rawOpts = String(opts[i] || '').trim();
      if (rawOpts) {
        options = JSON.stringify(rawOpts.split('\n').map(o => o.trim()).filter(Boolean));
      }
    }

    const defaultValue = String(defaults[i] || '').trim() || null;
    const rawGroupKey  = String(groupKeys[i] || '').trim().toLowerCase();
    const groupKey     = rawGroupKey.replace(/[^a-z0-9-]/g, '') || null;
    const groupLabel   = groupKey ? (String(groupLabels[i] || '').trim() || null) : null;
    const isGroupRepeatable = (groupKey && groupReps[i] === 'on') ? 1 : 0;
    const colWidth = ['full', 'half', 'third'].includes(colWidths[i]) ? colWidths[i] : 'full';

    questions.push({
      question_text:       text,
      question_type:       type,
      options,
      is_required:         reqs[i] === 'on' ? 1 : 0,
      sort_order:          i,
      default_value:       defaultValue,
      group_key:           groupKey,
      group_label:         groupLabel,
      is_group_repeatable: isGroupRepeatable,
      col_width:           colWidth,
    });
  }
  return questions;
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
    req.session.recruit_access_token = accessToken;

    // Persist token so it survives session restarts
    const formId = req.session.recruit_return_form_id;
    if (formId) {
      try {
        const [[form]] = await pool.query(
          'SELECT guild_id FROM recruitment_forms WHERE id = ? AND is_active = 1',
          [formId]
        );
        if (form) {
          const expiresAt = tokenData.expires_in
            ? new Date(Date.now() + tokenData.expires_in * 1000)
            : null;
          await pool.query(
            `INSERT INTO recruitment_oauth_tokens
               (applicant_discord_id, guild_id, access_token, refresh_token, expires_at)
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
               access_token  = VALUES(access_token),
               refresh_token = VALUES(refresh_token),
               expires_at    = VALUES(expires_at)`,
            [
              userData.id,
              form.guild_id,
              accessToken,
              tokenData.refresh_token || null,
              expiresAt,
            ]
          );
        }
      } catch (dbErr) {
        console.warn('[recruitment] Failed to persist OAuth token:', dbErr.message);
      }
    }

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
  const guildId = req.session.active_guild_id;
  const [guildRoles, guildChannels] = await Promise.all([
    fetchGuildRoles(guildId),
    fetchGuildChannels(guildId),
  ]);

  res.render('recruitment_form_builder.html', {
    form: null,
    questions: [],
    guild_roles: guildRoles,
    guild_channels: guildChannels,
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
  const recruitRoleId = String(req.body.recruit_role_id || '').trim() || null;
  const inviteChannelId = String(req.body.invite_channel_id || '').trim() || null;

  let slug;
  try {
    slug = normaliseSlug(req.body.slug);
  } catch (msg) {
    req.session.flash = msg;
    return res.redirect('/recruitment/new');
  }

  if (recruitRoleId && !/^\d+$/.test(recruitRoleId)) {
    req.session.flash = '❌ Invalid recruit role ID.';
    return res.redirect('/recruitment/new');
  }
  if (inviteChannelId && !/^\d+$/.test(inviteChannelId)) {
    req.session.flash = '❌ Invalid invite channel ID.';
    return res.redirect('/recruitment/new');
  }

  let result;
  try {
    [result] = await pool.query(
      `INSERT INTO recruitment_forms
         (guild_id, title, description, is_active, created_by, recruit_role_id, invite_channel_id, slug)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
      [guildId, title, description, req.session.user_id, recruitRoleId, inviteChannelId, slug]
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

  const [guildRoles, guildChannels] = await Promise.all([
    fetchGuildRoles(guildId),
    fetchGuildChannels(guildId),
  ]);

  res.render('recruitment_form_builder.html', {
    form,
    questions: questionsForBuilder,
    guild_roles: guildRoles,
    guild_channels: guildChannels,
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
  const recruitRoleId = String(req.body.recruit_role_id || '').trim() || null;
  const inviteChannelId = String(req.body.invite_channel_id || '').trim() || null;

  let slug;
  try {
    slug = normaliseSlug(req.body.slug);
  } catch (msg) {
    req.session.flash = msg;
    return res.redirect(`/recruitment/${formId}/edit-form`);
  }

  if (recruitRoleId && !/^\d+$/.test(recruitRoleId)) {
    req.session.flash = '❌ Invalid recruit role ID.';
    return res.redirect(`/recruitment/${formId}/edit-form`);
  }
  if (inviteChannelId && !/^\d+$/.test(inviteChannelId)) {
    req.session.flash = '❌ Invalid invite channel ID.';
    return res.redirect(`/recruitment/${formId}/edit-form`);
  }

  try {
    await pool.query(
      `UPDATE recruitment_forms
          SET title = ?, description = ?, recruit_role_id = ?, invite_channel_id = ?, slug = ?
        WHERE id = ?`,
      [title, description, recruitRoleId, inviteChannelId, slug, formId]
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

  // Build Q&A pairs; format JSON-array answers (repeatable groups) as readable lists
  const answerMap = {};
  for (const a of answers) answerMap[String(a.question_id)] = a.answer_text;
  const qa = questions.map(q => {
    const raw = answerMap[String(q.id)] || '';
    let answer = raw;
    if (raw.startsWith('[')) {
      try {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) answer = arr.join(' | ');
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

  // Assign recruit role if configured and not already done
  if (form.recruit_role_id && !application.discord_invited) {
    // Retrieve stored OAuth token
    try {
      const [[tokenRow]] = await pool.query(
        'SELECT access_token FROM recruitment_oauth_tokens WHERE applicant_discord_id = ? AND guild_id = ?',
        [application.applicant_discord_id, guildId]
      );
      if (tokenRow) {
        const addResult = await addUserToGuild(
          guildId,
          application.applicant_discord_id,
          tokenRow.access_token,
          form.recruit_role_id
        );
        if (addResult.ok) {
          await pool.query(
            'UPDATE recruitment_applications SET discord_invited = 1 WHERE id = ?',
            [appId]
          );
        } else {
          console.warn('[recruitment] Failed to add user to guild on accept:', addResult.reason);
        }
      }
    } catch (err) {
      console.warn('[recruitment] Error during guild add on accept:', err.message);
    }
  }

  // Send acceptance DM
  const guildName = req.session.active_guild_name || 'the guild';
  const dmResult = await sendDiscordDM(
    application.applicant_discord_id,
    `🎉 Congratulations, **${application.applicant_display_name}**! Your application to **${guildName}** has been **accepted**. Welcome aboard!`
  );
  if (!dmResult.ok) {
    console.warn('[recruitment] Failed to send acceptance DM:', dmResult.reason);
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

  // Send rejection DM
  const guildName = req.session.active_guild_name || 'the guild';
  const dmResult = await sendDiscordDM(
    application.applicant_discord_id,
    `Thank you for your interest in **${guildName}**. After reviewing your application, we have decided not to proceed at this time. We wish you the best!`
  );
  if (!dmResult.ok) {
    console.warn('[recruitment] Failed to send rejection DM:', dmResult.reason);
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

  const wantsNotify = req.body.wants_discord_notify === 'on' ? 1 : 0;

  const [appResult] = await pool.query(
    `INSERT INTO recruitment_applications
       (form_id, guild_id, applicant_discord_id, applicant_username, applicant_display_name,
        status, wants_discord_notify)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    [
      formId,
      form.guild_id,
      req.session.recruit_discord_id,
      req.session.recruit_username,
      req.session.recruit_display_name,
      wantsNotify,
    ]
  );
  const appId = appResult.insertId;

  for (const q of questions) {
    let answerText;
    if (q.is_group_repeatable && q.group_key) {
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

  // Handle Discord notification opt-in
  if (wantsNotify) {
    const accessToken = req.session.recruit_access_token;
    let addedToGuild = false;

    if (accessToken) {
      const addResult = await addUserToGuild(
        String(form.guild_id),
        req.session.recruit_discord_id,
        accessToken,
        form.recruit_role_id || null
      );
      if (addResult.ok) {
        addedToGuild = true;
        await pool.query(
          'UPDATE recruitment_applications SET discord_invited = 1 WHERE id = ?',
          [appId]
        );
      } else {
        console.warn('[recruitment] Failed to add applicant to guild:', addResult.reason);
      }
    }

    // Send DM confirming submission
    try {
      const [[guildRow]] = await pool.query(
        'SELECT guild_name FROM bot_guilds WHERE guild_id = ?',
        [form.guild_id]
      );
      const resolvedGuildName = guildRow ? guildRow.guild_name : form.title;
      await sendDiscordDM(
        req.session.recruit_discord_id,
        `📩 Your application to **${resolvedGuildName}** has been submitted! We'll review it and get back to you soon.` +
          (addedToGuild ? '\n\nYou\'ve been added to the Discord server.' : '')
      );
    } catch (dmErr) {
      console.warn('[recruitment] Failed to send submission DM:', dmErr.message);
    }
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

  // Build display-friendly answers (format JSON arrays for read-only view)
  const displayAnswers = {};
  for (const [qid, raw] of Object.entries(existingAnswers)) {
    if (raw && raw.startsWith('[')) {
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

  // Delete old answers and re-insert
  await pool.query('DELETE FROM recruitment_answers WHERE application_id = ?', [application.id]);
  for (const q of questions) {
    let answerText;
    if (q.is_group_repeatable && q.group_key) {
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
    scope: 'identify guilds.join',
    state,
  });

  res.redirect(`${DISCORD_OAUTH_URL}?${params.toString()}`);
}

module.exports = router;
