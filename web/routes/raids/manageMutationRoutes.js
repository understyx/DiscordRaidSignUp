'use strict';

function registerManageMutationRoutes(router, dependencies) {
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
  // POST /raids/:raid_number/manage (JSON body) — full-state save used by manual "Save & Reload"
  router.post('/:raid_number/manage', express.json(), async (req, res) => {
    if (!(await requireAdmin(req, res))) return;

    const raidNumber = parseInt(req.params.raid_number);
    const raid = await getRaidByUrlParams(req.session.active_guild_id || null, raidNumber);
    if (!raid) return res.status(404).json({ ok: false, error: 'Raid not found' });

    const raidId = raid.id;
    const userId = req.session.user_id;
    const compNumber = parseInt(req.query.comp) || 1;
    const body = req.body;

    if (!Array.isArray(body)) {
      return res.json({
        ok: false,
        error: 'Body must be a list of {character_id?, placeholder_text?, role_slot} entries.',
      });
    }

    for (const entry of body) {
      if (typeof entry !== 'object' || !('role_slot' in entry)) {
        return res.json({ ok: false, error: 'Each entry must have a role_slot field.' });
      }
      const hasChar =
        'character_id' in entry && entry.character_id !== null && entry.character_id !== '';
      const hasPlayer = 'discord_user_id' in entry && entry.discord_user_id;
      const hasPlaceholder = 'placeholder_text' in entry && entry.placeholder_text;
      if (!hasChar && !hasPlayer && !hasPlaceholder) {
        return res.json({
          ok: false,
          error: 'Each entry must have character_id, discord_user_id, or placeholder_text.',
        });
      }
      if (hasChar && isNaN(parseInt(entry.character_id))) {
        return res.json({ ok: false, error: `Invalid character_id: ${entry.character_id}` });
      }
    }

    // Separate character entries, player entries, and placeholder entries
    const charEntries = body.filter(
      (e) => e.character_id !== null && e.character_id !== undefined && e.character_id !== ''
    );
    const playerEntries = body.filter((e) => !e.character_id && e.discord_user_id);
    const placeholderEntries = body.filter(
      (e) => !e.character_id && !e.discord_user_id && e.placeholder_text
    );

    if (charEntries.length > 0) {
      // Validate: each Discord user may only appear once in the composition,
      // and all characters must belong to the active guild.
      const charIds = charEntries.map((e) => parseInt(e.character_id));
      const placeholders = charIds.map(() => '?').join(', ');
      const [chars] = await pool.query(
        `SELECT id, discord_user_id FROM characters WHERE id IN (${placeholders}) AND guild_id = ? AND is_deleted = 0`,
        [...charIds, raid.guild_id]
      );
      const seenUsers = new Set();
      for (const char of chars) {
        const uid = String(char.discord_user_id);
        if (seenUsers.has(uid)) {
          return res.json({
            ok: false,
            error:
              'Each Discord user can only have one character in the raid composition. Please remove duplicate assignments.',
          });
        }
        seenUsers.add(uid);
      }
    }

    await pool.query('DELETE FROM compositions WHERE raid_id = ? AND comp_number = ?', [
      raidId,
      compNumber,
    ]);

    const validRoles = ['tank', 'healer', 'dps', 'mdps', 'rdps'];

    for (const entry of charEntries) {
      const slotRole = validRoles.includes(entry.slot_role) ? entry.slot_role : 'dps';
      await pool.query(
        'INSERT INTO compositions (raid_id, character_id, placeholder_text, discord_user_id, role_slot, slot_role, comp_number, is_sfs_collector, is_val_collector, created_by, created_at, updated_at) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3))',
        [
          raidId,
          parseInt(entry.character_id),
          entry.role_slot,
          slotRole,
          compNumber,
          !!entry.is_sfs_collector,
          !!entry.is_val_collector,
          userId,
        ]
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
    if (!(await resolveIsAdmin(req.session.user_id, patchGuildId)))
      return res.status(403).json({ ok: false, error: 'Forbidden' });

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
            c.char_name, c.char_class, c.spec, c.gearscore, c.discord_user_id AS char_discord_user_id,
              s.status AS signup_status,
            du.username AS du_username, du.display_name AS du_display_name
       FROM compositions co
       LEFT JOIN characters c ON co.character_id = c.id
       LEFT JOIN signups s ON s.raid_id = co.raid_id AND s.character_id = co.character_id
       LEFT JOIN discord_users du ON du.discord_user_id = COALESCE(co.discord_user_id, s.discord_user_id, c.discord_user_id)
       WHERE co.raid_id = ? AND co.comp_number = ?
       ORDER BY co.role_slot`,
        [raidId, compNumber]
      );
      const emptyEntries = emptyRows.map((r) => ({
        role_slot: r.role_slot,
        slot_role: r.slot_role || 'dps',
        character_id: r.character_id ? String(r.character_id) : null,
        placeholder_text: r.placeholder_text || null,
        char_name: r.char_name || null,
        char_class: r.char_class ? r.char_class.toLowerCase().replace(/ /g, '-') : null,
        spec: r.spec || null,
        gearscore: r.gearscore || 0,
        discord_user_id: r.char_discord_user_id ? String(r.char_discord_user_id) : null,
        display_label:
          r.du_username && r.du_display_name && r.du_display_name !== r.du_username
            ? `${r.du_username} – ${r.du_display_name}`
            : r.du_display_name || r.du_username || null,
        status: r.signup_status || null,
      }));
      return res.json({ ok: true, saved: [], entries: emptyEntries });
    }

    // Basic validation
    for (const entry of body) {
      if (typeof entry !== 'object' || !entry.role_slot) {
        return res.json({ ok: false, error: 'Each entry must have a role_slot field.' });
      }
      const hasChar =
        entry.character_id !== null &&
        entry.character_id !== undefined &&
        entry.character_id !== '';
      const hasPlayer = !!entry.discord_user_id;
      const hasPlaceholder = !!entry.placeholder_text;
      const isClear = entry.clear === true;
      if (!hasChar && !hasPlayer && !hasPlaceholder && !isClear) {
        return res.json({
          ok: false,
          error: `Entry for ${entry.role_slot} must have character_id, discord_user_id, placeholder_text, or clear:true.`,
        });
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
      const charId =
        entry.character_id !== null && entry.character_id !== undefined && entry.character_id !== ''
          ? parseInt(entry.character_id)
          : null;
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
          `INSERT INTO compositions (raid_id, character_id, placeholder_text, discord_user_id, role_slot, slot_role, comp_number, is_sfs_collector, is_val_collector, created_by, created_at, updated_at)
         VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3))
         ON DUPLICATE KEY UPDATE
           character_id    = VALUES(character_id),
           placeholder_text = NULL,
           discord_user_id  = NULL,
           slot_role       = VALUES(slot_role),
           is_sfs_collector = VALUES(is_sfs_collector),
           is_val_collector = VALUES(is_val_collector),
           created_by      = VALUES(created_by),
           updated_at      = NOW(3)`,
          [
            raidId,
            charId,
            role_slot,
            slotRole,
            compNumber,
            !!entry.is_sfs_collector,
            !!entry.is_val_collector,
            userId,
          ]
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
            co.is_sfs_collector, co.is_val_collector,
            c.char_name, c.char_class, c.spec, c.gearscore, c.sfs_count, c.val_count, c.discord_user_id AS char_discord_user_id,
            s.status AS signup_status,
            du.username AS du_username, du.display_name AS du_display_name
     FROM compositions co
     LEFT JOIN characters c ON co.character_id = c.id
     LEFT JOIN signups s ON s.raid_id = co.raid_id AND s.character_id = co.character_id
     LEFT JOIN discord_users du ON du.discord_user_id = COALESCE(co.discord_user_id, s.discord_user_id, c.discord_user_id)
     WHERE co.raid_id = ? AND co.comp_number = ?
     ORDER BY co.role_slot`,
      [raidId, compNumber]
    );

    const entries = rows.map((r) => ({
      role_slot: r.role_slot,
      slot_role: r.slot_role || 'dps',
      character_id: r.character_id ? String(r.character_id) : null,
      placeholder_text: r.placeholder_text || null,
      discord_user_id: r.discord_user_id
        ? String(r.discord_user_id)
        : r.char_discord_user_id
          ? String(r.char_discord_user_id)
          : null,
      display_label:
        r.du_username && r.du_display_name && r.du_display_name !== r.du_username
          ? `${r.du_username} – ${r.du_display_name}`
          : r.du_display_name || r.du_username || null,
      char_name: r.char_name || null,
      char_class: r.char_class ? r.char_class.toLowerCase().replace(/ /g, '-') : null,
      spec: r.spec || null,
      gearscore: r.gearscore || 0,
      sfs_count: r.sfs_count,
      val_count: r.val_count,
      is_sfs_collector: !!r.is_sfs_collector,
      is_val_collector: !!r.is_val_collector,
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
            co.is_sfs_collector, co.is_val_collector,
            MAX(co.updated_at) OVER () AS max_updated_at,
            c.char_name, c.char_class, c.spec, c.gearscore, c.sfs_count, c.val_count, c.discord_user_id AS char_discord_user_id,
            s.status AS signup_status,
            du.username AS du_username, du.display_name AS du_display_name
     FROM compositions co
     LEFT JOIN characters c ON co.character_id = c.id
     LEFT JOIN signups s ON s.raid_id = co.raid_id AND s.character_id = co.character_id
     LEFT JOIN discord_users du ON du.discord_user_id = COALESCE(co.discord_user_id, s.discord_user_id, c.discord_user_id)
     WHERE co.raid_id = ? AND co.comp_number = ?
     ORDER BY co.role_slot`,
      [raidId, compNumber]
    );

    // Version = ISO string of most recent updated_at across all slots
    const version =
      rows.length > 0 && rows[0].max_updated_at
        ? rows[0].max_updated_at instanceof Date
          ? rows[0].max_updated_at.toISOString()
          : String(rows[0].max_updated_at)
        : '';

    const entries = rows.map((r) => ({
      role_slot: r.role_slot,
      slot_role: r.slot_role || 'dps',
      character_id: r.character_id ? String(r.character_id) : null,
      placeholder_text: r.placeholder_text || null,
      discord_user_id: r.discord_user_id
        ? String(r.discord_user_id)
        : r.char_discord_user_id
          ? String(r.char_discord_user_id)
          : null,
      display_label:
        r.du_username && r.du_display_name && r.du_display_name !== r.du_username
          ? `${r.du_username} – ${r.du_display_name}`
          : r.du_display_name || r.du_username || null,
      char_name: r.char_name || null,
      char_class: r.char_class ? r.char_class.toLowerCase().replace(/ /g, '-') : null,
      spec: r.spec || null,
      gearscore: r.gearscore || 0,
      sfs_count: r.sfs_count,
      val_count: r.val_count,
      is_sfs_collector: !!r.is_sfs_collector,
      is_val_collector: !!r.is_val_collector,
      status: r.signup_status || null,
    }));

    res.json({ ok: true, version: version || '', entries });
  });

  // GET /raids/:raid_number/comp_preview — returns full composition data for Discord embed preview
  router.get('/:raid_number/comp_preview', async (req, res) => {
    if (!req.session.user_id) return res.status(401).json({ ok: false });
    const previewGuildId = req.session.active_guild_id || null;
    if (!(await resolveIsAdmin(req.session.user_id, previewGuildId)))
      return res.status(403).json({ ok: false, error: 'Forbidden' });

    const raidNumber = parseInt(req.params.raid_number);
    const raid = await getRaidByUrlParams(previewGuildId, raidNumber);
    if (!raid) return res.status(404).json({ ok: false, error: 'Raid not found' });

    const raidId = raid.id;

    const [existingCompNums] = await pool.query(
      'SELECT DISTINCT comp_number FROM compositions WHERE raid_id = ? ORDER BY comp_number',
      [raidId]
    );
    const allCompNumbers = existingCompNums.map((r) => r.comp_number);
    if (allCompNumbers.length === 0) allCompNumbers.push(1);

    const compLabels = await fetchCompLabels(raidId);

    const compsResult = {};
    for (const cn of allCompNumbers) {
      const [rows] = await pool.query(
        `SELECT co.slot_role, co.character_id, co.placeholder_text, co.discord_user_id,
              c.char_name, c.char_class, c.spec, c.discord_user_id AS char_discord_user_id,
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
      for (const comp of rows) {
        const entry = {
          slot_role: comp.slot_role || 'dps',
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
                char_name: comp.char_name,
                char_class: comp.char_class,
                spec: comp.spec,
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

      compsResult[cn] = { label: compTabLabel(cn, compLabels), groups };
    }

    res.json({ ok: true, allCompNumbers, comps: compsResult });
  });

  // PUT /raids/:raid_number/comp_label — set or clear a custom label for a comp tab
  router.put('/:raid_number/comp_label', express.json(), async (req, res) => {
    if (!req.session.user_id) return res.status(401).json({ ok: false });
    const putGuildId = req.session.active_guild_id || null;
    if (!(await resolveIsAdmin(req.session.user_id, putGuildId)))
      return res.status(403).json({ ok: false, error: 'Forbidden' });

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
      await pool.query('DELETE FROM comp_labels WHERE raid_id = ? AND comp_number = ?', [
        raidId,
        comp_number,
      ]);
    }

    res.json({ ok: true, label: trimmed || null });
  });
}

module.exports = registerManageMutationRoutes;
