'use strict';

const { ensureCompositionMeta, parseCompNumber } = require('../../services/compositionWorkflow');
const { DEFAULT_WEEKLY_RESET, getWeeklyResetWindow } = require('../../services/weeklyReset');

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
        is_saved: Boolean(s.is_saved),
      });
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
        charGroup.specs.sort((a, b) => Number(a.is_saved) - Number(b.is_saved));
        charGroup.saved_instances = [...instanceSet].sort();
        charGroup.is_unavailable = charGroup.specs.every((spec) => spec.is_saved);
        charGroup.reset_conflicts = [];
      }
      userGroup.is_unavailable = userGroup.characters.every(
        (character) => character.is_unavailable
      );
    }

    // Show when the same named character is already placed in another raid during
    // this guild's weekly reset window. Match by owner + character name so an
    // alternate spec row for the same character is still detected.
    let weeklyResetSettings = DEFAULT_WEEKLY_RESET;
    if (raidGuildId) {
      const [[resetRow]] = await pool.query(
        `SELECT weekly_reset_weekday, weekly_reset_time, weekly_reset_timezone
         FROM guild_settings WHERE guild_id = ?`,
        [raidGuildId]
      );
      if (resetRow) {
        weeklyResetSettings = {
          weekday: resetRow.weekly_reset_weekday,
          time: resetRow.weekly_reset_time,
          timezone: resetRow.weekly_reset_timezone,
        };
      }
    }

    const resetWindow = getWeeklyResetWindow(raid.date, weeklyResetSettings);
    if (signups.length > 0) {
      const [conflictRows] = await pool.query(
        `SELECT DISTINCT placed.discord_user_id, placed.char_name,
                other_raid.id AS raid_id, other_raid.name AS raid_name,
                other_raid.date AS raid_date,
                other_raid.guild_raid_number, co.comp_number, cl.label AS comp_label
         FROM compositions co
         JOIN characters placed ON placed.id = co.character_id
         JOIN raids other_raid ON other_raid.id = co.raid_id
         JOIN signups current_signup ON current_signup.raid_id = ?
         JOIN characters current_character
           ON current_character.id = current_signup.character_id
          AND current_character.discord_user_id = placed.discord_user_id
          AND current_character.char_name = placed.char_name
         LEFT JOIN comp_labels cl
           ON cl.raid_id = co.raid_id AND cl.comp_number = co.comp_number
         WHERE other_raid.guild_id <=> ?
           AND other_raid.id <> ?
           AND other_raid.date >= ?
           AND other_raid.date < ?
         ORDER BY other_raid.date, other_raid.id, co.comp_number`,
        [raidId, raidGuildId, raidId, resetWindow.start, resetWindow.end]
      );

      const conflictsByCharacter = new Map();
      for (const row of conflictRows) {
        const key = `${String(row.discord_user_id)}\0${String(row.char_name).toLocaleLowerCase()}`;
        if (!conflictsByCharacter.has(key)) conflictsByCharacter.set(key, []);
        conflictsByCharacter.get(key).push({
          raid_name: row.raid_name,
          raid_date: row.raid_date,
          guild_raid_number: row.guild_raid_number,
          comp_number: row.comp_number,
          comp_label: row.comp_label || `Raid ${row.comp_number}`,
        });
      }

      for (const userGroup of signupsByUser) {
        for (const charGroup of userGroup.characters) {
          const key = `${userGroup.discord_user_id}\0${charGroup.char_name.toLocaleLowerCase()}`;
          charGroup.reset_conflicts = conflictsByCharacter.get(key) || [];
        }
      }
    }

    // Fetch officer notes for all signed-up users in this guild
    const officerNotes = {};

    // Sort: players with starred (prio) characters first, tentative players last
    signupsByUser.sort((a, b) => {
      const aPrio = a.characters.some((cg) => cg.specs.some((s) => s.is_prio));
      const bPrio = b.characters.some((cg) => cg.specs.some((s) => s.is_prio));
      if (a.is_unavailable !== b.is_unavailable) return a.is_unavailable ? 1 : -1;
      if (a.is_tentative !== b.is_tentative) return a.is_tentative ? 1 : -1;
      if (aPrio !== bPrio) return aPrio ? -1 : 1;
      return a.display_label.localeCompare(b.display_label);
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
    for (const userGroup of signupsByUser) {
      userGroup.officer_note = officerNotes[userGroup.discord_user_id] || '';
    }

    // Determine which comp numbers already exist for this raid
    await ensureCompositionMeta(pool, raidId, 1);
    const [existingCompNums] = await pool.query(
      'SELECT comp_number FROM composition_meta WHERE raid_id = ? ORDER BY comp_number',
      [raidId]
    );
    const compNumbers = existingCompNums.map((r) => r.comp_number);
    if (compNumbers.length === 0) compNumbers.push(1);

    // Determine active comp from query param (default: 1)
    let currentComp;
    try {
      currentComp = parseCompNumber(req.query.comp);
    } catch (_) {
      currentComp = compNumbers[0] || 1;
    }

    if (!compNumbers.includes(currentComp)) {
      currentComp = compNumbers[0];
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

    const [compMetaRows] = await pool.query(
      `SELECT comp_number, revision, published_revision, published_at
       FROM composition_meta WHERE raid_id = ? ORDER BY comp_number`,
      [raidId]
    );
    const compMeta = {};
    for (const row of compMetaRows) {
      compMeta[row.comp_number] = {
        revision: Number(row.revision),
        published_revision: row.published_revision === null ? null : Number(row.published_revision),
        published_at: row.published_at || null,
      };
    }

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

    const currentMeta = compMeta[currentComp] || {
      revision: 0,
      published_revision: null,
      published_at: null,
    };
    const rosterConfig = {
      CAN_EDIT: canEdit,
      CURRENT_COMP: currentComp,
      RAID_URL: raidBaseUrl(raid),
      COMP_NUMBERS_ALL: compNumbers,
      COMP_SUMMARIES: compSummaries,
      COMP_LABELS: compLabels,
      COMP_META: compMeta,
      CURRENT_REVISION: currentMeta.revision,
      PUBLISHED_REVISION: currentMeta.published_revision,
      MAX_SIZE: maxSize,
      CHARS_IN_COMPS: charsInComps,
      CHAR_COLLECTORS: charCollectors,
      WOTLK_RAID_BUFFS: WOTLK_BUFFS,
      EMOJIS,
      RAID: raid,
    };

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
      comp_meta: compMeta,
      current_meta: currentMeta,
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
      available_player_count: signupsByUser.filter((group) => !group.is_unavailable).length,
      roster_config: rosterConfig,
    });
  });
}

module.exports = registerManagePageRoutes;
