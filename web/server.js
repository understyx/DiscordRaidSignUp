require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const nunjucks = require('nunjucks');
const path = require('path');

const { runMigrations } = require('./migrate');
const pool = require('./db');
const authRouter = require('./routes/auth');
const raidsRouter = require('./routes/raids');
const charactersRouter = require('./routes/characters');
const adminRouter = require('./routes/admin');
const guildSettingsRouter = require('./routes/guildSettings');
const recruitmentRouter = require('./routes/recruitment');

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
const sessionStore = new MySQLStore({
  createDatabaseTable: false,
}, pool);
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
    const [rows] = await pool.query(
      'SELECT char_class, alias, canonical FROM spec_aliases ORDER BY char_class, alias'
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

// Static files
app.use(express.static(path.join(__dirname, 'static')));

// Nunjucks
const templateDir = path.join(__dirname, 'templates');
const njkEnv = nunjucks.configure(templateDir, {
  autoescape: true,
  express: app,
});

// dateformat filter: supports "%Y-%m-%d %H:%M", "%A, %d %B %Y %H:%M UTC", "%Y-%m-%d"
njkEnv.addFilter('dateformat', (value, fmt) => {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return String(value);

  const pad = n => String(n).padStart(2, '0');
  const year = d.getUTCFullYear();
  const month = pad(d.getUTCMonth() + 1);
  const day = pad(d.getUTCDate());
  const hours = pad(d.getUTCHours());
  const minutes = pad(d.getUTCMinutes());

  if (fmt === '%Y-%m-%d %H:%M') {
    return `${year}-${month}-${day} ${hours}:${minutes}`;
  }

  if (fmt === '%Y-%m-%d') {
    return `${year}-${month}-${day}`;
  }

  if (fmt === '%A, %d %B %Y %H:%M UTC') {
    const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const months = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December',
    ];
    const weekday = weekdays[d.getUTCDay()];
    const monthName = months[d.getUTCMonth()];
    return `${weekday}, ${day} ${monthName} ${year} ${hours}:${minutes} UTC`;
  }

  // Fallback: ISO
  return d.toISOString();
});

// int filter
njkEnv.addFilter('int', val => Math.floor(Number(val)) || 0);

// gsformat filter: formats a gearscore for display.
// Returns "BiS" for the sentinel value (99999), otherwise the integer.
njkEnv.addFilter('gsformat', val => {
  const n = Number(val);
  if (n >= 99999) return 'BiS';
  return Math.floor(n) || 0;
});

// map filter: extracts a named attribute from each item in an array
// Usage: array | map('attrName')
njkEnv.addFilter('map', (arr, attr) => {
  if (!Array.isArray(arr)) return [];
  return arr.map(item => (item != null && typeof item === 'object') ? item[attr] : undefined);
});

// tojson filter: serialize a value to a JSON string safe for inline <script> use
njkEnv.addFilter('tojson', val => JSON.stringify(val));

// discordId filter: shows last 6 digits of a Discord snowflake, e.g. "…789012"
njkEnv.addFilter('discordId', val => {
  const s = String(val || '');
  if (!s || s === '0') return '?';
  return s.length > 6 ? '\u2026' + s.slice(-6) : s;
});

// Subdomain middleware — resolves guild from <slug>.BASE_DOMAIN hostnames.
// Runs before routes so every handler can read req.subdomainGuild.
app.use(async (req, res, next) => {
  req.subdomainGuild = null;

  const baseDomain = process.env.BASE_DOMAIN;
  if (!baseDomain) return next();

  const host = req.hostname; // e.g. "my-guild.example.com"
  const suffix = '.' + baseDomain; // e.g. ".example.com"

  if (!host.endsWith(suffix)) return next();

  const slug = host.slice(0, host.length - suffix.length);
  // Reject empty slugs or slugs that look like the root domain itself
  if (!slug || slug.includes('.')) return next();

  try {
    let [[row]] = await pool.query(
      'SELECT guild_id, guild_name FROM bot_guilds WHERE subdomain = ?',
      [slug]
    );
    // Fallback: if no named subdomain matches, treat a purely numeric slug as a guild snowflake ID.
    if (!row && /^\d+$/.test(slug)) {
      [[row]] = await pool.query(
        'SELECT guild_id, guild_name FROM bot_guilds WHERE guild_id = ?',
        [slug]
      );
    }
    if (!row) return next();

    req.subdomainGuild = { guild_id: String(row.guild_id), guild_name: row.guild_name, slug };

    // Override the active guild in the session when the subdomain guild differs
    // from what the session currently holds (or when the session has none).
    if (req.session.active_guild_id !== req.subdomainGuild.guild_id) {
      req.session.active_guild_id = req.subdomainGuild.guild_id;
      req.session.active_guild_name = req.subdomainGuild.guild_name;

      // Refresh admin status for the new guild if a user is logged in.
      if (req.session.user_id) {
        const { resolveIsAdmin } = require('./routes/adminCheck');
        try {
          req.session.is_admin = await resolveIsAdmin(
            req.session.user_id,
            req.subdomainGuild.guild_id
          );
        } catch (_err) {
          req.session.is_admin = false;
        }
      }
    }
  } catch (_err) {
    // DB error — continue without subdomain guild
  }

  next();
});

