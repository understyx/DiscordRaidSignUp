const express = require('express');
const crypto = require('crypto');
const fetch = require('node-fetch');
const { URLSearchParams } = require('url');
const pool = require('../db');
const { resolveIsAdmin } = require('./adminCheck');

const router = express.Router();

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || 'http://localhost:8000/auth/callback';
const DISCORD_OAUTH_URL = 'https://discord.com/api/oauth2/authorize';
const DISCORD_TOKEN_URL = 'https://discord.com/api/oauth2/token';
const DISCORD_USER_URL = 'https://discord.com/api/users/@me';
const DISCORD_USER_GUILDS_URL = 'https://discord.com/api/users/@me/guilds';

router.get('/login', async (req, res) => {
  const baseDomain = process.env.BASE_DOMAIN;

  // When on a subdomain, DISCORD_REDIRECT_URI always points to the main domain.
  // If we start OAuth here the oauth_state would be in the subdomain session,
  // but the callback runs on the main domain (a different session without
  // COOKIE_DOMAIN), causing the state check to fail every time and creating an
  // infinite OAuth loop.  Fix: redirect to the main-domain /auth/login first so
  // that oauth_state is created in the same session the callback will use.
  if (baseDomain && req.subdomainGuild) {
    const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
    const qs = new URLSearchParams({ return_subdomain: req.subdomainGuild.slug });
    if (req.session.next_url) qs.set('next_url', req.session.next_url);
    return res.redirect(`${protocol}://${baseDomain}/auth/login?${qs.toString()}`);
  }

  const state = crypto.randomBytes(32).toString('hex');
  req.session.oauth_state = state;

  // Remember the subdomain so we can redirect back to it after OAuth.
  if (req.subdomainGuild) {
    req.session.return_subdomain = req.subdomainGuild.slug;
  } else if (req.query.return_subdomain) {
    // Arrived here via a redirect from a subdomain's /auth/login (see above).
    // Validate the slug format, then confirm it belongs to a real guild before
    // storing it — this prevents redirecting to an unintended subdomain.
    const slug = String(req.query.return_subdomain);
    if (/^[a-z0-9-]+$/i.test(slug)) {
      try {
        const [[guildRow]] = await pool.query(
          'SELECT 1 FROM bot_guilds WHERE subdomain = ? LIMIT 1',
          [slug]
        );
        if (guildRow) {
          req.session.return_subdomain = slug;
          // Restore next_url when sessions aren't shared (no COOKIE_DOMAIN).
          if (!req.session.next_url && req.query.next_url) {
            try {
              const decoded = decodeURIComponent(String(req.query.next_url));
              if (decoded.startsWith('/') && !decoded.startsWith('//') && !/[\r\n]/.test(decoded)) {
                req.session.next_url = decoded;
              }
            } catch (_) {
              // ignore malformed value
            }
          }
        }
      } catch (_dbErr) {
        // Non-fatal: if the DB check fails, skip the subdomain redirect
      }
    }
  }

  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify guilds',
    state,
  });

  res.redirect(`${DISCORD_OAUTH_URL}?${params.toString()}`);
});

