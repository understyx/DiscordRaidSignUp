'use strict';

const RAID_PAGE_SIZE = 10;

function registerListRoutes(router, dependencies) {
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
    resolveIsAdmin,
  } = dependencies;

  async function fetchRaidPage(guildId, isAdmin, offset = 0) {
    const [rows] = await pool.query(
      `SELECT
       r.*,
       COALESCE(SUM(CASE WHEN u.user_status = 'coming' THEN 1 ELSE 0 END), 0) AS signup_coming_count,
       COALESCE(SUM(CASE WHEN u.user_status = 'tentative' THEN 1 ELSE 0 END), 0) AS signup_tentative_count
     FROM raids r
     LEFT JOIN (
       SELECT
         raid_id,
         discord_user_id,
         CASE
           WHEN SUM(CASE WHEN status = '${SIGNUP_STATUS_SIGNED}' THEN 1 ELSE 0 END) > 0 THEN 'coming'
           ELSE 'tentative'
         END AS user_status
       FROM signups
       GROUP BY raid_id, discord_user_id
     ) u ON u.raid_id = r.id
     WHERE r.guild_id = ?
     GROUP BY r.id
     ORDER BY r.id DESC
     LIMIT ? OFFSET ?`,
      [guildId, RAID_PAGE_SIZE + 1, offset]
    );

    const hasMore = rows.length > RAID_PAGE_SIZE;
    const raids = rows.slice(0, RAID_PAGE_SIZE).map((raid) => ({
      raid,
      signup_coming_count: raid.signup_coming_count,
      signup_tentative_count: raid.signup_tentative_count,
      can_manage: isAdmin,
    }));

    return { raids, hasMore };
  }

  // GET /raids
  router.get('/', async (req, res) => {
    if (!requireLogin(req, res)) return;

    const userId = req.session.user_id;
    const userGuildIds = req.session.user_guild_ids || [];

    // Resolve all bot-enabled guilds the user belongs to.
    // Fall back to active_guild_id for older sessions that pre-date user_guild_ids.
    let userBotGuilds = [];
    if (userGuildIds.length > 0) {
      const placeholders = userGuildIds.map(() => '?').join(', ');
      const [botGuildRows] = await pool.query(
        `SELECT guild_id, guild_name FROM bot_guilds WHERE guild_id IN (${placeholders})`,
        userGuildIds
      );
      userBotGuilds = botGuildRows.map((r) => ({
        guild_id: String(r.guild_id),
        guild_name: r.guild_name,
      }));
    } else if (req.session.active_guild_id) {
      userBotGuilds = [
        { guild_id: req.session.active_guild_id, guild_name: req.session.active_guild_name || '' },
      ];
    }

    // Dynamically pick up guild memberships acquired after login (e.g. user joined a new Discord
    // server that already has the bot). Check any bot_guilds not yet known to this session by
    // querying Discord's member endpoint with the bot token. Discovered guilds are persisted into
    // the session so subsequent page loads skip the API calls.
    const botToken = process.env.DISCORD_BOT_TOKEN;
    if (botToken && !req.session.is_demo_session) {
      const verifiedIds = new Set(userBotGuilds.map((g) => g.guild_id));
      if (req.session.active_guild_id) verifiedIds.add(String(req.session.active_guild_id));

      let unverifiedQuery = 'SELECT guild_id, guild_name FROM bot_guilds';
      let unverifiedParams = [];
      if (verifiedIds.size > 0) {
        const excl = [...verifiedIds].map(() => '?').join(', ');
        unverifiedQuery += ` WHERE guild_id NOT IN (${excl})`;
        unverifiedParams = [...verifiedIds];
      }
      const [unverifiedRows] = await pool.query(unverifiedQuery, unverifiedParams);

      if (unverifiedRows.length > 0) {
        const checks = await Promise.all(
          unverifiedRows.map(async (row) => {
            const guildId = String(row.guild_id);
            try {
              const resp = await fetch(`${DISCORD_API}/guilds/${guildId}/members/${userId}`, {
                headers: { Authorization: `Bot ${botToken}` },
              });
              return resp.ok ? { guild_id: guildId, guild_name: row.guild_name } : null;
            } catch (err) {
              console.warn(
                `[raids] Failed to check membership in guild ${guildId}:`,
                err.message || err
              );
              return null;
            }
          })
        );
        const newGuilds = checks.filter(Boolean);
        if (newGuilds.length > 0) {
          userBotGuilds = [...userBotGuilds, ...newGuilds];
          // Persist the updated list so future page loads don't re-check these guilds.
          req.session.user_guild_ids = userBotGuilds.map((g) => g.guild_id);
          // Keep active_guild_id / available_guilds in sync.
          if (!req.session.active_guild_id) {
            if (userBotGuilds.length === 1) {
              req.session.active_guild_id = userBotGuilds[0].guild_id;
              req.session.active_guild_name = userBotGuilds[0].guild_name;
              try {
                req.session.is_admin = await resolveIsAdmin(userId, userBotGuilds[0].guild_id);
              } catch (_) {
                req.session.is_admin = false;
              }
            } else {
              req.session.available_guilds = userBotGuilds.map((g) => ({
                guild_id: g.guild_id,
                guild_name: g.guild_name,
              }));
            }
          } else {
            // active_guild_id is already set; just keep available_guilds current.
            req.session.available_guilds = userBotGuilds.map((g) => ({
              guild_id: g.guild_id,
              guild_name: g.guild_name,
            }));
          }
        }
      }
    }

    // If no active guild is known yet, send the user to the guild picker.
    if (!req.session.active_guild_id) {
      req.session.post_guild_select_url = '/raids';
      return res.redirect('/select-guild');
    }

    const activeGuildId = req.session.active_guild_id;
    const isAdmin = await resolveIsAdmin(userId, activeGuildId);

    const { raids, hasMore } = await fetchRaidPage(activeGuildId, isAdmin);

    res.render('raids_list.html', {
      raids,
      has_more: hasMore,
      raid_page_size: RAID_PAGE_SIZE,
      flash: popFlash(req),
      user: currentUser(req),
    });
  });

  // GET /raids/more?offset=10 — fetch the next page without reloading the list.
  router.get('/more', async (req, res) => {
    if (!requireLogin(req, res)) return;

    const guildId = req.session.active_guild_id;
    if (!guildId) return res.status(400).json({ ok: false, error: 'No active guild' });

    const parsedOffset = Number.parseInt(req.query.offset, 10);
    const offset = Number.isInteger(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0;
    const isAdmin = await resolveIsAdmin(req.session.user_id, guildId);
    const { raids, hasMore } = await fetchRaidPage(guildId, isAdmin, offset);

    res.render('raid_rows.html', { raids }, (error, html) => {
      if (error) {
        console.error('[raids] Failed to render additional raids:', error);
        return res.status(500).json({ ok: false, error: 'Could not load raids' });
      }
      return res.json({ ok: true, html, count: raids.length, has_more: hasMore });
    });
  });

  // GET /raids/admin-roles — redirect to the new Guild Settings page (backward-compat)
  router.get('/admin-roles', (req, res) => {
    res.redirect('/guild-settings');
  });

  // POST /raids/admin-roles/add — redirect to new route (backward-compat)
  router.post('/admin-roles/add', express.urlencoded({ extended: false }), (req, res) => {
    res.redirect(307, '/guild-settings/admin-roles/add');
  });

  // POST /raids/admin-roles/remove — redirect to new route (backward-compat)
  router.post('/admin-roles/remove', express.urlencoded({ extended: false }), (req, res) => {
    res.redirect(307, '/guild-settings/admin-roles/remove');
  });
}

module.exports = registerListRoutes;
