'use strict';

const { ensureCompositionMeta, parseCompNumber } = require('../../services/compositionWorkflow');

function registerCompositionRoutes(router, dependencies) {
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
    editDiscordMessage,
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
    isDiscordNotFound,
    syncRaidSignupMessage,
  } = dependencies;

  function actionRedirect(req, raid) {
    if (!raid) return '/raids';
    if (req.body && req.body.return_to === 'list') return '/raids';
    if (req.body && req.body.return_to === 'detail') return raidBaseUrl(raid);
    return `${raidBaseUrl(raid)}/manage`;
  }

  async function refreshDiscordPost(raid) {
    try {
      const updatedRaid = await getRaidByUrlParams(raid.guild_id, raid.guild_raid_number);
      const result = await syncRaidSignupMessage(updatedRaid);
      return result.ok;
    } catch (error) {
      console.warn('[raid-status] Failed to refresh Discord post:', error.message || error);
      return false;
    }
  }

  // GET /raids/:raid_number/comp
  router.get('/:raid_number/comp', async (req, res) => {
    if (!requireLogin(req, res)) return;

    const raidNumber = parseInt(req.params.raid_number);
    const raid = await getRaidByUrlParams(req.session.active_guild_id || null, raidNumber);
    if (!raid) return res.redirect('/raids');

    const raidId = raid.id;

    // Determine which comp numbers exist
    await ensureCompositionMeta(pool, raidId, 1);
    const [existingCompNums] = await pool.query(
      'SELECT comp_number FROM composition_meta WHERE raid_id = ? ORDER BY comp_number',
      [raidId]
    );
    const compNumbers = existingCompNums.map((r) => r.comp_number);
    if (compNumbers.length === 0) compNumbers.push(1);

    const currentComp = parseInt(req.query.comp) || compNumbers[0];

    const [comps] = await pool.query(
      `SELECT co.*, c.id AS c_id, c.char_name, c.realm, c.char_class, c.spec, c.gearscore, c.role,
            c.sfs_count, c.val_count,
            c.discord_user_id AS char_discord_user_id,
            s.status AS signup_status,
            du.username AS du_username, du.display_name AS du_display_name
     FROM compositions co
     LEFT JOIN characters c ON co.character_id = c.id
     LEFT JOIN signups s ON s.raid_id = co.raid_id AND s.character_id = co.character_id
     LEFT JOIN discord_users du ON du.discord_user_id = COALESCE(co.discord_user_id, s.discord_user_id, c.discord_user_id)
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
        display_label:
          comp.du_username && comp.du_display_name && comp.du_display_name !== comp.du_username
            ? `${comp.du_username} – ${comp.du_display_name}`
            : comp.du_display_name || comp.du_username || null,
        character: comp.character_id
          ? {
              id: comp.c_id,
              char_name: comp.char_name,
              realm: comp.realm,
              char_class: comp.char_class,
              spec: comp.spec,
              gearscore: comp.gearscore,
              role: comp.role,
              sfs_count: comp.sfs_count,
              val_count: comp.val_count,
              is_sfs_collector: !!comp.is_sfs_collector,
              is_val_collector: !!comp.is_val_collector,
              discord_user_id: comp.char_discord_user_id,
              status: comp.signup_status,
            }
          : null,
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
  router.post('/:raid_number/lock', express.urlencoded({ extended: false }), async (req, res) => {
    if (!(await requireAdmin(req, res))) return;

    const raidNumber = parseInt(req.params.raid_number);
    const raid = await getRaidByUrlParams(req.session.active_guild_id || null, raidNumber);

    if (raid && raid.status !== 'locked') {
      await pool.query("UPDATE raids SET status = 'locked' WHERE id = ?", [raid.id]);
      req.session.flash = `🔒 Raid '${raid.name}' locked.`;
      if (!(await refreshDiscordPost(raid))) {
        req.session.flash += ' The Discord post could not be refreshed.';
      }
    } else if (raid) {
      req.session.flash = `ℹ️ Raid '${raid.name}' is already locked.`;
    }

    res.redirect(actionRedirect(req, raid));
  });

  // POST /raids/:raid_number/post_comp
  router.post(
    '/:raid_number/post_comp',
    express.urlencoded({ extended: false }),
    async (req, res) => {
      if (!(await requireAdmin(req, res))) return;

      const raidNumber = parseInt(req.params.raid_number);
      let compNumber = null;
      try {
        compNumber = req.query.comp ? parseCompNumber(req.query.comp) : null;
      } catch (_) {
        req.session.flash = '❌ Invalid composition number.';
        return res.redirect('/raids');
      }
      const raid = await getRaidByUrlParams(req.session.active_guild_id || null, raidNumber);

      if (raid) {
        const raidId = raid.id;
        // Determine all comp numbers so we know if this is a multi-comp raid
        await ensureCompositionMeta(pool, raidId, 1);
        const [existingCompNums] = await pool.query(
          'SELECT comp_number FROM composition_meta WHERE raid_id = ? ORDER BY comp_number',
          [raidId]
        );
        const allCompNumbers = existingCompNums.map((r) => r.comp_number);
        if (allCompNumbers.length === 0) allCompNumbers.push(1);

        // Post the selected comp (or all comps if no specific one was selected) to Discord
        const compsToPost = compNumber !== null ? [compNumber] : allCompNumbers;

        // Fetch custom comp labels for embed titles
        const compLabels = await fetchCompLabels(raidId);

        // Fetch spec aliases for canonical spec mapping
        const specAliasesMap = await fetchSpecAliases(raid.guild_id);

        // Post the final composition to the main raid channel (not the log thread)
        const discordTargetId = raid.discord_channel_id;

        if (discordTargetId) {
          let allPosted = true;
          for (const cn of compsToPost) {
            const [comps] = await pool.query(
              `SELECT co.slot_role, co.character_id, co.placeholder_text, co.discord_user_id,
                  co.is_sfs_collector, co.is_val_collector,
                  c.char_name, c.char_class, c.spec, c.role, c.discord_user_id AS char_discord_user_id,
                  s.status AS signup_status,
                  du.username AS du_username, du.display_name AS du_display_name
           FROM compositions co
           LEFT JOIN characters c ON co.character_id = c.id
           LEFT JOIN signups s ON s.raid_id = co.raid_id AND s.character_id = co.character_id
           LEFT JOIN discord_users du ON du.discord_user_id = COALESCE(co.discord_user_id, s.discord_user_id, c.discord_user_id)
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
                display_label:
                  comp.du_username &&
                  comp.du_display_name &&
                  comp.du_display_name !== comp.du_username
                    ? `${comp.du_username} – ${comp.du_display_name}`
                    : comp.du_display_name || comp.du_username || null,
                character: comp.character_id
                  ? {
                      char_name: comp.char_name,
                      char_class: comp.char_class,
                      spec: comp.spec,
                      role: comp.role,
                      is_sfs_collector: !!comp.is_sfs_collector,
                      is_val_collector: !!comp.is_val_collector,
                      discord_user_id: comp.char_discord_user_id
                        ? String(comp.char_discord_user_id)
                        : null,
                      status: comp.signup_status,
                    }
                  : null,
              };
              const roleKey = comp.slot_role || 'dps';
              if (groups[roleKey]) groups[roleKey].push(entry);
            }

            const payload = buildCompEmbed(
              raid,
              groups,
              cn,
              allCompNumbers.length,
              compLabels,
              specAliasesMap
            );
            const [[meta]] = await pool.query(
              `SELECT revision, discord_message_id FROM composition_meta
             WHERE raid_id = ? AND comp_number = ?`,
              [raidId, cn]
            );
            let result;
            let messageId =
              meta && meta.discord_message_id ? String(meta.discord_message_id) : null;
            if (messageId) {
              result = await editDiscordMessage(String(discordTargetId), messageId, payload);
              if (isDiscordNotFound(result)) {
                result = await postToDiscordChannel(String(discordTargetId), payload);
                messageId = result.messageId || null;
              }
            } else {
              result = await postToDiscordChannel(String(discordTargetId), payload);
              messageId = result.messageId || null;
            }
            if (!result.ok) {
              allPosted = false;
              console.error(
                `[post_comp] Failed to post comp ${cn} for raid ${raidId}: ${result.reason}`
              );
              console.debug(
                `[post_comp] Debug — target channel id: ${discordTargetId} (channel_id: ${raid.discord_channel_id})`
              );
            } else {
              await pool.query(
                `UPDATE composition_meta
               SET published_revision = revision, published_at = NOW(3), discord_message_id = ?
               WHERE raid_id = ? AND comp_number = ?`,
                [messageId, raidId, cn]
              );
            }
          }
          if (allPosted) {
            req.session.flash = `📋 Composition for '${raid.name}' published to Discord.`;
            if (req.body && req.body.lock_after_post === '1' && raid.status !== 'locked') {
              await pool.query("UPDATE raids SET status = 'locked' WHERE id = ?", [raid.id]);
              raid.status = 'locked';
              if (!(await refreshDiscordPost(raid))) {
                req.session.flash +=
                  ' Sign-ups were locked, but the original Discord post could not be refreshed.';
              } else {
                req.session.flash += ' Sign-ups are now locked.';
              }
            }
          } else {
            req.session.flash = `📋 Composition for '${raid.name}' could not be fully sent to Discord. Check server logs for details.`;
          }
        } else {
          req.session.flash = `📋 Composition posted. (No Discord channel linked — create the raid via bot to enable auto-posting.)`;
        }
      }

      const compParam = compNumber !== null ? `?comp=${compNumber}` : '';
      res.redirect(raid ? `${raidBaseUrl(raid)}/comp${compParam}` : '/raids');
    }
  );

  // POST /raids/:raid_number/unlock
  router.post('/:raid_number/unlock', express.urlencoded({ extended: false }), async (req, res) => {
    if (!(await requireAdmin(req, res))) return;

    const raidNumber = parseInt(req.params.raid_number);
    const raid = await getRaidByUrlParams(req.session.active_guild_id || null, raidNumber);

    if (raid && raid.status === 'locked') {
      await pool.query("UPDATE raids SET status = 'open' WHERE id = ?", [raid.id]);
      req.session.flash = `🟢 Raid '${raid.name}' unlocked and open for sign-ups.`;
      if (!(await refreshDiscordPost(raid))) {
        req.session.flash += ' The Discord post could not be refreshed.';
      }
    } else if (raid) {
      req.session.flash = `ℹ️ Raid '${raid.name}' is already open.`;
    }

    res.redirect(actionRedirect(req, raid));
  });

  // POST /raids/player-note — save/update officer note for a player in a guild
  router.post('/player-note', express.json(), async (req, res) => {
    if (!(await requireAdmin(req, res))) return;

    const guildId = req.session.active_guild_id || null;
    if (!guildId) return res.status(400).json({ ok: false, error: 'No active guild' });

    const { discord_user_id, note } = req.body || {};
    if (!discord_user_id)
      return res.status(400).json({ ok: false, error: 'discord_user_id is required' });

    const trimmedNote = (note || '').trim();

    try {
      if (trimmedNote) {
        await pool.query(
          'INSERT INTO guild_player_notes (guild_id, discord_user_id, note, updated_at) VALUES (?, ?, ?, NOW(3)) ON DUPLICATE KEY UPDATE note = ?, updated_at = NOW(3)',
          [guildId, discord_user_id, trimmedNote, trimmedNote]
        );
      } else {
        await pool.query(
          'DELETE FROM guild_player_notes WHERE guild_id = ? AND discord_user_id = ?',
          [guildId, discord_user_id]
        );
      }
      res.json({ ok: true, note: trimmedNote });
    } catch (err) {
      console.error('[player-note] Failed to save officer note:', err.message);
      res.status(500).json({ ok: false, error: 'Database error' });
    }
  });
}

module.exports = registerCompositionRoutes;