router.get('/callback', async (req, res) => {
  const { code, state } = req.query;

  if (!code) return res.redirect('/auth/login');

  const expectedState = req.session.oauth_state;
  delete req.session.oauth_state;

  if (!expectedState || state !== expectedState) return res.redirect('/auth/login');

  try {
    const tokenRes = await fetch(DISCORD_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: DISCORD_REDIRECT_URI,
      }),
    });

    if (!tokenRes.ok) return res.redirect('/auth/login');
    const tokenData = await tokenRes.json();
    const accessToken = tokenData.access_token;

    const userRes = await fetch(DISCORD_USER_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!userRes.ok) return res.redirect('/auth/login');
    const userData = await userRes.json();

    req.session.user_id = userData.id;
    req.session.username = userData.username;
    req.session.avatar = userData.avatar || null;
    req.session.flash = `Welcome, ${userData.username}!`;

    // Fetch user's guild memberships to determine which bot-enabled guild to activate
    let userGuildIds = [];
    try {
      const guildsRes = await fetch(DISCORD_USER_GUILDS_URL, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (guildsRes.ok) {
        const guildsData = await guildsRes.json();
        userGuildIds = guildsData.map(g => String(g.id));
      }
    } catch (_guildsErr) {
      // Non-fatal: fall back to no guild filtering
    }
    req.session.user_guild_ids = userGuildIds;

    // Cache Discord user info in the database for display in raid management
    try {
      await pool.query(
        `INSERT INTO discord_users (discord_user_id, username, display_name, updated_at)
         VALUES (?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE username = VALUES(username), display_name = VALUES(display_name), updated_at = NOW()`,
        [userData.id, userData.username, userData.global_name || userData.username]
      );
    } catch (_dbErr) {
      // Non-fatal: table may not exist yet or another transient error
    }

    // Find which of the user's guilds have the bot installed
    let activeGuildId = null;
    let activeGuildName = null;
    if (userGuildIds.length > 0) {
      const placeholders = userGuildIds.map(() => '?').join(', ');
      try {
        const [botGuildRows] = await pool.query(
          `SELECT guild_id, guild_name FROM bot_guilds WHERE guild_id IN (${placeholders})`,
          userGuildIds
        );
        if (botGuildRows.length === 1) {
          activeGuildId = String(botGuildRows[0].guild_id);
          activeGuildName = botGuildRows[0].guild_name;
        } else if (botGuildRows.length > 1) {
          // Store available guilds and redirect to picker
          req.session.available_guilds = botGuildRows.map(r => ({
            guild_id: String(r.guild_id),
            guild_name: r.guild_name,
          }));
          req.session.active_guild_id = null;
          req.session.active_guild_name = null;

          const nextUrl = req.session.next_url;
          delete req.session.next_url;
          req.session.post_guild_select_url = nextUrl || '/raids';
          return res.redirect('/select-guild');
        }
        // botGuildRows.length === 0: no matching guilds, leave activeGuildId null
      } catch (_botGuildErr) {
        // Non-fatal: bot_guilds table may not exist yet
      }
    }

    req.session.active_guild_id = activeGuildId;
    req.session.active_guild_name = activeGuildName;

    // Determine and cache admin status for this session.
    try {
      req.session.is_admin = await resolveIsAdmin(userData.id, activeGuildId);
    } catch (_adminErr) {
      req.session.is_admin = true; // fail open on error
    }

    const nextUrl = req.session.next_url;
    delete req.session.next_url;
    // Only redirect to a safe relative path to prevent open-redirect attacks.
    // Decode the URL first to catch encoded variants (e.g. %2F%2F), then verify
    // it is a relative path with no newline characters.
    let redirectTo = '/raids';
    if (nextUrl) {
      try {
        const decoded = decodeURIComponent(nextUrl);
        if (decoded.startsWith('/') && !decoded.startsWith('//') && !/[\r\n]/.test(decoded)) {
          redirectTo = decoded;
        }
      } catch (_) {
        // decodeURIComponent failed — fall back to /raids
      }
    }

    // If the login was initiated from a guild subdomain, redirect back there.
    // Only do this when COOKIE_DOMAIN is set so that the session cookie is
    // shared with the subdomain.  Without a shared cookie the user would arrive
    // at the subdomain unauthenticated and the login loop would repeat.
    const returnSubdomain = req.session.return_subdomain;
    delete req.session.return_subdomain;
    const baseDomain = process.env.BASE_DOMAIN;
    if (returnSubdomain && baseDomain && process.env.COOKIE_DOMAIN) {
      const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
      const subdomainUrl = `${protocol}://${returnSubdomain}.${baseDomain}${redirectTo}`;
      return res.redirect(subdomainUrl);
    }

    res.redirect(redirectTo);
  } catch (_err) {
    res.redirect('/auth/login');
  }
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/auth/login');
  });
});

module.exports = router;
