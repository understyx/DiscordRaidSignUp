'use strict';

function registerLegacyRoutes(router, dependencies) {
  const {
    DISCORD_API,
    EMOJIS,
    SIGNUP_NOTE_MAX_LENGTH,
    SIGNUP_STATUS_SIGNED,
    WOTLK_BUFFS,
    buildCompEmbed,
    compTabLabel,
    currentUser,
    express,
    fetch,
    fetchCompLabels,
    fetchSpecAliases,
    fetchUserGuildRoles,
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
    requireAdmin,
    requireLogin,
  } = dependencies;

  // Backward-compat redirects: /raids/:guild_id/:raid_number[/…] → /raids/:raid_number[/…]
  // These handle old-style URLs (e.g. from Discord bot messages before the schema change).
  // Only triggered when the first segment looks like a numeric guild snowflake, to avoid
  // shadowing the named sub-routes above (admin-roles, create, etc.).
  const GUILD_ID_RE = /^\d{17,19}$/; // Discord guild snowflakes are 17–19 digits
  router.get('/:guild_id/:raid_number', (req, res, next) => {
    if (!GUILD_ID_RE.test(req.params.guild_id)) return next();
    const raidNumber = parseInt(req.params.raid_number);
    if (isNaN(raidNumber)) return next();
    res.redirect(301, `/raids/${raidNumber}`);
  });
  router.post('/:guild_id/:raid_number/signup', (req, res, next) => {
    if (!GUILD_ID_RE.test(req.params.guild_id)) return next();
    const raidNumber = parseInt(req.params.raid_number);
    if (isNaN(raidNumber)) return next();
    res.redirect(308, `/raids/${raidNumber}/signup`);
  });
  router.post('/:guild_id/:raid_number/withdraw', (req, res, next) => {
    if (!GUILD_ID_RE.test(req.params.guild_id)) return next();
    const raidNumber = parseInt(req.params.raid_number);
    if (isNaN(raidNumber)) return next();
    res.redirect(308, `/raids/${raidNumber}/withdraw`);
  });
  router.get('/:guild_id/:raid_number/manage', (req, res, next) => {
    if (!GUILD_ID_RE.test(req.params.guild_id)) return next();
    const raidNumber = parseInt(req.params.raid_number);
    if (isNaN(raidNumber)) return next();
    const qs = req.query.comp ? `?comp=${req.query.comp}` : '';
    res.redirect(301, `/raids/${raidNumber}/manage${qs}`);
  });
  router.post('/:guild_id/:raid_number/manage', (req, res, next) => {
    if (!GUILD_ID_RE.test(req.params.guild_id)) return next();
    const raidNumber = parseInt(req.params.raid_number);
    if (isNaN(raidNumber)) return next();
    const qs = req.query.comp ? `?comp=${req.query.comp}` : '';
    res.redirect(308, `/raids/${raidNumber}/manage${qs}`);
  });
  router.patch('/:guild_id/:raid_number/manage', (req, res, next) => {
    if (!GUILD_ID_RE.test(req.params.guild_id)) return next();
    const raidNumber = parseInt(req.params.raid_number);
    if (isNaN(raidNumber)) return next();
    const qs = req.query.comp ? `?comp=${req.query.comp}` : '';
    res.redirect(308, `/raids/${raidNumber}/manage${qs}`);
  });
  router.get('/:guild_id/:raid_number/edit', (req, res, next) => {
    if (!GUILD_ID_RE.test(req.params.guild_id)) return next();
    const raidNumber = parseInt(req.params.raid_number);
    if (isNaN(raidNumber)) return next();
    res.redirect(301, `/raids/${raidNumber}/edit`);
  });
  router.post('/:guild_id/:raid_number/edit', (req, res, next) => {
    if (!GUILD_ID_RE.test(req.params.guild_id)) return next();
    const raidNumber = parseInt(req.params.raid_number);
    if (isNaN(raidNumber)) return next();
    res.redirect(308, `/raids/${raidNumber}/edit`);
  });
  router.get('/:guild_id/:raid_number/manage/json', (req, res, next) => {
    if (!GUILD_ID_RE.test(req.params.guild_id)) return next();
    const raidNumber = parseInt(req.params.raid_number);
    if (isNaN(raidNumber)) return next();
    const qs = req.query.comp ? `?comp=${req.query.comp}` : '';
    res.redirect(301, `/raids/${raidNumber}/manage/json${qs}`);
  });
  router.get('/:guild_id/:raid_number/comp', (req, res, next) => {
    if (!GUILD_ID_RE.test(req.params.guild_id)) return next();
    const raidNumber = parseInt(req.params.raid_number);
    if (isNaN(raidNumber)) return next();
    const qs = req.query.comp ? `?comp=${req.query.comp}` : '';
    res.redirect(301, `/raids/${raidNumber}/comp${qs}`);
  });
  router.post('/:guild_id/:raid_number/lock', (req, res, next) => {
    if (!GUILD_ID_RE.test(req.params.guild_id)) return next();
    const raidNumber = parseInt(req.params.raid_number);
    if (isNaN(raidNumber)) return next();
    res.redirect(308, `/raids/${raidNumber}/lock`);
  });
  router.post('/:guild_id/:raid_number/unlock', (req, res, next) => {
    if (!GUILD_ID_RE.test(req.params.guild_id)) return next();
    const raidNumber = parseInt(req.params.raid_number);
    if (isNaN(raidNumber)) return next();
    res.redirect(308, `/raids/${raidNumber}/unlock`);
  });
  router.post('/:guild_id/:raid_number/post_comp', (req, res, next) => {
    if (!GUILD_ID_RE.test(req.params.guild_id)) return next();
    const raidNumber = parseInt(req.params.raid_number);
    if (isNaN(raidNumber)) return next();
    const qs = req.query.comp ? `?comp=${req.query.comp}` : '';
    res.redirect(308, `/raids/${raidNumber}/post_comp${qs}`);
  });
  router.put('/:guild_id/:raid_number/comp_label', (req, res, next) => {
    if (!GUILD_ID_RE.test(req.params.guild_id)) return next();
    const raidNumber = parseInt(req.params.raid_number);
    if (isNaN(raidNumber)) return next();
    res.redirect(308, `/raids/${raidNumber}/comp_label`);
  });
}

module.exports = registerLegacyRoutes;
