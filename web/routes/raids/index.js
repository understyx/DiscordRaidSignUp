const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const pool = require('../../db');
const { createRaidRepository } = require('../../repositories/raids');
const { raidBaseUrl } = require('../../services/raids');
const { normalizeRaidEditInput, formatRaidDateInput } = require('../../services/raidEdits');
const { parseSignupSelection } = require('../../services/signup');
const { resolveIsAdmin } = require('../adminCheck');
const { requireLogin, popFlash, currentUser, getRoleFromSpec } = require('../helpers');
const {
  postToDiscordChannel,
  editDiscordMessage,
  deleteDiscordMessage,
  isDiscordNotFound,
  postToRaidLogThread,
  DISCORD_API,
} = require('./discord');
const {
  fetchSpecAliases,
  fetchCompLabels,
  compTabLabel,
  fetchUserGuildRoles,
  buildCompEmbed,
  syncRaidSignupMessage,
} = require('./embeds');

const WOTLK_BUFFS = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'wotlk_buffs.json'), 'utf8')
);

const EMOJIS = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', '..', 'emojis.json'), 'utf8')
);

const router = express.Router();
const SIGNUP_NOTE_MAX_LENGTH = 500;
const SIGNUP_STATUS_SIGNED = 'signed';
const raidRepository = createRaidRepository(pool);

// Re-evaluate admin status on every request so that role changes take effect
// immediately without requiring users to log out and back in.
router.use(async (req, res, next) => {
  if (req.session.user_id) {
    try {
      req.session.is_admin = await resolveIsAdmin(
        req.session.user_id,
        req.session.active_guild_id || null
      );
    } catch (err) {
      // Keep the existing cached value on transient errors, but log for debugging.
      console.warn(
        '[adminCheck] Failed to refresh admin status for user %s:',
        req.session.user_id,
        err.message || err
      );
    }
  }
  next();
});

// NOTE: requireAdmin in this router is async and re-calls resolveIsAdmin for
// stronger security guarantees on admin actions.  It intentionally does not use
// the shared sync variant from helpers.js.
async function requireAdmin(req, res) {
  if (!req.session.user_id) {
    req.session.next_url = req.originalUrl;
    res.redirect('/auth/login');
    return false;
  }
  const guildId = req.session.active_guild_id || null;
  const isAdmin = await resolveIsAdmin(req.session.user_id, guildId);
  if (!isAdmin) {
    req.session.flash = '❌ You do not have permission to perform this action.';
    res.redirect('/raids');
    return false;
  }
  return true;
}

/**
 * Look up a raid by guild_raid_number, scoped to the active guild from the
 * session (set by the subdomain middleware or guild picker).
 */
const getRaidByUrlParams = raidRepository.findByGuildRaidNumber;

const routeDependencies = {
  DISCORD_API,
  EMOJIS,
  SIGNUP_NOTE_MAX_LENGTH,
  SIGNUP_STATUS_SIGNED,
  WOTLK_BUFFS,
  buildCompEmbed,
  compTabLabel,
  currentUser,
  express,
  editDiscordMessage,
  deleteDiscordMessage,
  fetch,
  fetchCompLabels,
  fetchSpecAliases,
  fetchUserGuildRoles,
  formatRaidDateInput,
  fs,
  getRaidByUrlParams,
  getRoleFromSpec,
  parseSignupSelection,
  path,
  pool,
  popFlash,
  postToDiscordChannel,
  postToRaidLogThread,
  raidBaseUrl,
  isDiscordNotFound,
  normalizeRaidEditInput,
  requireAdmin,
  requireLogin,
  resolveIsAdmin,
  syncRaidSignupMessage,
};

require('./listRoutes')(router, routeDependencies);
require('./legacyRoutes')(router, routeDependencies);
require('./presetRoutes')(router, routeDependencies);
require('./signupRoutes')(router, routeDependencies);
require('./editRoutes')(router, routeDependencies);
require('./managePageRoutes')(router, routeDependencies);
require('./manageMutationRoutes')(router, routeDependencies);
require('./compositionRoutes')(router, routeDependencies);

module.exports = router;