// Expose dev_mode flag and active guild info to all templates
app.use((req, res, next) => {
  res.locals.dev_mode = process.env.DEV_MODE === 'true';
  res.locals.dev_user_id = process.env.DEV_USER_ID || '';
  res.locals.active_guild_id = req.session.active_guild_id || null;
  res.locals.active_guild_name = req.session.active_guild_name || null;
  res.locals.has_any_guild = !!(
    req.session.active_guild_id ||
    (req.session.available_guilds && req.session.available_guilds.length > 0)
  );
  const _availableCount = req.session.available_guilds ? req.session.available_guilds.length : 0;
  res.locals.has_multiple_guilds = _availableCount > 1;
  next();
});

// Routes
app.use('/auth', authRouter);
app.use('/raids', raidsRouter);
app.use('/', charactersRouter);
app.use('/admin', adminRouter);
app.use('/guild-settings', guildSettingsRouter);
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
      ? { id: req.session.user_id, username: req.session.username, is_admin: req.session.is_admin !== false }
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
  const chosen = available.find(g => g.guild_id === chosenId);
  if (!chosen) {
    req.session.flash = '❌ Guild not available.';
    return res.redirect('/select-guild');
  }

  req.session.active_guild_id = chosenId;
  req.session.active_guild_name = chosen.guild_name;

  const { resolveIsAdmin } = require('./routes/adminCheck');
  try {
    req.session.is_admin = await resolveIsAdmin(req.session.user_id, chosenId);
  } catch (_err) {
    req.session.is_admin = true;
  }

  const nextUrl = req.session.post_guild_select_url || '/raids';
  delete req.session.post_guild_select_url;

  let redirectTo = '/raids';
  try {
    const decoded = decodeURIComponent(nextUrl);
    if (decoded.startsWith('/') && !decoded.startsWith('//') && !/[\r\n]/.test(decoded)) {
      redirectTo = decoded;
    }
  } catch (_) {
    // fall back
  }

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
      const slug = (guildRow && guildRow.subdomain) ? guildRow.subdomain : chosenId;
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

const PORT = parseInt(process.env.PORT || '8000', 10);

// ── Warmane weekly-reset scheduler ──────────────────────────────────────────
// Icecrown resets every Wednesday at 09:00 CET (Central European Time).
// CET = UTC+1 in winter; CEST = UTC+2 in summer.
// We derive the UTC equivalent at runtime so DST is handled automatically.
function nextWarmaneReset() {
  const now = new Date();

  // Find the next Wednesday 09:00 in the Europe/Berlin timezone (CET/CEST).
  // Strategy: iterate from today until we land on a Wednesday, then build
  // a Date that represents 09:00 CET/CEST on that date.
  for (let daysAhead = 0; daysAhead <= 7; daysAhead++) {
    const candidate = new Date(now);
    candidate.setUTCHours(0, 0, 0, 0);
    candidate.setUTCDate(candidate.getUTCDate() + daysAhead);

    // Use Intl to get the weekday and UTC-offset for Europe/Berlin on that day
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Berlin',
      weekday: 'short',
      hour: 'numeric',
      hour12: false,
    }).formatToParts(candidate);
    const weekday = parts.find(p => p.type === 'weekday')?.value; // 'Wed', 'Thu', …

    if (weekday !== 'Wed') continue;

    // Build a Date for 09:00:00 in Europe/Berlin on this calendar day.
    // Easiest way: format the date portion in Europe/Berlin, then parse as
    // "YYYY-MM-DDT09:00:00" with the Berlin UTC offset we detect below.
    const dateParts = new Intl.DateTimeFormat('en-CA', {   // en-CA gives YYYY-MM-DD
      timeZone: 'Europe/Berlin',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(candidate);                                    // e.g. "2024-03-06"

    // Detect UTC offset for Europe/Berlin on that date at noon
    const noonBerlin = new Date(`${dateParts}T12:00:00Z`);
    const berlinNoonStr = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Berlin',
      hour: 'numeric', minute: 'numeric', hour12: false,
    }).format(noonBerlin);
    const [bh] = berlinNoonStr.split(':').map(Number);
    const offsetHours = bh - 12;   // +1 for CET, +2 for CEST

    // 09:00 Berlin = (09 - offsetHours):00 UTC
    const resetUTC = new Date(`${dateParts}T${String(9 - offsetHours).padStart(2, '0')}:00:00Z`);

    if (resetUTC > now) return resetUTC;
  }

  // Fallback: 7 days from now (should never hit)
  return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
}

async function clearRaidSaves() {
  try {
    const [result] = await pool.query('DELETE FROM char_raid_saves WHERE is_saved = 1');
    console.log(`[weekly-reset] Cleared ${result.affectedRows} raid save(s) at ${new Date().toISOString()}`);
  } catch (err) {
    console.error('[weekly-reset] Failed to clear raid saves:', err.message);
  }
}

function scheduleWeeklyReset() {
  const next = nextWarmaneReset();
  const delayMs = next.getTime() - Date.now();
  console.log(`[weekly-reset] Next Warmane reset scheduled for ${next.toISOString()} (in ${Math.round(delayMs / 60000)} min)`);
  setTimeout(async () => {
    await clearRaidSaves();
    scheduleWeeklyReset(); // schedule the following week
  }, delayMs);
}

runMigrations()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Web server listening on port ${PORT}`);
    });
    scheduleWeeklyReset();
  })
  .catch(err => {
    console.error('[migrate] Fatal error during migrations:', err);
    process.exit(1);
  });
