'use strict';

function registerManagePageRoutes(router, dependencies) {
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
            c.sfs_count, c.val_count, c.discord_role, c.membership_status,
            du.username AS du_username, du.display_name AS du_display_name
     FROM signups s
     JOIN characters c ON s.character_id = c.id
     LEFT JOIN discord_users du ON du.discord_user_id = s.discord_user_id
     WHERE s.raid_id = ? AND c.is_deleted = 0`,
      [raidId]
    );

    const signups = allSignups.map((s) => {
      let label;
      const uid = String(s.discord_user_id);
      if (s.du_username && s.du_display_name && s.du_display_name !== s.du_username) {
        label = `${s.du_username} – ${s.du_display_name}`;
      } else if (s.du_username) {
        label = s.du_username;
      } else {
        label = uid;
      }
      return {
        ...s,
        display_label: label,
        character: {
          id: s.c_id,
          char_name: s.char_name,
          realm: s.realm,
          char_class: s.char_class,
          spec: s.spec,
          gearscore: s.gearscore,
          role: s.role,
          sfs_count: s.sfs_count,
          val_count: s.val_count,
        },
      };
    });

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
        userSignupMap[uid] = {
          discord_user_id: uid,
          display_label: label,
          is_tentative: false,
          guild_role: s.discord_role,
          membership_status: s.membership_status,
          characters: [],
        };
      }

      // Tentative is a user-level flag: true if any of the user's signups is tentative
      if (s.status === 'tentative') {
        userSignupMap[uid].is_tentative = true;
      }

      // Skip specs/characters that are already saved this lockout — they are not
      // available for the raid and would only add clutter to the pool.
      if (s.is_saved) continue;

      // Find or create a character group by char_name
      let charGroup = userSignupMap[uid].characters.find(
        (cg) => cg.char_name === s.character.char_name
      );
      if (!charGroup) {
        charGroup = {
          char_name: s.character.char_name,
          char_class: s.character.char_class,
          discord_user_id: uid,
          note: s.note || '',
          sfs_count: s.character.sfs_count,
          val_count: s.character.val_count,
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
      .filter((s) => s.character && s.character.id)
      .map((s) => s.character.id);
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

    // Fetch officer notes for all signed-up users in this guild
    const officerNotes = {};

    for (const userGroup of signupsByUser) {
      userGroup.officer_note = officerNotes[userGroup.discord_user_id] || '';
    }

    // Sort: players with starred (prio) characters first, tentative players last
    signupsByUser.sort((a, b) => {
      const aPrio = a.characters.some((cg) => cg.specs.some((s) => s.is_prio));
      const bPrio = b.characters.some((cg) => cg.specs.some((s) => s.is_prio));
      if (a.is_tentative !== b.is_tentative) return a.is_tentative ? 1 : -1;
      if (aPrio !== bPrio) return aPrio ? -1 : 1;
      return 0;
    });

    // If some users don't have a persisted guild_role, try to fetch it dynamically (optional optimization)
    const signedUpUserIds = signupsByUser.map((u) => u.discord_user_id);
    const needsRoleFetch = signupsByUser.filter((u) => !u.guild_role).map((u) => u.discord_user_id);

    if (needsRoleFetch.length > 0) {
      const userGuildRoles = await fetchUserGuildRoles(raidGuildId, needsRoleFetch);
      for (const userGroup of signupsByUser) {
        if (!userGroup.guild_role && userGuildRoles[userGroup.discord_user_id]) {
          userGroup.guild_role = userGuildRoles[userGroup.discord_user_id];
        }
      }
    }

    if (signedUpUserIds.length > 0) {
      const [officerNoteRows] = await pool.query(
        'SELECT discord_user_id, note FROM guild_player_notes WHERE guild_id = ? AND discord_user_id IN (?)',
        [raidGuildId, signedUpUserIds]
      );
      for (const row of officerNoteRows) officerNotes[String(row.discord_user_id)] = row.note;
    }

    // Determine which comp numbers already exist for this raid
    const [existingCompNums] = await pool.query(
      'SELECT DISTINCT comp_number FROM compositions WHERE raid_id = ? ORDER BY comp_number',
      [raidId]
    );
    const compNumbers = existingCompNums.map((r) => r.comp_number);
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
            c.char_name, c.char_class, c.spec, c.gearscore, c.sfs_count, c.val_count,
            c.discord_role, c.membership_status,
            du.username AS du_username, du.display_name AS du_display_name
     FROM compositions co
     LEFT JOIN characters c ON c.id = co.character_id
     LEFT JOIN signups s ON s.raid_id = co.raid_id AND s.character_id = co.character_id
     LEFT JOIN discord_users du ON du.discord_user_id = COALESCE(co.discord_user_id, s.discord_user_id, c.discord_user_id)
     WHERE co.raid_id = ? AND co.comp_number = ?`,
      [raidId, currentComp]
    );

    const maxSize = raid.max_size || 25;

    // Build lookup maps keyed by absolute slot key "slot_N"
    const compMap = {};
    const placeholderMap = {};
    const playerPlaceholderMap = {};
    const slotRoleMap = {};
    const compCharacterMap = {};

    const compStatusMap = {};
    for (const c of existingComp) {
      const slotKey = c.role_slot; // "slot_N" format after migration 005
      const role = c.slot_role || 'dps';
      if (c.character_id) {
        compMap[slotKey] = String(c.character_id);
        compStatusMap[slotKey] = c.signup_status;
        compCharacterMap[slotKey] = {
          id: c.character_id,
          char_name: c.char_name,
          char_class: c.char_class,
          spec: c.spec,
          gearscore: c.gearscore,
          sfs_count: c.sfs_count,
          val_count: c.val_count,
          is_sfs_collector: !!c.is_sfs_collector,
          is_val_collector: !!c.is_val_collector,
        };
      } else if (c.discord_user_id) {
        let displayLabel =
          c.du_username && c.du_display_name && c.du_display_name !== c.du_username
            ? `${c.du_username} – ${c.du_display_name}`
            : c.du_display_name || c.du_username || String(c.discord_user_id);
        playerPlaceholderMap[slotKey] = {
          discord_user_id: String(c.discord_user_id),
          display_label: displayLabel,
          status: userSignupMap[String(c.discord_user_id)]?.is_tentative ? 'tentative' : 'signed',
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
    // Also track which characters are marked as collectors.
    // Used by the left-panel to show which characters are already placed and collecting.
    const [allCompAssignments] = await pool.query(
      'SELECT character_id, comp_number, is_sfs_collector, is_val_collector FROM compositions WHERE raid_id = ? AND character_id IS NOT NULL',
      [raidId]
    );
    const charsInComps = {};
    const charCollectors = {}; // cid -> { sfs: [comp_nums], val: [comp_nums] }
    for (const row of allCompAssignments) {
      const cid = String(row.character_id);
      if (!charsInComps[cid]) charsInComps[cid] = [];
      charsInComps[cid].push(row.comp_number);

      if (row.is_sfs_collector || row.is_val_collector) {
        if (!charCollectors[cid]) charCollectors[cid] = { sfs: [], val: [] };
        if (row.is_sfs_collector) charCollectors[cid].sfs.push(row.comp_number);
        if (row.is_val_collector) charCollectors[cid].val.push(row.comp_number);
      }
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
        if (
          compSummaries[cn] &&
          ['tank', 'healer', 'mdps', 'rdps', 'dps'].includes(row.slot_role)
        ) {
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
      comp_character_map: compCharacterMap,
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
      char_collectors: charCollectors,
      emojis: EMOJIS,
      wotlk_buffs: WOTLK_BUFFS,
      flash: popFlash(req),
      user: currentUser(req),
      can_edit: canEdit,
    });
  });
}

module.exports = registerManagePageRoutes;
