const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const nunjucks = require('nunjucks');
const path = require('path');
const WOW_DATA = require('../../shared/wow.json');
const { isDevFullAdminEnabled } = require('./runtimeFlags');

const pool = require('../db');
const authRouter = require('../routes/auth');
const raidsRouter = require('../routes/raids');
const charactersRouter = require('../routes/characters');
const adminRouter = require('../routes/admin');
const guildSettingsRouter = require('../routes/guildSettings');
const guildCharactersRouter = require('../routes/guildCharacters');
const recruitmentRouter = require('../routes/recruitment');
const { registerFilters } = require('./filters');
const { safeRelativeRedirect } = require('../services/guildAccess');
const {
  buildLinkEmbed,
  guildIdFromRaidPath,
  hasCustomEmbed,
  isLinkPreviewRequest,
} = require('../services/linkPreview');

function createApp() {
  const app = express();

  // Session
  const _sessionCookieOpts = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
  };
  if (process.env.COOKIE_DOMAIN) {
    _sessionCookieOpts.domain = process.env.COOKIE_DOMAIN;
  }
  const sessionStore = new MySQLStore(
    {
      createDatabaseTable: false,
    },
    pool
  );
  app.use(
    session({
      secret: process.env.WEB_SECRET_KEY || 'change_this_to_a_random_string',
      resave: false,
      saveUninitialized: false,
      store: sessionStore,
      cookie: _sessionCookieOpts,
    })
  );

  // Dynamic spec_aliases.js — served before static files so DB version takes priority
  app.get('/js/spec_aliases.js', async (req, res) => {
    try {
      const guildId = req.session.active_guild_id;
      if (!guildId) {
        return res.type('application/javascript').send('const SPEC_ALIASES = {};\n');
      }
      const [rows] = await pool.query(
        'SELECT char_class, alias, canonical FROM spec_aliases WHERE guild_id = ? ORDER BY char_class, alias',
        [guildId]
      );
      // Build nested map: { class: { alias: canonical, … }, … }
      const map = {};
      for (const { char_class, alias, canonical } of rows) {
        if (!map[char_class]) map[char_class] = {};
        map[char_class][alias] = canonical;
      }
      const js = `const SPEC_ALIASES = ${JSON.stringify(map, null, 2)};\n`;
      res.type('application/javascript').send(js);
    } catch (err) {
      console.error('[spec_aliases] Failed to load from DB:', err.message);
      res.status(500).type('application/javascript').send('const SPEC_ALIASES = {};\n');
    }
  });

  app.get('/js/wow_data.js', (_req, res) => {
    res.type('application/javascript').send(`const WOW_DATA = ${JSON.stringify(WOW_DATA)};\n`);
  });

  // Static files
  app.use(express.static(path.join(__dirname, '..', 'static')));

  // Nunjucks
  const templateDir = path.join(__dirname, '..', 'templates');
  const njkEnv = nunjucks.configure(templateDir, {
    autoescape: true,
    express: app,
  });

  registerFilters(njkEnv);

  // Resolve the guild represented by a subdomain, an old guild-scoped raid URL,
  // or the active session. This runs before routes so link-preview crawlers can
  // receive guild metadata without being redirected through Discord OAuth.
  app.use(async (req, res, next) => {
    req.subdomainGuild = null;
    req.guildContext = null;

    const baseDomain = process.env.BASE_DOMAIN;
    const host = req.hostname; // e.g. "my-guild.example.com"
    const suffix = baseDomain ? '.' + baseDomain : null; // e.g. ".example.com"
    const isGuildSubdomain = Boolean(host && suffix && host.endsWith(suffix));
    const slug = isGuildSubdomain ? host.slice(0, host.length - suffix.length) : null;
    const pathGuildId = guildIdFromRaidPath(req.path);
    const sessionGuildId = req.session.active_guild_id || null;

    try {
      let row = null;
      let source = null;

      // Reject empty or nested subdomain slugs. If the hostname is not a guild
      // subdomain, the guild ID carried by legacy raid links takes precedence.
      if (slug && !slug.includes('.')) {
        [[row]] = await pool.query(
          `SELECT bg.guild_id, bg.guild_name, gs.embed_title, gs.embed_description, gs.embed_image_url, gs.embed_color
           FROM bot_guilds bg
           LEFT JOIN guild_settings gs ON bg.guild_id = gs.guild_id
           WHERE bg.subdomain = ?`,
          [slug]
        );
        source = 'subdomain';

        // Fallback: a numeric subdomain is the guild snowflake ID.
        if (!row && /^\d+$/.test(slug)) {
          [[row]] = await pool.query(
            `SELECT bg.guild_id, bg.guild_name, gs.embed_title, gs.embed_description, gs.embed_image_url, gs.embed_color
             FROM bot_guilds bg
             LEFT JOIN guild_settings gs ON bg.guild_id = gs.guild_id
             WHERE bg.guild_id = ?`,
            [slug]
          );
        }
      } else if (pathGuildId || sessionGuildId) {
        const guildId = pathGuildId || sessionGuildId;
        [[row]] = await pool.query(
          `SELECT bg.guild_id, bg.guild_name, gs.embed_title, gs.embed_description, gs.embed_image_url, gs.embed_color
           FROM bot_guilds bg
           LEFT JOIN guild_settings gs ON bg.guild_id = gs.guild_id
           WHERE bg.guild_id = ?`,
          [guildId]
        );
        source = pathGuildId ? 'path' : 'session';
      }
      if (!row) return next();

      req.guildContext = {
        guild_id: String(row.guild_id),
        guild_name: row.guild_name,
        slug: source === 'subdomain' ? slug : null,
        custom_embed: {
          title: row.embed_title,
          description: row.embed_description,
          image_url: row.embed_image_url,
          color: row.embed_color,
        },
      };
      if (source === 'subdomain') req.subdomainGuild = req.guildContext;

      // A hostname or guild-scoped raid URL is an explicit guild selection.
      if (source !== 'session' && req.session.active_guild_id !== req.guildContext.guild_id) {
        req.session.active_guild_id = req.guildContext.guild_id;
        req.session.active_guild_name = req.guildContext.guild_name;

        // Refresh admin status for the new guild if a user is logged in.
        if (req.session.user_id) {
          const { resolveIsAdmin } = require('../routes/adminCheck');
          try {
            req.session.is_admin = await resolveIsAdmin(
              req.session.user_id,
              req.guildContext.guild_id
            );
          } catch (_err) {
            req.session.is_admin = false;
          }
        }
      }
    } catch (_err) {
      // DB error — continue without guild-specific metadata.
    }

    next();
  });

  // Expose dev_mode flag and active guild info to all templates
  app.use((req, res, next) => {
    res.locals.dev_mode = process.env.DEV_MODE === 'true';
    res.locals.dev_user_id = process.env.DEV_USER_ID || '';
    res.locals.dev_full_admin = isDevFullAdminEnabled();
    res.locals.active_guild_id = req.session.active_guild_id || null;
    res.locals.active_guild_name = req.session.active_guild_name || null;
    if (req.guildContext) {
      const host = req.get('host');
      const protocol = process.env.NODE_ENV === 'production' ? 'https' : req.protocol;
      const absoluteUrl = host ? `${protocol}://${host}${req.originalUrl}` : req.originalUrl;
      res.locals.custom_embed = buildLinkEmbed(req.guildContext, absoluteUrl);
    } else {
      res.locals.custom_embed = null;
    }
    res.locals.has_any_guild = !!(
      req.session.active_guild_id ||
      (req.session.available_guilds && req.session.available_guilds.length > 0)
    );
    const _availableCount = req.session.available_guilds ? req.session.available_guilds.length : 0;
    res.locals.has_multiple_guilds = _availableCount > 1;
    next();
  });

  // Authenticated pages redirect anonymous visitors to OAuth. Link-preview
  // crawlers cannot authenticate, so give them a small public 200 response with
  // the configured metadata instead of letting the redirect strip guild context.
  app.use((req, res, next) => {
    if (
      req.guildContext &&
      hasCustomEmbed(req.guildContext.custom_embed) &&
      isLinkPreviewRequest(req)
    ) {
      return res.render('link_preview.html', {
        guild_name: req.guildContext.guild_name,
        custom_embed: res.locals.custom_embed,
      });
    }
    next();
  });

  // Routes
  app.use('/auth', authRouter);
  app.use('/raids', raidsRouter);
  app.use('/', charactersRouter);
  app.use('/admin', adminRouter);
  app.use('/guild-settings', guildSettingsRouter);
  app.use('/guild-characters', guildCharactersRouter);
  app.use('/recruitment', recruitmentRouter);

  // Bare-slug shortcut: /<slug> serves a recruitment form directly.
  // This must come after all other specific routes to avoid collisions.
  app.get('/:slug([a-z0-9][a-z0-9-]*)', async (req, res, next) => {
    const slug = req.params.slug;
    try {
      const [[form]] = await pool.query(
        'SELECT id FROM recruitment_forms WHERE slug = ? AND is_active = 1',
        [slug]
      );
      if (!form) return next();
      // Forward to the recruitment router, which handles /:form_id
      req.url = '/' + slug;
      recruitmentRouter(req, res, next);
    } catch (err) {
      next(err);
    }
  });

  // GET /select-guild — guild picker page
  app.get('/select-guild', (req, res) => {
    if (!req.session.user_id) return res.redirect('/auth/login');
    const availableGuilds = req.session.available_guilds || [];
    res.render('select_guild.html', {
      available_guilds: availableGuilds,
      flash: req.session.flash || null,
      user: req.session.user_id
        ? {
            id: req.session.user_id,
            username: req.session.username,
            is_admin: req.session.is_admin !== false,
          }
        : null,
    });
    delete req.session.flash;
  });

  // POST /select-guild — set active guild from picker
  app.post('/select-guild', express.urlencoded({ extended: false }), async (req, res) => {
    if (!req.session.user_id) return res.redirect('/auth/login');

    const chosenId = String(req.body.guild_id || '').trim();
    if (!chosenId || !/^\d+$/.test(chosenId)) {
      req.session.flash = '❌ Invalid guild selection.';
      return res.redirect('/select-guild');
    }

    // Validate that this guild is in the user's available guilds
    const available = req.session.available_guilds || [];
    const chosen = available.find((g) => g.guild_id === chosenId);
    if (!chosen) {
      req.session.flash = '❌ Guild not available.';
      return res.redirect('/select-guild');
    }

    req.session.active_guild_id = chosenId;
    req.session.active_guild_name = chosen.guild_name;

    const { resolveIsAdmin } = require('../routes/adminCheck');
    try {
      req.session.is_admin = await resolveIsAdmin(req.session.user_id, chosenId);
    } catch (_err) {
      req.session.is_admin = false;
    }

    const nextUrl = req.session.post_guild_select_url || '/raids';
    delete req.session.post_guild_select_url;

    const redirectTo = safeRelativeRedirect(nextUrl);

    // If BASE_DOMAIN and COOKIE_DOMAIN are configured, redirect to the guild's
    // subdomain so the session cookie is shared and the subdomain middleware sets
    // the correct active guild automatically.
    const baseDomain = process.env.BASE_DOMAIN;
    if (baseDomain && process.env.COOKIE_DOMAIN) {
      try {
        const [[guildRow]] = await pool.query(
          'SELECT subdomain FROM bot_guilds WHERE guild_id = ?',
          [chosenId]
        );
        const slug = guildRow && guildRow.subdomain ? guildRow.subdomain : chosenId;
        const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
        return res.redirect(`${protocol}://${slug}.${baseDomain}${redirectTo}`);
      } catch (_dbErr) {
        // Fall through to same-host redirect on DB error
      }
    }

    res.redirect(redirectTo);
  });

  // Root redirect
  app.get('/', (req, res) => {
    if (req.session.user_id) {
      res.redirect('/raids');
    } else {
      res.redirect('/auth/login');
    }
  });

  return app;
}

module.exports = { createApp };
