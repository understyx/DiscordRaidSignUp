/**
 * guildSettings.js
 *
 * Per-guild settings hub.  Consolidates the old /raids/admin-roles pages
 * and adds the new signup-restriction control.
 *
 * Routes:
 *   GET  /guild-settings                  – render the settings page (admin only)
 *   POST /guild-settings/signup-restriction – save signup restriction setting
 *   POST /guild-settings/admin-roles/add   – add a role to guild_admin_roles
 *   POST /guild-settings/admin-roles/remove – remove a role from guild_admin_roles
 */

const express = require('express');
const fetch = require('node-fetch');
const pool = require('../db');

const DISCORD_API = 'https://discord.com/api/v10';
const VALID_RESTRICTIONS = ['all', 'guild_member', 'role'];

const router = express.Router();

// ── Helpers ──────────────────────────────────────────────────────────────────

function requireAdmin(req, res) {
  if (!req.session.user_id) {
    req.session.next_url = req.originalUrl;
    res.redirect('/auth/login');
    return false;
  }
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

/**
 * Fetch guild roles from Discord API.
 * Returns [] on any error so the UI degrades gracefully.
 */
async function fetchGuildRoles(guildId) {
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!guildId || !botToken) return [];

  try {
    const resp = await fetch(`${DISCORD_API}/guilds/${guildId}/roles`, {
      headers: { Authorization: `Bot ${botToken}` },
    });
    if (!resp.ok) {
      console.warn(`[guild-settings] Discord API ${resp.status} fetching roles for guild ${guildId}`);
      return [];
    }
    const roles = await resp.json();
    return roles
      .filter(r => r.id !== guildId) // exclude @everyone
      .sort((a, b) => b.position - a.position)
      .map(r => ({
        id: r.id,
        name: r.name,
        color_hex: r.color ? r.color.toString(16).padStart(6, '0') : null,
      }));
  } catch (err) {
    console.warn('[guild-settings] Failed to fetch guild roles:', err.message || err);
    return [];
  }
}

// ── GET /guild-settings ───────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const guildId = req.session.active_guild_id || null;

  // Fetch configured admin roles
  let configuredAdminRoles = [];
  if (guildId) {
    const [rows] = await pool.query(
      'SELECT role_id FROM guild_admin_roles WHERE guild_id = ?',
      [guildId]
    );
    configuredAdminRoles = rows.map(r => String(r.role_id));
  }

  // Fetch current guild settings (signup restriction)
  let settings = { signup_restriction: 'all', signup_role_id: null };
  if (guildId) {
    const [[row]] = await pool.query(
      'SELECT signup_restriction, signup_role_id FROM guild_settings WHERE guild_id = ?',
      [guildId]
    );
    if (row) {
      settings = {
        signup_restriction: row.signup_restriction,
        signup_role_id: row.signup_role_id ? String(row.signup_role_id) : null,
      };
    }
  }

  const guildRoles = await fetchGuildRoles(guildId);
  const guildRolesMap = Object.fromEntries(guildRoles.map(r => [r.id, r]));

  res.render('guild_settings.html', {
    guild_id: guildId,
    configured_role_ids: configuredAdminRoles,
    guild_roles: guildRoles,
    guild_roles_map: guildRolesMap,
    settings,
    flash: popFlash(req),
    user: currentUser(req),
  });
});

// ── POST /guild-settings/signup-restriction ───────────────────────────────────

router.post('/signup-restriction', express.urlencoded({ extended: false }), async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const guildId = req.session.active_guild_id || null;
  if (!guildId) {
    req.session.flash = '❌ No active guild selected.';
    return res.redirect('/guild-settings');
  }

  const restriction = String(req.body.signup_restriction || 'all').trim();
  if (!VALID_RESTRICTIONS.includes(restriction)) {
    req.session.flash = '❌ Invalid signup restriction value.';
    return res.redirect('/guild-settings');
  }

  let signupRoleId = null;
  if (restriction === 'role') {
    const rid = String(req.body.signup_role_id || '').trim();
    if (!rid || !/^\d+$/.test(rid)) {
      req.session.flash = '❌ Please select a valid role for the "role" restriction.';
      return res.redirect('/guild-settings');
    }
    signupRoleId = rid;
  }

  await pool.query(
    `INSERT INTO guild_settings (guild_id, signup_restriction, signup_role_id)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE signup_restriction = VALUES(signup_restriction),
                             signup_role_id     = VALUES(signup_role_id)`,
    [guildId, restriction, signupRoleId]
  );

  req.session.flash = '✅ Signup restriction updated.';
  res.redirect('/guild-settings');
});

// ── POST /guild-settings/admin-roles/add ─────────────────────────────────────

router.post('/admin-roles/add', express.urlencoded({ extended: false }), async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const guildId = req.session.active_guild_id || null;
  if (!guildId) {
    req.session.flash = '❌ No active guild selected.';
    return res.redirect('/guild-settings');
  }

  const roleId = String(req.body.role_id || '').trim();
  if (!roleId || !/^\d+$/.test(roleId)) {
    req.session.flash = '❌ Invalid role ID.';
    return res.redirect('/guild-settings');
  }

  await pool.query(
    'INSERT IGNORE INTO guild_admin_roles (guild_id, role_id) VALUES (?, ?)',
    [guildId, roleId]
  );

  req.session.flash = '✅ Role added to admin roles.';
  res.redirect('/guild-settings');
});

// ── POST /guild-settings/admin-roles/remove ───────────────────────────────────

router.post('/admin-roles/remove', express.urlencoded({ extended: false }), async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const guildId = req.session.active_guild_id || null;
  if (!guildId) {
    req.session.flash = '❌ No active guild selected.';
    return res.redirect('/guild-settings');
  }

  const roleId = String(req.body.role_id || '').trim();
  if (!roleId || !/^\d+$/.test(roleId)) {
    req.session.flash = '❌ Invalid role ID.';
    return res.redirect('/guild-settings');
  }

  await pool.query(
    'DELETE FROM guild_admin_roles WHERE guild_id = ? AND role_id = ?',
    [guildId, roleId]
  );

  req.session.flash = '✅ Role removed from admin roles.';
  res.redirect('/guild-settings');
});

module.exports = router;
