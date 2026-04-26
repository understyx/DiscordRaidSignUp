const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const pool = require('../db');
const { resolveIsAdmin } = require('./adminCheck');

// Load WotLK buff definitions once at startup
const WOTLK_BUFFS = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'wotlk_buffs.json'), 'utf8')
);

const EMOJIS = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', 'emojis.json'), 'utf8')
);

const DISCORD_API = 'https://discord.com/api/v10';

async function postToDiscordChannel(channelId, payload) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token || !channelId) return { ok: false, reason: 'missing token or channel' };

  try {
    const resp = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return { ok: false, reason: `Discord API ${resp.status}: ${text}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `Network error: ${err.message}` };
  }
}

async function postToRaidLogThread(raidId, message) {
  const [rows] = await pool.query('SELECT discord_log_thread_id FROM raids WHERE id = ?', [raidId]);
  const raid = rows[0];
  const threadId = raid && raid.discord_log_thread_id ? String(raid.discord_log_thread_id) : null;
  if (!threadId) return;
  const result = await postToDiscordChannel(threadId, { content: message });
  if (!result.ok) {
    console.warn(`[log-thread] Failed to post to log thread ${threadId}: ${result.reason}`);
  }
}

async function fetchSpecAliases() {
  const [rows] = await pool.query(
    'SELECT char_class, alias, canonical FROM spec_aliases'
  );
  const map = {};
  for (const { char_class, alias, canonical } of rows) {
    const clsKey = (char_class || '').toLowerCase().trim();
    const aliasKey = (alias || '').toLowerCase().trim();
    if (!map[clsKey]) map[clsKey] = {};
    map[clsKey][aliasKey] = canonical;
  }
  return map;
}

function getCanonicalSpec(charClass, specText, aliasMap) {
  if (!specText) return null;
  const cls = (charClass || '').toLowerCase().replace(/-/g, ' ').trim();
  const firstSpec = specText.split(',')[0].trim();
  const s = firstSpec.toLowerCase();

  const clsMap = aliasMap ? aliasMap[cls] : null;
  if (clsMap) {
    if (clsMap[s]) return clsMap[s];
    for (const [alias, canonical] of Object.entries(clsMap)) {
      if (s.includes(alias)) return canonical;
    }
  }
  return firstSpec.charAt(0).toUpperCase() + firstSpec.slice(1);
}

function getRoleBasedSpec(charClass, role) {
  const cls = (charClass || '').toLowerCase().replace(/-/g, ' ').trim();

  if (role === 'tank') {
    if (cls === 'paladin') return 'Protection';
    if (cls === 'druid') return 'Guardian';
    if (cls === 'warrior') return 'Protection';
    if (cls === 'death knight') return 'Blood';
  } else if (role === 'healer') {
    if (cls === 'paladin') return 'Holy';
    if (cls === 'priest') return 'Holy'; // or Discipline, but Holy is a safe default
    if (cls === 'shaman') return 'Restoration';
    if (cls === 'druid') return 'Restoration';
  }
  return null;
}

async function fetchCompLabels(raidId) {
  const [rows] = await pool.query(
    'SELECT comp_number, label FROM comp_labels WHERE raid_id = ?',
    [raidId]
  );
  const map = {};
  for (const r of rows) map[r.comp_number] = r.label;
  return map;
}

function compTabLabel(compNumber, compLabels) {
  return (compLabels && compLabels[compNumber]) || `Raid ${compNumber}`;
}

/**
 * Collect unique Discord user IDs (in order of appearance) from all role groups.
 */
function collectUniqueUserIds(groups) {
  const seen = new Set();
  const ids = [];
  for (const roleKey of ['tank', 'healer', 'mdps', 'rdps', 'dps']) {
    for (const e of groups[roleKey] || []) {
      const userId = e.is_player_placeholder ? e.discord_user_id : (e.character && e.character.discord_user_id);
      if (userId) {
        const id = String(userId);
        if (!seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      }
    }
  }
  return ids;
}

function buildCompEmbed(raid, groups, compNumber, totalComps, compLabels, specAliasesMap) {
  const label = compTabLabel(compNumber, compLabels);
  const compLabel = totalComps > 1 ? ` – ${label}` : '';
  const unixTs = Math.floor(new Date(raid.date).getTime() / 1000);
  const dateStr = `<t:${unixTs}:F>`;

  const fields = [];

  const roleEmojis = {
    tank: '🛡️',
    healer: '💚',
    mdps: '🗡️',
    rdps: '🏹',
    dps: '⚔️'
  };

  const sections = [
    { label: '🛡️ Tanks', keys: ['tank'] },
    { label: '💚 Healers', keys: ['healer'] },
    { label: '⚔️ DPS', keys: ['mdps', 'rdps', 'dps'] },
  ];

  for (const section of sections) {
    const entries = [];
    for (const key of section.keys) {
      if (groups[key]) entries.push(...groups[key]);
    }

    if (entries.length === 0) continue;

    const lines = entries.map(e => {
      let emoji = roleEmojis[e.slot_role] || '❓';

      if (!e.is_placeholder && !e.is_player_placeholder && e.character) {
        const c = e.character;
        if (c.char_class && EMOJIS[c.char_class]) {
          const classData = EMOJIS[c.char_class];

          let specToLookup = null;

          // 1. Raw spec
          if (c.spec && classData.specs && classData.specs[c.spec]) {
            specToLookup = c.spec;
          }
          // 2. Canonical spec
          if (!specToLookup) {
            const canonical = getCanonicalSpec(c.char_class, c.spec, specAliasesMap);
            if (canonical && classData.specs && classData.specs[canonical]) {
              specToLookup = canonical;
            }
          }
          // 3. Role-based spec
          if (!specToLookup) {
            const roleBased = getRoleBasedSpec(c.char_class, e.slot_role);
            if (roleBased && classData.specs && classData.specs[roleBased]) {
              specToLookup = roleBased;
            }
          }

          if (specToLookup && classData.specs && classData.specs[specToLookup]) {
            emoji = classData.specs[specToLookup];
          } else if (classData.emoji) {
            emoji = classData.emoji;
          }
        }
      }

      if (e.is_placeholder) {
        const text = e.placeholder_text || '?';
        // If the placeholder text already starts with an emoji (likely the role emoji),
        // don't double-post it.
        const startsWithEmoji = /^\p{Emoji}/u.test(text);
        return startsWithEmoji ? `*${text}*` : `${emoji} *${text}*`;
      }
      if (e.is_player_placeholder) {
        const mention = e.discord_user_id ? ` <@${e.discord_user_id}>` : '';
        return `${emoji} **Any Character**${mention}`;
      }
      const c = e.character;
      const mention = c.discord_user_id ? ` <@${c.discord_user_id}>` : '';
      const tentative = c.status === 'tentative' ? ' [:question:]' : '';
      return `${emoji} **${c.char_name}**${mention}${tentative}`;
    });

    fields.push({
      name: `${section.label} [${entries.length}]`,
      value: lines.join('\n') || '—',
      inline: false,
    });
  }

  // Collect unique user IDs so pings in the message content trigger real notifications.
  const allIds = collectUniqueUserIds(groups);
  const content = allIds.map(id => `<@${id}>`).join(' ');

  return {
    content: content || undefined,
    embeds: [
      {
        title: `📋 ${raid.name}${compLabel}`,
        description: `**${raid.raid_instance}** | ${dateStr}`,
        color: 0xe6cc80,
        fields,
        footer: { text: `Raid ID: ${raid.id}` },
      },
    ],
  };
}

const router = express.Router();

// Re-evaluate admin status on every request so that role changes take effect
// immediately without requiring users to log out and back in.
router.use(async (req, res, next) => {
  if (req.session.user_id) {
    try {
      req.session.is_admin = await resolveIsAdmin(req.session.user_id, req.session.active_guild_id || null);
    } catch (err) {
      // Keep the existing cached value on transient errors, but log for debugging.
      console.warn('[adminCheck] Failed to refresh admin status for user %s:', req.session.user_id, err.message || err);
    }
  }
  next();
});

function requireLogin(req, res) {
  if (!req.session.user_id) {
    req.session.next_url = req.originalUrl;
    res.redirect('/auth/login');
    return false;
  }
  return true;
}

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
 * Look up a raid by guild_raid_number, scoped to the active guild from the
 * session (set by the subdomain middleware or guild picker).
 */
async function getRaidByUrlParams(guildId, raidNumber) {
  if (!Number.isFinite(raidNumber)) return null;
  const guildIdParam = (guildId === '0' || guildId === 'null' || !guildId) ? null : guildId;
  let query, params;
  if (guildIdParam === null) {
    query = 'SELECT * FROM raids WHERE guild_id IS NULL AND guild_raid_number = ?';
    params = [raidNumber];
  } else {
    query = 'SELECT * FROM raids WHERE guild_id = ? AND guild_raid_number = ?';
    params = [guildIdParam, raidNumber];
  }
  const [[raid]] = await pool.query(query, params);
  return raid || null;
}

/** Build the base URL for a raid: /raids/{guild_raid_number} */
function raidBaseUrl(raid) {
  return `/raids/${raid.guild_raid_number}`;
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
    userBotGuilds = botGuildRows.map(r => ({ guild_id: String(r.guild_id), guild_name: r.guild_name }));
  } else if (req.session.active_guild_id) {
    userBotGuilds = [{ guild_id: req.session.active_guild_id, guild_name: req.session.active_guild_name || '' }];
  }

  // Dynamically pick up guild memberships acquired after login (e.g. user joined a new Discord
  // server that already has the bot). Check any bot_guilds not yet known to this session by
  // querying Discord's member endpoint with the bot token. Discovered guilds are persisted into
  // the session so subsequent page loads skip the API calls.
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (botToken) {
    const verifiedIds = new Set(userBotGuilds.map(g => g.guild_id));
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
        unverifiedRows.map(async row => {
          const guildId = String(row.guild_id);
          try {
            const resp = await fetch(`${DISCORD_API}/guilds/${guildId}/members/${userId}`, {
              headers: { Authorization: `Bot ${botToken}` },
            });
            return resp.ok ? { guild_id: guildId, guild_name: row.guild_name } : null;
          } catch (err) {
            console.warn(`[raids] Failed to check membership in guild ${guildId}:`, err.message || err);
            return null;
          }
        })
      );
      const newGuilds = checks.filter(Boolean);
      if (newGuilds.length > 0) {
        userBotGuilds = [...userBotGuilds, ...newGuilds];
        // Persist the updated list so future page loads don't re-check these guilds.
        req.session.user_guild_ids = userBotGuilds.map(g => g.guild_id);
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
            req.session.available_guilds = userBotGuilds.map(g => ({
              guild_id: g.guild_id,
              guild_name: g.guild_name,
            }));
          }
        } else {
          // active_guild_id is already set; just keep available_guilds current.
          req.session.available_guilds = userBotGuilds.map(g => ({
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

  const [raids] = await pool.query(
    `SELECT r.*, COUNT(DISTINCT s.discord_user_id) AS signup_count
     FROM raids r
     LEFT JOIN signups s ON s.raid_id = r.id
     WHERE r.guild_id = ?
     GROUP BY r.id
     ORDER BY r.id DESC`,
    [activeGuildId]
  );

  const raidData = raids.map(r => ({
    raid: r,
    signup_count: r.signup_count,
    can_manage: isAdmin,
  }));

  res.render('raids_list.html', {
    raids: raidData,
    flash: popFlash(req),
    user: currentUser(req),
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

// GET /raids/presets — list placeholder presets for the active guild
router.get('/presets', async (req, res) => {
  if (!req.session.user_id) return res.status(401).json({ ok: false });
  const guildId = req.session.active_guild_id || null;
  const guildIdParam = (guildId === '0' || guildId === 'null' || !guildId) ? null : guildId;

  let rows;
  try {
    if (guildIdParam === null) {
      [rows] = await pool.query(
        'SELECT id, name, slots FROM placeholder_presets WHERE guild_id IS NULL ORDER BY created_at DESC'
      );
    } else {
      [rows] = await pool.query(
        'SELECT id, name, slots FROM placeholder_presets WHERE guild_id = ? ORDER BY created_at DESC',
        [guildIdParam]
      );
    }
  } catch (err) {
    console.error('[presets] Failed to load presets:', err.message);
    return res.status(500).json({ ok: false, error: 'Database error' });
  }

  const presets = rows.map(r => ({
    id: r.id,
    name: r.name,
    slots: typeof r.slots === 'string' ? JSON.parse(r.slots) : r.slots,
  }));
  res.json({ ok: true, presets });
});

// POST /raids/presets — create a new placeholder preset
router.post('/presets', express.json(), async (req, res) => {
  if (!await requireAdmin(req, res)) return;

  const guildId = req.session.active_guild_id || null;
  const guildIdParam = (guildId === '0' || guildId === 'null' || !guildId) ? null : guildId;
  const userId = req.session.user_id;

  const { name, slots } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ ok: false, error: 'name is required' });
  }
  if (!Array.isArray(slots) || slots.length === 0) {
    return res.status(400).json({ ok: false, error: 'slots must be a non-empty array' });
  }

  const trimmedName = name.trim().slice(0, 100);
  try {
    const [result] = await pool.query(
      'INSERT INTO placeholder_presets (guild_id, name, slots, created_by) VALUES (?, ?, ?, ?)',
      [guildIdParam, trimmedName, JSON.stringify(slots), userId]
    );
    res.json({ ok: true, id: result.insertId, name: trimmedName });
  } catch (err) {
    console.error('[presets] Failed to save preset:', err.message);
    res.status(500).json({ ok: false, error: 'Database error' });
  }
});

// DELETE /raids/presets/:id — delete a placeholder preset
router.delete('/presets/:id', async (req, res) => {
  if (!await requireAdmin(req, res)) return;

  const guildId = req.session.active_guild_id || null;
  const guildIdParam = (guildId === '0' || guildId === 'null' || !guildId) ? null : guildId;
  const presetId = parseInt(req.params.id);

  if (isNaN(presetId)) return res.status(400).json({ ok: false, error: 'Invalid preset id' });

  let result;
  try {
    if (guildIdParam === null) {
      [result] = await pool.query(
        'DELETE FROM placeholder_presets WHERE id = ? AND guild_id IS NULL',
        [presetId]
      );
    } else {
      [result] = await pool.query(
        'DELETE FROM placeholder_presets WHERE id = ? AND guild_id = ?',
        [presetId, guildIdParam]
      );
    }
  } catch (err) {
    console.error('[presets] Failed to delete preset:', err.message);
    return res.status(500).json({ ok: false, error: 'Database error' });
  }

  if (result.affectedRows === 0) return res.status(404).json({ ok: false, error: 'Preset not found' });
  res.json({ ok: true });
});

// GET /raids/:raid_number
router.get('/:raid_number', async (req, res) => {
  if (!requireLogin(req, res)) return;

  const raidNumber = parseInt(req.params.raid_number);
  const userId = req.session.user_id;

  const raid = await getRaidByUrlParams(req.session.active_guild_id || null, raidNumber);
  if (!raid) return res.redirect('/raids');

  const raidId = raid.id;

  const [[{ player_count }]] = await pool.query(
    'SELECT COUNT(DISTINCT discord_user_id) AS player_count FROM signups WHERE raid_id = ?',
    [raidId]
  );
  raid.signup_count = player_count;

  const [userChars] = await pool.query(
    'SELECT * FROM characters WHERE discord_user_id = ? AND is_deleted = 0',
    [userId]
  );

  // Fetch ALL signups for this user in this raid (one per character/spec)
  const [mySignupRows] = await pool.query(
    `SELECT s.*, c.id AS c_id, c.char_name, c.realm, c.char_class, c.spec, c.gearscore, c.role
     FROM signups s JOIN characters c ON s.character_id = c.id
     WHERE s.raid_id = ? AND s.discord_user_id = ?`,
    [raidId, userId]
  );

  // Build a map of character_id -> signup for easy template lookup
  const mySignupMap = {};
  for (const row of mySignupRows) {
    mySignupMap[String(row.character_id)] = {
      signup_type: row.signup_type,
      status: row.status,
    };
  }

  // Group user's characters by char_name so each character shows once with all specs
  const charGroupMap = {};
  for (const c of userChars) {
    if (!charGroupMap[c.char_name]) {
      charGroupMap[c.char_name] = {
        char_name: c.char_name,
        char_class: c.char_class,
        specs: [],
      };
    }
    charGroupMap[c.char_name].specs.push({
      id: c.id,
      spec: c.spec,
      gearscore: c.gearscore,
      role: c.role,
    });
  }
  const userCharGroups = Object.values(charGroupMap).map(g => {
    const is_signed = g.specs.some(s => mySignupMap[String(s.id)] !== undefined);
    const is_prio   = g.specs.some(s => mySignupMap[String(s.id)]?.signup_type === 'prio_character');
    return { ...g, is_signed, is_prio };
  });

  const [allSignups] = await pool.query(
    `SELECT s.*, c.id AS c_id, c.char_name, c.realm, c.char_class, c.spec, c.gearscore, c.role
     FROM signups s JOIN characters c ON s.character_id = c.id
     WHERE s.raid_id = ?`,
    [raidId]
  );

  // Merge signups by (discord_user_id + char_name) within each bucket.
  // Tentative signups go into their own bucket regardless of signup_type.
  const grouped = { fill: [], prio_role: [], prio_character: [], tentative: [] };
  for (const s of allSignups) {
    let bucket;
    if (s.status === 'tentative') {
      bucket = grouped.tentative;
    } else {
      const key = s.signup_type || 'fill';
      bucket = grouped[key] || grouped.fill;
    }
    const mergeKey = `${s.discord_user_id}__${s.char_name}`;
    const existing = bucket.find(e => e._mergeKey === mergeKey);
    const is_prio = s.signup_type === 'prio_character' || s.signup_type === 'prio_role';
    const is_saved = !!s.is_saved;
    if (existing) {
      existing.character.specs.push({ spec: s.spec, gearscore: s.gearscore, is_prio, is_saved });
    } else {
      bucket.push({
        ...s,
        _mergeKey: mergeKey,
        discord_user_id: s.discord_user_id,
        character: {
          id: s.c_id,
          char_name: s.char_name,
          realm: s.realm,
          char_class: s.char_class,
          role: s.role,
          specs: [{ spec: s.spec, gearscore: s.gearscore, is_prio, is_saved }],
        },
      });
    }
  }

  // Only show the current user's own sign-ups in the sign-up view.
  const myGrouped = {};
  for (const bucket of ['fill', 'prio_role', 'prio_character', 'tentative']) {
    myGrouped[bucket] = grouped[bucket].filter(
      s => String(s.discord_user_id) === String(userId)
    );
  }

  res.render('raid_detail.html', {
    raid,
    raid_url: raidBaseUrl(raid),
    user_char_groups: userCharGroups,
    my_signup_map: mySignupMap,
    my_signup_count: mySignupRows.length,
    grouped_signups: myGrouped,
    signup_types: ['fill', 'prio_role', 'prio_character'],
    flash: popFlash(req),
    user: currentUser(req),
  });
});

// POST /raids/:raid_number/signup
router.post('/:raid_number/signup', express.urlencoded({ extended: false }), async (req, res) => {
  if (!requireLogin(req, res)) return;

  const raidNumber = parseInt(req.params.raid_number);
  const userId = req.session.user_id;
  const guildId = req.session.active_guild_id || null;

  const raid = await getRaidByUrlParams(guildId, raidNumber);
  if (!raid || raid.status !== 'open') {
    req.session.flash = '❌ Raid is not open for sign-ups.';
    return res.redirect(raid ? raidBaseUrl(raid) : '/raids');
  }

  const raidId = raid.id;
  const raidUrl = raidBaseUrl(raid);

  // Enforce per-guild signup restrictions
  if (guildId) {
    const [[guildSettings]] = await pool.query(
      'SELECT signup_restriction, signup_role_id FROM guild_settings WHERE guild_id = ?',
      [guildId]
    );
    const restriction = guildSettings ? guildSettings.signup_restriction : 'all';

    if (restriction === 'guild_member' || restriction === 'role') {
      const botToken = process.env.DISCORD_BOT_TOKEN;
      let member = null;
      if (botToken) {
        try {
          const resp = await fetch(`${DISCORD_API}/guilds/${guildId}/members/${userId}`, {
            headers: { Authorization: `Bot ${botToken}` },
          });
          if (resp.ok) {
            member = await resp.json();
          }
        } catch (_err) {
          console.warn('[signup] Failed to fetch guild member for restriction check:', _err.message || _err);
        }
      }

      if (!member) {
        if (restriction === 'role') {
          req.session.flash = '❌ You must be a member of the guild with the required role to sign up for raids.';
        } else {
          req.session.flash = '❌ You must be a member of the guild to sign up for raids.';
        }
        return res.redirect(raidUrl);
      }

      if (restriction === 'role') {
        const requiredRoleId = guildSettings.signup_role_id ? String(guildSettings.signup_role_id) : null;
        const memberRoles = (member.roles || []).map(String);
        if (!requiredRoleId || !memberRoles.includes(requiredRoleId)) {
          req.session.flash = '❌ You do not have the required role to sign up for raids.';
          return res.redirect(raidUrl);
        }
      }
    }
  }

  // Support multi-select: character_ids[] and priority_ids[]
  let characterIds = req.body.character_ids || req.body.character_id;
  if (!Array.isArray(characterIds)) {
    characterIds = characterIds ? [characterIds] : [];
  }
  characterIds = characterIds.map(id => parseInt(id)).filter(id => !isNaN(id));

  let priorityIds = req.body.priority_ids || [];
  if (!Array.isArray(priorityIds)) {
    priorityIds = [priorityIds];
  }
  const prioritySet = new Set(priorityIds.map(id => parseInt(id)));

  const isTentative = req.body.signup_mode === 'tentative';

  if (characterIds.length === 0) {
    req.session.flash = '❌ Please select at least one character.';
    return res.redirect(raidUrl);
  }

  // Verify all selected characters belong to this user
  if (characterIds.length > 0) {
    const placeholders = characterIds.map(() => '?').join(', ');
    const [owned] = await pool.query(
      `SELECT id FROM characters WHERE id IN (${placeholders}) AND discord_user_id = ? AND is_deleted = 0`,
      [...characterIds, userId]
    );
    if (owned.length !== characterIds.length) {
      req.session.flash = '❌ Invalid character selection.';
      return res.redirect(raidUrl);
    }
  }

  // Fetch character details for the log message before deleting existing signups
  const charPlaceholders = characterIds.map(() => '?').join(', ');
  const [charRows] = await pool.query(
    `SELECT id, char_name, char_class, spec, gearscore FROM characters WHERE id IN (${charPlaceholders}) AND is_deleted = 0`,
    characterIds
  );
  const charById = {};
  for (const c of charRows) charById[String(c.id)] = c;

  // Delete all existing signups for this user in this raid, then re-insert
  await pool.query('DELETE FROM signups WHERE raid_id = ? AND discord_user_id = ?', [raidId, userId]);

  for (const charId of characterIds) {
    const stype = prioritySet.has(charId) ? 'prio_character' : 'fill';
    const sstatus = isTentative ? 'tentative' : 'signed';
    await pool.query(
      "INSERT INTO signups (raid_id, discord_user_id, character_id, signup_type, status) VALUES (?, ?, ?, ?, ?)",
      [raidId, userId, charId, stype, sstatus]
    );
  }

  // Build log message matching the text sign-up format:
  // • **CharName** (CharClass) – Spec ⭐ GS 6200 / Spec2 GS 6300
  const charGroups = {};
  for (const id of characterIds) {
    const c = charById[String(id)];
    if (!c) continue;
    const key = c.char_name.toLowerCase();
    if (!charGroups[key]) {
      charGroups[key] = { char_name: c.char_name, char_class: c.char_class || '?', specs: [] };
    }
    const gs = Number(c.gearscore) >= 99999 ? 'BiS' : Math.floor(Number(c.gearscore) || 0);
    const star = prioritySet.has(id) ? ' ⭐' : '';
    charGroups[key].specs.push(`${c.spec || '?'}${star} GS ${gs}`);
  }
  const bullets = Object.values(charGroups).map(
    d => `• **${d.char_name}** (${d.char_class}) – ${d.specs.join(' / ')}`
  );
  const logEmoji = isTentative ? '❓' : '✅';
  const logAction = isTentative ? 'tentatively signed up' : 'signed up';
  const logMsg = `${logEmoji} <@${userId}> ${logAction} for **${raid.name}**:\n${bullets.join('\n')}`;
  postToRaidLogThread(raidId, logMsg).catch(err => {
    console.warn('[log-thread] Failed to post signup log:', err.message || err);
  });

  req.session.flash = isTentative ? '❓ Signed up as tentative!' : '✅ Signed up!';
  res.redirect(raidUrl);
});

// POST /raids/:raid_number/size — update max size of the raid
router.post('/:raid_number/size', express.json(), async (req, res) => {
  if (!await requireAdmin(req, res)) return;

  const raidNumber = parseInt(req.params.raid_number);
  const raid = await getRaidByUrlParams(req.session.active_guild_id || null, raidNumber);
  if (!raid) return res.status(404).json({ ok: false, error: 'Raid not found' });

  const maxSize = parseInt(req.body.max_size);
  if (isNaN(maxSize) || maxSize < 1 || maxSize > 100) {
    return res.status(400).json({ ok: false, error: 'Invalid max_size (must be 1-100)' });
  }

  try {
    await pool.query('UPDATE raids SET max_size = ? WHERE id = ?', [maxSize, raid.id]);
    res.json({ ok: true, max_size: maxSize });
  } catch (err) {
    console.error('[size] Failed to update raid size:', err.message);
    res.status(500).json({ ok: false, error: 'Database error' });
  }
});

// POST /raids/:raid_number/withdraw
router.post('/:raid_number/withdraw', async (req, res) => {
  if (!requireLogin(req, res)) return;

  const raidNumber = parseInt(req.params.raid_number);
  const userId = req.session.user_id;

  const raid = await getRaidByUrlParams(req.session.active_guild_id || null, raidNumber);
  if (!raid) return res.redirect('/raids');

  const [result] = await pool.query(
    'DELETE FROM signups WHERE raid_id = ? AND discord_user_id = ?',
    [raid.id, userId]
  );

  if (result.affectedRows > 0) {
    req.session.flash = '✅ Withdrawn from raid.';
    postToRaidLogThread(raid.id, `❌ <@${userId}> withdrew from the raid.`).catch(err => {
      console.warn('[log-thread] Failed to post withdraw log:', err.message || err);
    });
  } else {
    req.session.flash = 'You were not signed up.';
  }

  res.redirect(raidBaseUrl(raid));
});

// GET /raids/:raid_number/manage
router.get('/:raid_number/manage', async (req, res) => {
  if (!requireLogin(req, res)) return;

  const raidNumber = parseInt(req.params.raid_number);
  const raid = await getRaidByUrlParams(req.session.active_guild_id || null, raidNumber);
  if (!raid) return res.redirect('/raids');

  // Determine edit permission against the raid's own guild.
  const raidGuildId = raid.guild_id ? String(raid.guild_id) : null;
  const canEdit = await resolveIsAdmin(req.session.user_id, raidGuildId);

  const raidId = raid.id;

  const [allSignups] = await pool.query(
    `SELECT s.*, c.id AS c_id, c.char_name, c.realm, c.char_class, c.spec, c.gearscore, c.role,
            du.username AS du_username, du.display_name AS du_display_name
     FROM signups s
     JOIN characters c ON s.character_id = c.id
     LEFT JOIN discord_users du ON du.discord_user_id = s.discord_user_id
     WHERE s.raid_id = ? AND c.is_deleted = 0`,
    [raidId]
  );

  const signups = allSignups.map(s => ({
    ...s,
    character: {
      id: s.c_id,
      char_name: s.char_name,
      realm: s.realm,
      char_class: s.char_class,
      spec: s.spec,
      gearscore: s.gearscore,
      role: s.role,
    },
  }));

  // Build a direct character_id → signup lookup for the roster slot rendering
  const signupByCharId = {};
  for (const s of signups) {
    signupByCharId[String(s.character.id)] = s;
  }

  // Group signups by discord user, then by char_name within each user
  const userSignupMap = {};
  for (const s of signups) {
    const uid = String(s.discord_user_id);
    if (!userSignupMap[uid]) {
      let label;
      if (s.du_username && s.du_display_name && s.du_display_name !== s.du_username) {
        label = `${s.du_username} – ${s.du_display_name}`;
      } else if (s.du_username) {
        label = s.du_username;
      } else {
        label = uid;
      }
      userSignupMap[uid] = { discord_user_id: uid, display_label: label, is_tentative: false, characters: [] };
    }

    // Tentative is a user-level flag: true if any of the user's signups is tentative
    if (s.status === 'tentative') {
      userSignupMap[uid].is_tentative = true;
    }

    // Skip specs/characters that are already saved this lockout — they are not
    // available for the raid and would only add clutter to the pool.
    if (s.is_saved) continue;

    // Find or create a character group by char_name
    let charGroup = userSignupMap[uid].characters.find(cg => cg.char_name === s.character.char_name);
    if (!charGroup) {
      charGroup = {
        char_name: s.character.char_name,
        char_class: s.character.char_class,
        discord_user_id: uid,
        note: s.note || '',
        specs: [],
      };
      userSignupMap[uid].characters.push(charGroup);
    }
    charGroup.specs.push({
      character_id: s.character.id,
      spec: s.character.spec,
      gearscore: s.character.gearscore,
      role: s.character.role,
      is_prio: s.signup_type === 'prio_character' || s.signup_type === 'prio_role',
    });
  }

  // Remove user groups that have no remaining (non-saved) characters.
  for (const uid of Object.keys(userSignupMap)) {
    if (userSignupMap[uid].characters.length === 0) delete userSignupMap[uid];
  }
  const signupsByUser = Object.values(userSignupMap);

  // Fetch which raid instances each signed-up character is currently saved to,
  // so the raid_manage UI can show a lockout-warning tooltip on the signup card.
  const allSignedCharIds = signups
    .filter(s => s.character && s.character.id)
    .map(s => s.character.id);
  const uniqueCharIds = [...new Set(allSignedCharIds)];
  // Map: charId (string) → [instance_name, …]
  const charSavedInstances = {};
  if (uniqueCharIds.length > 0) {
    const placeholders = uniqueCharIds.map(() => '?').join(',');
    const [saveRows] = await pool.query(
      `SELECT character_id, instance_name FROM char_raid_saves
       WHERE character_id IN (${placeholders}) AND is_saved = 1`,
      uniqueCharIds
    );
    for (const row of saveRows) {
      const cid = String(row.character_id);
      if (!charSavedInstances[cid]) charSavedInstances[cid] = [];
      charSavedInstances[cid].push(row.instance_name);
    }
  }

  // Attach saved_instances to each charGroup (union across all specs of that character name)
  for (const userGroup of signupsByUser) {
    for (const charGroup of userGroup.characters) {
      const instanceSet = new Set();
      for (const spec of charGroup.specs) {
        const cid = String(spec.character_id);
        if (charSavedInstances[cid]) {
          for (const inst of charSavedInstances[cid]) instanceSet.add(inst);
        }
      }
      charGroup.saved_instances = [...instanceSet].sort();
    }
  }

  // Sort: players with starred (prio) characters first, tentative players last
  signupsByUser.sort((a, b) => {
    const aPrio = a.characters.some(cg => cg.specs.some(s => s.is_prio));
    const bPrio = b.characters.some(cg => cg.specs.some(s => s.is_prio));
    if (a.is_tentative !== b.is_tentative) return a.is_tentative ? 1 : -1;
    if (aPrio !== bPrio) return aPrio ? -1 : 1;
    return 0;
  });

  // Determine which comp numbers already exist for this raid
  const [existingCompNums] = await pool.query(
    'SELECT DISTINCT comp_number FROM compositions WHERE raid_id = ? ORDER BY comp_number',
    [raidId]
  );
  const compNumbers = existingCompNums.map(r => r.comp_number);
  if (compNumbers.length === 0) compNumbers.push(1);

  // Determine active comp from query param (default: 1)
  const currentComp = parseInt(req.query.comp) || 1;

  // Include the current comp even if it hasn't been saved to the DB yet
  // (e.g. user navigated to a new comp tab but hasn't placed anyone yet)
  if (!compNumbers.includes(currentComp)) {
    compNumbers.push(currentComp);
    compNumbers.sort((a, b) => a - b);
  }

  const [existingComp] = await pool.query(
    `SELECT co.*, s.status AS signup_status,
            du.username AS du_username, du.display_name AS du_display_name
     FROM compositions co
     LEFT JOIN signups s ON s.raid_id = co.raid_id AND s.character_id = co.character_id
     LEFT JOIN discord_users du ON du.discord_user_id = co.discord_user_id
     WHERE co.raid_id = ? AND co.comp_number = ?`,
    [raidId, currentComp]
  );

  const maxSize = raid.max_size || 25;

  // Build lookup maps keyed by absolute slot key "slot_N"
  const compMap = {};
  const placeholderMap = {};
  const playerPlaceholderMap = {};
  const slotRoleMap = {};

  const compStatusMap = {};
  for (const c of existingComp) {
    const slotKey = c.role_slot; // "slot_N" format after migration 005
    const role = c.slot_role || 'dps';
    if (c.character_id) {
      compMap[slotKey] = String(c.character_id);
      compStatusMap[slotKey] = c.signup_status;
    } else if (c.discord_user_id) {
      let displayLabel = c.du_display_name || c.du_username || String(c.discord_user_id);
      playerPlaceholderMap[slotKey] = {
        discord_user_id: String(c.discord_user_id),
        display_label: displayLabel,
        status: userSignupMap[String(c.discord_user_id)]?.is_tentative ? 'tentative' : 'signed'
      };
    } else if (c.placeholder_text) {
      placeholderMap[slotKey] = c.placeholder_text;
    }
    slotRoleMap[slotKey] = role;
  }

  // Build slots array: ["slot_1", "slot_2", ..., "slot_N"]
  // Fill in default role "dps" for slots not present in the DB
  const slots = [];
  for (let i = 1; i <= maxSize; i++) {
    const slotKey = `slot_${i}`;
    slots.push(slotKey);
    if (!slotRoleMap[slotKey]) slotRoleMap[slotKey] = 'dps';
  }

  // Next comp number for "Add Comp" button
  const nextComp = Math.max(...compNumbers, currentComp) + 1;

  // Fetch custom comp labels
  const compLabels = await fetchCompLabels(raidId);

  // Build map of character_id -> [comp_numbers] across ALL comps for this raid.
  // Used by the left-panel to show which characters are already placed.
  const [allCompAssignments] = await pool.query(
    'SELECT character_id, comp_number FROM compositions WHERE raid_id = ? AND character_id IS NOT NULL',
    [raidId]
  );
  const charsInComps = {};
  for (const row of allCompAssignments) {
    const cid = String(row.character_id);
    if (!charsInComps[cid]) charsInComps[cid] = [];
    charsInComps[cid].push(row.comp_number);
  }

  // Build per-comp role-count summaries for the post confirmation modal
  const compSummaries = {};
  for (const cn of compNumbers) {
    compSummaries[cn] = { tank: 0, healer: 0, mdps: 0, rdps: 0, dps: 0 };
  }
  if (compNumbers.length > 1) {
    const sqlPlaceholders = compNumbers.map(() => '?').join(', ');
    const [summaryRows] = await pool.query(
      `SELECT comp_number, slot_role, COUNT(*) AS cnt
       FROM compositions
       WHERE raid_id = ? AND comp_number IN (${sqlPlaceholders})
       GROUP BY comp_number, slot_role`,
      [raidId, ...compNumbers]
    );
    for (const row of summaryRows) {
      const cn = row.comp_number;
      if (compSummaries[cn] && ['tank', 'healer', 'mdps', 'rdps', 'dps'].includes(row.slot_role)) {
        compSummaries[cn][row.slot_role] = Number(row.cnt);
      }
    }
  }

  res.render('raid_manage.html', {
    raid,
    raid_url: raidBaseUrl(raid),
    signups,
    signupsByUser,
    signup_by_char_id: signupByCharId,
    comp_status_map: compStatusMap,
    slots,
    comp_map: compMap,
    placeholder_map: placeholderMap,
    player_placeholder_map: playerPlaceholderMap,
    slot_role_map: slotRoleMap,
    max_size: maxSize,
    comp_numbers: compNumbers,
    comp_labels: compLabels,
    current_comp: currentComp,
    next_comp: nextComp,
    comp_summaries: compSummaries,
    chars_in_comps: charsInComps,
    wotlk_buffs: WOTLK_BUFFS,
    flash: popFlash(req),
    user: currentUser(req),
    can_edit: canEdit,
  });
});

// POST /raids/:raid_number/manage (JSON body) — full-state save used by manual "Save & Reload"
router.post('/:raid_number/manage', express.json(), async (req, res) => {
  if (!await requireAdmin(req, res)) return;

  const raidNumber = parseInt(req.params.raid_number);
  const raid = await getRaidByUrlParams(req.session.active_guild_id || null, raidNumber);
  if (!raid) return res.status(404).json({ ok: false, error: 'Raid not found' });

  const raidId = raid.id;
  const userId = req.session.user_id;
  const compNumber = parseInt(req.query.comp) || 1;
  const body = req.body;

  if (!Array.isArray(body)) {
    return res.json({ ok: false, error: 'Body must be a list of {character_id?, placeholder_text?, role_slot} entries.' });
  }

  for (const entry of body) {
    if (typeof entry !== 'object' || !('role_slot' in entry)) {
      return res.json({ ok: false, error: 'Each entry must have a role_slot field.' });
    }
    const hasChar = 'character_id' in entry && entry.character_id !== null && entry.character_id !== '';
    const hasPlayer = 'discord_user_id' in entry && entry.discord_user_id;
    const hasPlaceholder = 'placeholder_text' in entry && entry.placeholder_text;
    if (!hasChar && !hasPlayer && !hasPlaceholder) {
      return res.json({ ok: false, error: 'Each entry must have character_id, discord_user_id, or placeholder_text.' });
    }
    if (hasChar && isNaN(parseInt(entry.character_id))) {
      return res.json({ ok: false, error: `Invalid character_id: ${entry.character_id}` });
    }
  }

  // Separate character entries, player entries, and placeholder entries
  const charEntries = body.filter(e => e.character_id !== null && e.character_id !== undefined && e.character_id !== '');
  const playerEntries = body.filter(e => !e.character_id && e.discord_user_id);
  const placeholderEntries = body.filter(e => !e.character_id && !e.discord_user_id && e.placeholder_text);

  if (charEntries.length > 0) {
    // Validate: each Discord user may only appear once in the composition
    const charIds = charEntries.map(e => parseInt(e.character_id));
    const placeholders = charIds.map(() => '?').join(', ');
    const [chars] = await pool.query(
      `SELECT id, discord_user_id FROM characters WHERE id IN (${placeholders}) AND is_deleted = 0`,
      charIds
    );
    const seenUsers = new Set();
    for (const char of chars) {
      const uid = String(char.discord_user_id);
      if (seenUsers.has(uid)) {
        return res.json({ ok: false, error: 'Each Discord user can only have one character in the raid composition. Please remove duplicate assignments.' });
      }
      seenUsers.add(uid);
    }
  }

  await pool.query('DELETE FROM compositions WHERE raid_id = ? AND comp_number = ?', [raidId, compNumber]);

  const validRoles = ['tank', 'healer', 'dps', 'mdps', 'rdps'];

  for (const entry of charEntries) {
    const slotRole = validRoles.includes(entry.slot_role) ? entry.slot_role : 'dps';
    await pool.query(
      'INSERT INTO compositions (raid_id, character_id, placeholder_text, discord_user_id, role_slot, slot_role, comp_number, created_by, created_at, updated_at) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, NOW(3), NOW(3))',
      [raidId, parseInt(entry.character_id), entry.role_slot, slotRole, compNumber, userId]
    );
  }

  for (const entry of playerEntries) {
    const slotRole = validRoles.includes(entry.slot_role) ? entry.slot_role : 'dps';
    await pool.query(
      'INSERT INTO compositions (raid_id, character_id, placeholder_text, discord_user_id, role_slot, slot_role, comp_number, created_by, created_at, updated_at) VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, NOW(3), NOW(3))',
      [raidId, entry.discord_user_id, entry.role_slot, slotRole, compNumber, userId]
    );
  }

  for (const entry of placeholderEntries) {
    const slotRole = validRoles.includes(entry.slot_role) ? entry.slot_role : 'dps';
    await pool.query(
      'INSERT INTO compositions (raid_id, character_id, placeholder_text, discord_user_id, role_slot, slot_role, comp_number, created_by, created_at, updated_at) VALUES (?, NULL, ?, NULL, ?, ?, ?, ?, NOW(3), NOW(3))',
      [raidId, entry.placeholder_text, entry.role_slot, slotRole, compNumber, userId]
    );
  }

  res.json({ ok: true });
});

// PATCH /raids/:raid_number/manage — granular per-slot auto-save (last-write-wins per slot)
// Body: array of { role_slot, slot_role?, character_id? | placeholder_text? | clear: true }
// Only the slots present in the payload are touched; all other slots are left as-is.
router.patch('/:raid_number/manage', express.json(), async (req, res) => {
  if (!req.session.user_id) return res.status(401).json({ ok: false });
  const patchGuildId = req.session.active_guild_id || null;
  if (!await resolveIsAdmin(req.session.user_id, patchGuildId)) return res.status(403).json({ ok: false, error: 'Forbidden' });

  const raidNumber = parseInt(req.params.raid_number);
  const raid = await getRaidByUrlParams(patchGuildId, raidNumber);
  if (!raid) return res.status(404).json({ ok: false, error: 'Raid not found' });

  const raidId = raid.id;
  const userId = req.session.user_id;
  const compNumber = parseInt(req.query.comp) || 1;
  const body = req.body;

  if (!Array.isArray(body) || body.length === 0) {
    // Return current composition even for empty payloads
    const [emptyRows] = await pool.query(
      `SELECT co.role_slot, co.slot_role, co.character_id, co.placeholder_text,
              c.char_name, c.char_class, c.spec, c.discord_user_id AS char_discord_user_id,
              s.status AS signup_status
       FROM compositions co
       LEFT JOIN characters c ON co.character_id = c.id
       LEFT JOIN signups s ON s.raid_id = co.raid_id AND s.character_id = co.character_id
       WHERE co.raid_id = ? AND co.comp_number = ?
       ORDER BY co.role_slot`,
      [raidId, compNumber]
    );
    const emptyEntries = emptyRows.map(r => ({
      role_slot: r.role_slot,
      slot_role: r.slot_role || 'dps',
      character_id: r.character_id ? String(r.character_id) : null,
      placeholder_text: r.placeholder_text || null,
      char_name: r.char_name || null,
      char_class: r.char_class ? r.char_class.toLowerCase().replace(/ /g, '-') : null,
      spec: r.spec || null,
      discord_user_id: r.char_discord_user_id ? String(r.char_discord_user_id) : null,
      status: r.signup_status || null,
    }));
    return res.json({ ok: true, saved: [], entries: emptyEntries });
  }

  // Basic validation
  for (const entry of body) {
    if (typeof entry !== 'object' || !entry.role_slot) {
      return res.json({ ok: false, error: 'Each entry must have a role_slot field.' });
    }
    const hasChar = entry.character_id !== null && entry.character_id !== undefined && entry.character_id !== '';
    const hasPlayer = !!entry.discord_user_id;
    const hasPlaceholder = !!entry.placeholder_text;
    const isClear = entry.clear === true;
    if (!hasChar && !hasPlayer && !hasPlaceholder && !isClear) {
      return res.json({ ok: false, error: `Entry for ${entry.role_slot} must have character_id, discord_user_id, placeholder_text, or clear:true.` });
    }
    if (hasChar && isNaN(parseInt(entry.character_id))) {
      return res.json({ ok: false, error: `Invalid character_id: ${entry.character_id}` });
    }
  }

  const savedSlots = [];

  for (const entry of body) {
    const { role_slot } = entry;
    const validRoles = ['tank', 'healer', 'dps', 'mdps', 'rdps'];
    const slotRole = validRoles.includes(entry.slot_role) ? entry.slot_role : 'dps';
    const charId = (entry.character_id !== null && entry.character_id !== undefined && entry.character_id !== '')
      ? parseInt(entry.character_id) : null;
    const discordUserId = entry.discord_user_id || null;
    const placeholderText = entry.placeholder_text || null;
    const isClear = entry.clear === true;

    if (isClear) {
      await pool.query(
        'DELETE FROM compositions WHERE raid_id = ? AND comp_number = ? AND role_slot = ?',
        [raidId, compNumber, role_slot]
      );
      savedSlots.push({ role_slot, cleared: true });
    } else if (charId !== null) {
      await pool.query(
        `INSERT INTO compositions (raid_id, character_id, placeholder_text, discord_user_id, role_slot, slot_role, comp_number, created_by, created_at, updated_at)
         VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, NOW(3), NOW(3))
         ON DUPLICATE KEY UPDATE
           character_id    = VALUES(character_id),
           placeholder_text = NULL,
           discord_user_id  = NULL,
           slot_role       = VALUES(slot_role),
           created_by      = VALUES(created_by),
           updated_at      = NOW(3)`,
        [raidId, charId, role_slot, slotRole, compNumber, userId]
      );
      savedSlots.push({ role_slot });
    } else if (discordUserId) {
      await pool.query(
        `INSERT INTO compositions (raid_id, character_id, placeholder_text, discord_user_id, role_slot, slot_role, comp_number, created_by, created_at, updated_at)
         VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, NOW(3), NOW(3))
         ON DUPLICATE KEY UPDATE
           character_id    = NULL,
           placeholder_text = NULL,
           discord_user_id  = VALUES(discord_user_id),
           slot_role       = VALUES(slot_role),
           created_by      = VALUES(created_by),
           updated_at      = NOW(3)`,
        [raidId, discordUserId, role_slot, slotRole, compNumber, userId]
      );
      savedSlots.push({ role_slot });
    } else if (placeholderText) {
      await pool.query(
        `INSERT INTO compositions (raid_id, character_id, placeholder_text, discord_user_id, role_slot, slot_role, comp_number, created_by, created_at, updated_at)
         VALUES (?, NULL, ?, NULL, ?, ?, ?, ?, NOW(3), NOW(3))
         ON DUPLICATE KEY UPDATE
           character_id    = NULL,
           placeholder_text = VALUES(placeholder_text),
           discord_user_id  = NULL,
           slot_role       = VALUES(slot_role),
           created_by      = VALUES(created_by),
           updated_at      = NOW(3)`,
        [raidId, placeholderText, role_slot, slotRole, compNumber, userId]
      );
      savedSlots.push({ role_slot });
    }
  }

  // Return the full current composition so all clients can converge immediately
  const [rows] = await pool.query(
    `SELECT co.role_slot, co.slot_role, co.character_id, co.placeholder_text, co.discord_user_id,
            c.char_name, c.char_class, c.spec, c.discord_user_id AS char_discord_user_id,
            s.status AS signup_status,
            du.username AS du_username, du.display_name AS du_display_name
     FROM compositions co
     LEFT JOIN characters c ON co.character_id = c.id
     LEFT JOIN signups s ON s.raid_id = co.raid_id AND s.character_id = co.character_id
     LEFT JOIN discord_users du ON du.discord_user_id = co.discord_user_id
     WHERE co.raid_id = ? AND co.comp_number = ?
     ORDER BY co.role_slot`,
    [raidId, compNumber]
  );

  const entries = rows.map(r => ({
    role_slot: r.role_slot,
    slot_role: r.slot_role || 'dps',
    character_id: r.character_id ? String(r.character_id) : null,
    placeholder_text: r.placeholder_text || null,
    discord_user_id: r.discord_user_id ? String(r.discord_user_id) : (r.char_discord_user_id ? String(r.char_discord_user_id) : null),
    display_label: r.du_display_name || r.du_username || null,
    char_name: r.char_name || null,
    char_class: r.char_class ? r.char_class.toLowerCase().replace(/ /g, '-') : null,
    spec: r.spec || null,
    status: r.signup_status || null,
  }));

  res.json({ ok: true, saved: savedSlots, entries });
});

// GET /raids/:raid_number/manage/json  — polling endpoint for collaborative auto-load
router.get('/:raid_number/manage/json', async (req, res) => {
  if (!req.session.user_id) return res.status(401).json({ ok: false });

  const raidNumber = parseInt(req.params.raid_number);
  const raid = await getRaidByUrlParams(req.session.active_guild_id || null, raidNumber);
  if (!raid) return res.status(404).json({ ok: false, error: 'Raid not found' });

  const raidId = raid.id;
  const compNumber = parseInt(req.query.comp) || 1;

  const [rows] = await pool.query(
    `SELECT co.role_slot, co.slot_role, co.character_id, co.placeholder_text, co.discord_user_id,
            MAX(co.updated_at) OVER () AS max_updated_at,
            c.char_name, c.char_class, c.spec, c.discord_user_id AS char_discord_user_id,
            s.status AS signup_status,
            du.username AS du_username, du.display_name AS du_display_name
     FROM compositions co
     LEFT JOIN characters c ON co.character_id = c.id
     LEFT JOIN signups s ON s.raid_id = co.raid_id AND s.character_id = co.character_id
     LEFT JOIN discord_users du ON du.discord_user_id = co.discord_user_id
     WHERE co.raid_id = ? AND co.comp_number = ?
     ORDER BY co.role_slot`,
    [raidId, compNumber]
  );

  // Version = ISO string of most recent updated_at across all slots
  const version = rows.length > 0 && rows[0].max_updated_at
    ? (rows[0].max_updated_at instanceof Date
        ? rows[0].max_updated_at.toISOString()
        : String(rows[0].max_updated_at))
    : '';

  const entries = rows.map(r => ({
    role_slot: r.role_slot,
    slot_role: r.slot_role || 'dps',
    character_id: r.character_id ? String(r.character_id) : null,
    placeholder_text: r.placeholder_text || null,
    discord_user_id: r.discord_user_id ? String(r.discord_user_id) : (r.char_discord_user_id ? String(r.char_discord_user_id) : null),
    display_label: r.du_display_name || r.du_username || null,
    char_name: r.char_name || null,
    char_class: r.char_class ? r.char_class.toLowerCase().replace(/ /g, '-') : null,
    spec: r.spec || null,
    status: r.signup_status || null,
  }));

  res.json({ ok: true, version: version || '', entries });
});

// PUT /raids/:raid_number/comp_label — set or clear a custom label for a comp tab
router.put('/:raid_number/comp_label', express.json(), async (req, res) => {
  if (!req.session.user_id) return res.status(401).json({ ok: false });
  const putGuildId = req.session.active_guild_id || null;
  if (!await resolveIsAdmin(req.session.user_id, putGuildId)) return res.status(403).json({ ok: false, error: 'Forbidden' });

  const raidNumber = parseInt(req.params.raid_number);
  const raid = await getRaidByUrlParams(putGuildId, raidNumber);
  if (!raid) return res.status(404).json({ ok: false, error: 'Raid not found' });

  const raidId = raid.id;
  const { comp_number, label } = req.body || {};

  if (comp_number == null || typeof label !== 'string') {
    return res.status(400).json({ ok: false, error: 'comp_number and label are required' });
  }

  const trimmed = label.trim().slice(0, 100);
  if (trimmed) {
    await pool.query(
      'INSERT INTO comp_labels (raid_id, comp_number, label) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE label = ?',
      [raidId, comp_number, trimmed, trimmed]
    );
  } else {
    await pool.query('DELETE FROM comp_labels WHERE raid_id = ? AND comp_number = ?', [raidId, comp_number]);
  }

  res.json({ ok: true, label: trimmed || null });
});

// GET /raids/:raid_number/comp
router.get('/:raid_number/comp', async (req, res) => {
  if (!requireLogin(req, res)) return;

  const raidNumber = parseInt(req.params.raid_number);
  const raid = await getRaidByUrlParams(req.session.active_guild_id || null, raidNumber);
  if (!raid) return res.redirect('/raids');

  const raidId = raid.id;

  // Determine which comp numbers exist
  const [existingCompNums] = await pool.query(
    'SELECT DISTINCT comp_number FROM compositions WHERE raid_id = ? ORDER BY comp_number',
    [raidId]
  );
  const compNumbers = existingCompNums.map(r => r.comp_number);
  if (compNumbers.length === 0) compNumbers.push(1);

  const currentComp = parseInt(req.query.comp) || compNumbers[0];

  const [comps] = await pool.query(
    `SELECT co.*, c.id AS c_id, c.char_name, c.realm, c.char_class, c.spec, c.gearscore, c.role, c.discord_user_id AS char_discord_user_id,
            s.status AS signup_status,
            du.username AS du_username, du.display_name AS du_display_name
     FROM compositions co
     LEFT JOIN characters c ON co.character_id = c.id
     LEFT JOIN signups s ON s.raid_id = co.raid_id AND s.character_id = co.character_id
     LEFT JOIN discord_users du ON du.discord_user_id = co.discord_user_id
     WHERE co.raid_id = ? AND co.comp_number = ?
     ORDER BY co.role_slot`,
    [raidId, currentComp]
  );

  const groups = { tank: [], healer: [], mdps: [], rdps: [], dps: [] };
  for (const comp of comps) {
    const entry = {
      ...comp,
      is_placeholder: !comp.character_id && !comp.discord_user_id,
      is_player_placeholder: !!comp.discord_user_id && !comp.character_id,
      placeholder_text: comp.placeholder_text || null,
      discord_user_id: comp.discord_user_id ? String(comp.discord_user_id) : null,
      display_label: comp.du_display_name || comp.du_username || null,
      character: comp.character_id ? {
        id: comp.c_id,
        char_name: comp.char_name,
        realm: comp.realm,
        char_class: comp.char_class,
        spec: comp.spec,
        gearscore: comp.gearscore,
        role: comp.role,
        discord_user_id: comp.char_discord_user_id,
        status: comp.signup_status,
      } : null,
    };
    // Use slot_role column (populated during migration 005) for grouping
    const roleKey = comp.slot_role || 'dps';
    if (groups[roleKey]) {
      groups[roleKey].push(entry);
    } else {
      groups[roleKey] = [entry];
    }
  }

  const compLabels = await fetchCompLabels(raidId);

  res.render('raid_comp.html', {
    raid,
    raid_url: raidBaseUrl(raid),
    groups,
    comp_numbers: compNumbers,
    comp_labels: compLabels,
    current_comp: currentComp,
    flash: popFlash(req),
    user: currentUser(req),
  });
});

// POST /raids/:raid_number/lock
router.post('/:raid_number/lock', async (req, res) => {
  if (!await requireAdmin(req, res)) return;

  const raidNumber = parseInt(req.params.raid_number);
  const raid = await getRaidByUrlParams(req.session.active_guild_id || null, raidNumber);

  if (raid) {
    await pool.query("UPDATE raids SET status = 'locked' WHERE id = ?", [raid.id]);
    req.session.flash = `🔒 Raid '${raid.name}' locked.`;
  }

  res.redirect(raid ? `${raidBaseUrl(raid)}/manage` : '/raids');
});

// POST /raids/:raid_number/post_comp
router.post('/:raid_number/post_comp', async (req, res) => {
  if (!await requireAdmin(req, res)) return;

  const raidNumber = parseInt(req.params.raid_number);
  const compNumber = req.query.comp ? parseInt(req.query.comp) : null;
  const raid = await getRaidByUrlParams(req.session.active_guild_id || null, raidNumber);

  if (raid) {
    const raidId = raid.id;
    // Determine all comp numbers so we know if this is a multi-comp raid
    const [existingCompNums] = await pool.query(
      'SELECT DISTINCT comp_number FROM compositions WHERE raid_id = ? ORDER BY comp_number',
      [raidId]
    );
    const allCompNumbers = existingCompNums.map(r => r.comp_number);
    if (allCompNumbers.length === 0) allCompNumbers.push(1);

    // Post the selected comp (or all comps if no specific one was selected) to Discord
    const compsToPost = compNumber !== null ? [compNumber] : allCompNumbers;

    // Fetch custom comp labels for embed titles
    const compLabels = await fetchCompLabels(raidId);

    // Fetch spec aliases for canonical spec mapping
    const specAliasesMap = await fetchSpecAliases();

    // Post the final composition to the main raid channel (not the log thread)
    const discordTargetId = raid.discord_channel_id;

    if (discordTargetId) {
      let allPosted = true;
      for (const cn of compsToPost) {
        const [comps] = await pool.query(
          `SELECT co.slot_role, co.character_id, co.placeholder_text, co.discord_user_id,
                  c.char_name, c.char_class, c.spec, c.role, c.discord_user_id AS char_discord_user_id,
                  s.status AS signup_status,
                  du.username AS du_username, du.display_name AS du_display_name
           FROM compositions co
           LEFT JOIN characters c ON co.character_id = c.id
           LEFT JOIN signups s ON s.raid_id = co.raid_id AND s.character_id = co.character_id
           LEFT JOIN discord_users du ON du.discord_user_id = co.discord_user_id
           WHERE co.raid_id = ? AND co.comp_number = ?
           ORDER BY co.role_slot`,
          [raidId, cn]
        );

        const groups = { tank: [], healer: [], mdps: [], rdps: [], dps: [] };
        for (const comp of comps) {
          const entry = {
            slot_role: comp.slot_role || 'dps',
            is_placeholder: !comp.character_id && !comp.discord_user_id,
            is_player_placeholder: !!comp.discord_user_id && !comp.character_id,
            placeholder_text: comp.placeholder_text || null,
            discord_user_id: comp.discord_user_id ? String(comp.discord_user_id) : null,
            display_label: comp.du_display_name || comp.du_username || null,
            character: comp.character_id ? {
              char_name: comp.char_name,
              char_class: comp.char_class,
              spec: comp.spec,
              role: comp.role,
              discord_user_id: comp.char_discord_user_id ? String(comp.char_discord_user_id) : null,
              status: comp.signup_status,
            } : null,
          };
          const roleKey = comp.slot_role || 'dps';
          if (groups[roleKey]) groups[roleKey].push(entry);
        }

        const payload = buildCompEmbed(raid, groups, cn, allCompNumbers.length, compLabels, specAliasesMap);
        const result = await postToDiscordChannel(String(discordTargetId), payload);
        if (!result.ok) {
          allPosted = false;
          console.error(`[post_comp] Failed to post comp ${cn} for raid ${raidId}: ${result.reason}`);
          console.debug(`[post_comp] Debug — target channel id: ${discordTargetId} (channel_id: ${raid.discord_channel_id})`);
        }
      }
      if (allPosted) {
        req.session.flash = `📋 Composition for '${raid.name}' sent to Discord.`;
      } else {
        req.session.flash = `📋 Composition for '${raid.name}' could not be fully sent to Discord. Check server logs for details.`;
      }
    } else {
      req.session.flash = `📋 Composition posted. (No Discord channel linked — create the raid via bot to enable auto-posting.)`;
    }
  }

  const compParam = compNumber !== null ? `?comp=${compNumber}` : '';
  res.redirect(raid ? `${raidBaseUrl(raid)}/comp${compParam}` : '/raids');
});

// POST /raids/:raid_number/unlock
router.post('/:raid_number/unlock', async (req, res) => {
  if (!await requireAdmin(req, res)) return;

  const raidNumber = parseInt(req.params.raid_number);
  const raid = await getRaidByUrlParams(req.session.active_guild_id || null, raidNumber);

  if (raid && raid.status === 'locked') {
    await pool.query("UPDATE raids SET status = 'open' WHERE id = ?", [raid.id]);
    req.session.flash = `🟢 Raid '${raid.name}' unlocked and open for sign-ups.`;
  } else if (raid) {
    req.session.flash = `ℹ️ Raid '${raid.name}' is already open.`;
  }

  res.redirect(raid ? `${raidBaseUrl(raid)}/manage` : '/raids');
});

module.exports = router;
