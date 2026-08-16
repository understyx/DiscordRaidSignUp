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
const pool = require('../../db');
const { requireAdmin, popFlash, currentUser } = require('../helpers');
const { fetchGuildRoles, RESERVED_SLUGS } = require('./helpers');

const VALID_RESTRICTIONS = ['all', 'guild_member', 'role'];

const router = express.Router();

// ── GET /guild-settings ───────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const guildId = req.session.active_guild_id || null;

  // Fetch configured admin roles
  let configuredAdminRoles = [];
  let guildSubdomain = null;
  if (guildId) {
    const [rows] = await pool.query('SELECT role_id FROM guild_admin_roles WHERE guild_id = ?', [
      guildId,
    ]);
    configuredAdminRoles = rows.map((r) => String(r.role_id));

    // Fetch subdomain for this guild
    const [[bgRow]] = await pool.query('SELECT subdomain FROM bot_guilds WHERE guild_id = ?', [
      guildId,
    ]);
    if (bgRow) guildSubdomain = bgRow.subdomain || null;
  }

  // Fetch current guild settings
  let settings = {
    signup_restriction: 'all',
    signup_role_id: null,
    embed_title: null,
    embed_description: null,
    embed_image_url: null,
    embed_color: null,
  };
  if (guildId) {
    const [[row]] = await pool.query(
      'SELECT signup_restriction, signup_role_id, embed_title, embed_description, embed_image_url, embed_color FROM guild_settings WHERE guild_id = ?',
      [guildId]
    );
    if (row) {
      settings = {
        signup_restriction: row.signup_restriction,
        signup_role_id: row.signup_role_id ? String(row.signup_role_id) : null,
        embed_title: row.embed_title,
        embed_description: row.embed_description,
        embed_image_url: row.embed_image_url,
        embed_color: row.embed_color,
      };
    }
  }

  const guildRoles = await fetchGuildRoles(guildId);
  const guildRolesMap = Object.fromEntries(guildRoles.map((r) => [r.id, r]));

  res.render('guild_settings.html', {
    guild_id: guildId,
    configured_role_ids: configuredAdminRoles,
    guild_roles: guildRoles,
    guild_roles_map: guildRolesMap,
    settings,
    guild_subdomain: guildSubdomain,
    base_domain: process.env.BASE_DOMAIN || null,
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

  await pool.query('INSERT IGNORE INTO guild_admin_roles (guild_id, role_id) VALUES (?, ?)', [
    guildId,
    roleId,
  ]);

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

  await pool.query('DELETE FROM guild_admin_roles WHERE guild_id = ? AND role_id = ?', [
    guildId,
    roleId,
  ]);

  req.session.flash = '✅ Role removed from admin roles.';
  res.redirect('/guild-settings');
});

// ── POST /guild-settings/subdomain ────────────────────────────────────────────

router.post('/subdomain', express.urlencoded({ extended: false }), async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const guildId = req.session.active_guild_id || null;
  if (!guildId) {
    req.session.flash = '❌ No active guild selected.';
    return res.redirect('/guild-settings');
  }

  const raw = String(req.body.subdomain || '')
    .trim()
    .toLowerCase();

  // Empty value means clear the subdomain.
  if (!raw) {
    const [result] = await pool.query('UPDATE bot_guilds SET subdomain = NULL WHERE guild_id = ?', [
      guildId,
    ]);
    if (result.affectedRows === 0) {
      req.session.flash = '❌ Guild not found.';
    } else {
      req.session.flash = '✅ Guild subdomain removed.';
    }
    return res.redirect('/guild-settings');
  }

  // Validate slug format: 1–63 chars, a-z0-9 and hyphens, no leading/trailing hyphens.
  if (!/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$|^[a-z0-9]$/.test(raw)) {
    req.session.flash =
      '❌ Invalid subdomain format. Use 1–63 lowercase letters, digits, or hyphens (no leading/trailing hyphens).';
    return res.redirect('/guild-settings');
  }

  if (RESERVED_SLUGS.has(raw)) {
    req.session.flash = `❌ "${raw}" is a reserved subdomain and cannot be used.`;
    return res.redirect('/guild-settings');
  }

  try {
    const [result] = await pool.query('UPDATE bot_guilds SET subdomain = ? WHERE guild_id = ?', [
      raw,
      guildId,
    ]);
    if (result.affectedRows === 0) {
      req.session.flash = '❌ Guild not found.';
    } else {
      req.session.flash = `✅ Guild subdomain set to "${raw}".`;
    }
  } catch (err) {
    // MySQL duplicate entry error code
    if (err.code === 'ER_DUP_ENTRY' || (err.errno && (err.errno === 1062 || err.errno === 1169))) {
      req.session.flash = `❌ The subdomain "${raw}" is already in use by another guild.`;
    } else {
      throw err;
    }
  }

  res.redirect('/guild-settings');
});

// ── POST /guild-settings/custom-embed ─────────────────────────────────────────

router.post('/custom-embed', express.urlencoded({ extended: false }), async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const guildId = req.session.active_guild_id || null;
  if (!guildId) {
    req.session.flash = '❌ No active guild selected.';
    return res.redirect('/guild-settings');
  }

  const title = String(req.body.embed_title || '').trim() || null;
  const description = String(req.body.embed_description || '').trim() || null;
  const imageUrl = String(req.body.embed_image_url || '').trim() || null;
  let color = String(req.body.embed_color || '').trim() || null;

  if ((title && title.length > 255) || (description && description.length > 1024)) {
    req.session.flash = '❌ Embed title or description is too long.';
    return res.redirect('/guild-settings');
  }

  // Validate color is hex format if provided
  if (color && !/^#?([a-fA-F0-9]{6}|[a-fA-F0-9]{3})$/.test(color)) {
    req.session.flash = '❌ Invalid color format. Use HEX code (e.g., #FF5500).';
    return res.redirect('/guild-settings');
  }

  if (color && color.startsWith('#')) {
    color = color.substring(1);
  }

  // Validate URL format if provided
  if (imageUrl) {
    try {
      const parsedImageUrl = new URL(imageUrl);
      if (!['http:', 'https:'].includes(parsedImageUrl.protocol) || imageUrl.length > 255) {
        throw new Error('Unsupported image URL');
      }
    } catch (_) {
      req.session.flash = '❌ Use a valid HTTP(S) image URL up to 255 characters.';
      return res.redirect('/guild-settings');
    }
  }

  await pool.query(
    `INSERT INTO guild_settings (guild_id, embed_title, embed_description, embed_image_url, embed_color)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       embed_title = VALUES(embed_title),
       embed_description = VALUES(embed_description),
       embed_image_url = VALUES(embed_image_url),
       embed_color = VALUES(embed_color)`,
    [guildId, title, description, imageUrl, color]
  );

  req.session.flash = '✅ Custom embed settings updated.';
  res.redirect('/guild-settings');
});

module.exports = router;
