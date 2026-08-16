const express = require('express');
const pool = require('../../db');
const { createRecruitmentRepository } = require('../../repositories/recruitment');
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
  parseQuestions,
  buildQuestionBlocks,
  buildExistingGroupInstances,
} = require('./helpers');

const { resolveFormParam } = createRecruitmentRepository(pool);

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

const routeDependencies = {
  BIS_GS,
  DISCORD_API,
  DISCORD_OAUTH_URL,
  DISCORD_TOKEN_URL,
  DISCORD_USER_URL,
  NOTIFY_CHANNEL_ID,
  NOTIFY_GUILD_ID,
  NOTIFY_INVITE_URL,
  buildExistingGroupInstances,
  buildQuestionBlocks,
  currentUser,
  express,
  parseGS,
  parseQuestions,
  pool,
  popFlash,
  redirectToRecruitmentOAuth,
  requireAdmin,
  resolveFormParam,
  sendDiscordDM,
  sendNotificationChannelPing,
  normaliseSlug,
};

require('./applicantRoutes')(router, routeDependencies);
require('./adminRoutes')(router, routeDependencies);
require('./publicRoutes')(router, routeDependencies);

module.exports = router;
