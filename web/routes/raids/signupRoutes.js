'use strict';

function registerSignupRoutes(router, dependencies) {
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

  // GET /raids/:raid_number
  router.get('/:raid_number', async (req, res) => {
    if (!requireLogin(req, res)) return;

    const raidNumber = parseInt(req.params.raid_number);
    const userId = req.session.user_id;

    const raid = await getRaidByUrlParams(req.session.active_guild_id || null, raidNumber);
    if (!raid) return res.redirect('/raids');

    const raidId = raid.id;

    const [[counts]] = await pool.query(
      `SELECT
       COALESCE(SUM(CASE WHEN user_status = 'coming' THEN 1 ELSE 0 END), 0) AS coming_count,
       COALESCE(SUM(CASE WHEN user_status = 'tentative' THEN 1 ELSE 0 END), 0) AS tentative_count
     FROM (
       SELECT
         discord_user_id,
         CASE
           WHEN SUM(CASE WHEN status = '${SIGNUP_STATUS_SIGNED}' THEN 1 ELSE 0 END) > 0 THEN 'coming'
           ELSE 'tentative'
         END AS user_status
       FROM signups
       WHERE raid_id = ?
       GROUP BY discord_user_id
     ) users`,
      [raidId]
    );
    raid.signup_coming_count = counts.coming_count;
    raid.signup_tentative_count = counts.tentative_count;

    const [userChars] = await pool.query(
      'SELECT * FROM characters WHERE discord_user_id = ? AND guild_id = ? AND is_deleted = 0',
      [userId, raid.guild_id]
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
    const mySignupNoteByCharId = {};
    for (const row of mySignupRows) {
      mySignupMap[String(row.character_id)] = {
        signup_type: row.signup_type,
        status: row.status,
      };
      if (row.note) {
        mySignupNoteByCharId[String(row.character_id)] = row.note;
      }
    }

    // Group user's characters by char_name so each character shows once with all specs
    const charGroupMap = {};
    for (const c of userChars) {
      if (!charGroupMap[c.char_name]) {
        charGroupMap[c.char_name] = {
          char_name: c.char_name,
          char_class: c.char_class,
          note: '',
          specs: [],
        };
      }
      charGroupMap[c.char_name].specs.push({
        id: c.id,
        spec: c.spec,
        gearscore: c.gearscore,
        role: c.role,
      });
      if (!charGroupMap[c.char_name].note && mySignupNoteByCharId[String(c.id)]) {
        charGroupMap[c.char_name].note = mySignupNoteByCharId[String(c.id)];
      }
    }
    const userCharGroups = Object.values(charGroupMap);

    res.render('raid_detail.html', {
      raid,
      raid_url: raidBaseUrl(raid),
      user_char_groups: userCharGroups,
      my_signup_map: mySignupMap,
      my_signup_count: mySignupRows.length,
      my_signup_is_tentative:
        mySignupRows.length > 0 && mySignupRows.every((row) => row.status === 'tentative'),
      signup_note_max_length: SIGNUP_NOTE_MAX_LENGTH,
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
            console.warn(
              '[signup] Failed to fetch guild member for restriction check:',
              _err.message || _err
            );
          }
        }

        if (!member) {
          if (restriction === 'role') {
            req.session.flash =
              '❌ You must be a member of the guild with the required role to sign up for raids.';
          } else {
            req.session.flash = '❌ You must be a member of the guild to sign up for raids.';
          }
          return res.redirect(raidUrl);
        }

        if (restriction === 'role') {
          const requiredRoleId = guildSettings.signup_role_id
            ? String(guildSettings.signup_role_id)
            : null;
          const memberRoles = (member.roles || []).map(String);
          if (!requiredRoleId || !memberRoles.includes(requiredRoleId)) {
            req.session.flash = '❌ You do not have the required role to sign up for raids.';
            return res.redirect(raidUrl);
          }
        }
      }
    }

    const selection = parseSignupSelection(req.body, SIGNUP_NOTE_MAX_LENGTH);
    if (selection.error) {
      req.session.flash = `❌ ${selection.error}`;
      return res.redirect(raidUrl);
    }
    const { characterIds, isTentative, notes: noteByCharId, priorityIds: prioritySet } = selection;

    // Verify all selected characters belong to this user and the active guild
    if (characterIds.length > 0) {
      const placeholders = characterIds.map(() => '?').join(', ');
      const [owned] = await pool.query(
        `SELECT id FROM characters WHERE id IN (${placeholders}) AND discord_user_id = ? AND guild_id = ? AND is_deleted = 0`,
        [...characterIds, userId, raid.guild_id]
      );
      if (owned.length !== characterIds.length) {
        req.session.flash = '❌ Invalid character selection.';
        return res.redirect(raidUrl);
      }
    }

    // Fetch character details for the log message before deleting existing signups
    const charPlaceholders = characterIds.map(() => '?').join(', ');
    const [charRows] = await pool.query(
      `SELECT id, char_name, char_class, spec, gearscore FROM characters WHERE id IN (${charPlaceholders}) AND guild_id = ? AND is_deleted = 0`,
      [...characterIds, raid.guild_id]
    );
    const charById = {};
    for (const c of charRows) charById[String(c.id)] = c;

    // Fetch discord role
    let topRoleName = null;
    const userGuildRolesMap = await fetchUserGuildRoles(guildId, [userId]);
    if (userGuildRolesMap[userId]) {
      topRoleName = userGuildRolesMap[userId];
    }

    // Delete all existing signups for this user in this raid, then re-insert
    await pool.query('DELETE FROM signups WHERE raid_id = ? AND discord_user_id = ?', [
      raidId,
      userId,
    ]);

    for (const charId of characterIds) {
      const stype = prioritySet.has(charId) ? 'prio_character' : 'fill';
      const sstatus = isTentative ? 'tentative' : 'signed';
      const note = noteByCharId.get(charId) || null;
      await pool.query(
        'INSERT INTO signups (raid_id, discord_user_id, character_id, signup_type, status, note) VALUES (?, ?, ?, ?, ?, ?)',
        [raidId, userId, charId, stype, sstatus, note]
      );

      // Update character's auto-detected role
      const c = charById[String(charId)];
      if (c) {
        const charRole = getRoleFromSpec(c.char_class, c.spec);
        await pool.query(
          'UPDATE characters SET role = ?, last_updated = NOW() WHERE id = ? AND guild_id = ?',
          [charRole, charId, raid.guild_id]
        );
      }
    }

    // Update ALL characters for this user in this guild with the latest Discord info
    await pool.query(
      'UPDATE characters SET discord_role = ?, membership_status = "active", last_updated = NOW() WHERE guild_id = ? AND discord_user_id = ?',
      [topRoleName, guildId, userId]
    );

    // Build log message matching the text sign-up format:
    // • **CharName** (CharClass) – Spec ⭐ GS 6200 / Spec2 GS 6300
    const charGroups = {};
    for (const id of characterIds) {
      const c = charById[String(id)];
      if (!c) continue;
      const key = c.char_name.toLowerCase();
      if (!charGroups[key]) {
        charGroups[key] = {
          char_name: c.char_name,
          char_class: c.char_class || '?',
          specs: [],
          note: '',
        };
      }
      const gs = Number(c.gearscore) >= 99999 ? 'BiS' : Math.floor(Number(c.gearscore) || 0);
      const star = prioritySet.has(id) ? ' ⭐' : '';
      const note = noteByCharId.get(id);
      if (!charGroups[key].note && note) {
        charGroups[key].note = note;
      }
      charGroups[key].specs.push(`${c.spec || '?'}${star} GS ${gs}`);
    }
    const bullets = Object.values(charGroups).map(
      (d) =>
        `• **${d.char_name}** (${d.char_class}) – ${d.specs.join(' / ')}${d.note ? ` 💬 *${d.note}*` : ''}`
    );
    const logEmoji = isTentative ? '❓' : '✅';
    const logAction = isTentative ? 'tentatively signed up' : 'signed up';
    const logMsg = `${logEmoji} <@${userId}> ${logAction} for **${raid.name}**:\n${bullets.join('\n')}`;
    try {
      await postToRaidLogThread(raidId, logMsg, userId);
    } catch (err) {
      console.warn('[log-thread] Failed to post signup log:', err.message || err);
    }

    req.session.flash = isTentative ? '❓ Signed up as tentative!' : '✅ Signed up!';
    res.redirect(raidUrl);
  });

  // POST /raids/:raid_number/size — update max size of the raid
  router.post('/:raid_number/size', express.json(), async (req, res) => {
    if (!(await requireAdmin(req, res))) return;

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
      try {
        await postToRaidLogThread(raid.id, `❌ <@${userId}> withdrew from the raid.`, userId);
      } catch (err) {
        console.warn('[log-thread] Failed to post withdraw log:', err.message || err);
      }
    } else {
      req.session.flash = 'You were not signed up.';
    }

    res.redirect(raidBaseUrl(raid));
  });
}

module.exports = registerSignupRoutes;
