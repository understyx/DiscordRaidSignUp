'use strict';

const {
  CompositionValidationError,
  applyCompositionChanges,
  bumpCompositionRevision,
  ensureCompositionMeta,
  fetchCompositionRows,
  lockCompositionMeta,
  mergeCompositionChanges,
  normalizeEntry,
  parseCompNumber,
  replaceCompositionRows,
  serializeCompositionRows,
  validateCompositionEntries,
} = require('../../services/compositionWorkflow');

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
    deleteDiscordMessage,
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
  async function currentState(db, raidId, compNumber) {
    let [metaRows] = await db.query(
      `SELECT revision, published_revision, published_at, discord_message_id
       FROM composition_meta WHERE raid_id = ? AND comp_number = ?`,
      [raidId, compNumber]
    );
    if (metaRows.length === 0) {
      await ensureCompositionMeta(db, raidId, compNumber);
      [metaRows] = await db.query(
        `SELECT revision, published_revision, published_at, discord_message_id
         FROM composition_meta WHERE raid_id = ? AND comp_number = ?`,
        [raidId, compNumber]
      );
    }
    const meta = metaRows[0];
    const rows = await fetchCompositionRows(db, raidId, compNumber);
    return {
      revision: Number(meta.revision),
      published_revision: meta.published_revision === null ? null : Number(meta.published_revision),
      published_at: meta.published_at || null,
      entries: serializeCompositionRows(rows),
    };
  }

  function sendMutationError(res, error) {
    const status = error instanceof CompositionValidationError ? error.status : 500;
    if (!(error instanceof CompositionValidationError)) {
      console.error('[composition] Mutation failed:', error.message || error);
    }
    return res.status(status).json({
      ok: false,
      error:
        error instanceof CompositionValidationError ? error.message : 'Unable to save composition.',
    });
  }

  // POST /raids/:raid_number/manage — transactional full-state save fallback.
  router.post('/:raid_number/manage', express.json(), async (req, res) => {
    if (!(await requireAdmin(req, res))) return;

    const raidNumber = parseInt(req.params.raid_number);
    const raid = await getRaidByUrlParams(req.session.active_guild_id || null, raidNumber);
    if (!raid) return res.status(404).json({ ok: false, error: 'Raid not found' });

    let compNumber;
    try {
      compNumber = parseCompNumber(req.query.comp);
    } catch (error) {
      return sendMutationError(res, error);
    }
    const body = Array.isArray(req.body) ? { entries: req.body } : req.body || {};
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const meta = await lockCompositionMeta(connection, raid.id, compNumber);
      if (
        body.base_revision !== null &&
        body.base_revision !== undefined &&
        Number(body.base_revision) !== Number(meta.revision)
      ) {
        await connection.rollback();
        const state = await currentState(pool, raid.id, compNumber);
        return res.status(409).json({ ok: false, conflict: true, ...state });
      }
      const entries = await validateCompositionEntries(connection, raid, body.entries, {
        dropIneligible: true,
      });
      await replaceCompositionRows(connection, raid.id, compNumber, req.session.user_id, entries);
      const revision = await bumpCompositionRevision(connection, raid.id, compNumber);
      await connection.commit();
      const rows = await fetchCompositionRows(pool, raid.id, compNumber);
      return res.json({ ok: true, revision, entries: serializeCompositionRows(rows) });
    } catch (error) {
      await connection.rollback();
      return sendMutationError(res, error);
    } finally {
      connection.release();
    }
  });

  // PATCH /raids/:raid_number/manage — granular per-slot auto-save (last-write-wins per slot)
  // Body: array of { role_slot, slot_role?, character_id? | placeholder_text? | clear: true }
  // Only the slots present in the payload are touched; all other slots are left as-is.
  router.patch('/:raid_number/manage', express.json(), async (req, res) => {
    if (!req.session.user_id) return res.status(401).json({ ok: false });
    const patchGuildId = req.session.active_guild_id || null;
    const raidNumber = parseInt(req.params.raid_number);
    const raid = await getRaidByUrlParams(patchGuildId, raidNumber);
    if (!raid) return res.status(404).json({ ok: false, error: 'Raid not found' });
    const raidGuildId = raid.guild_id ? String(raid.guild_id) : null;
    if (!(await resolveIsAdmin(req.session.user_id, raidGuildId))) {
      console.warn(
        '[composition] Autosave forbidden for user %s, guild %s, raid %s.',
        req.session.user_id,
        raidGuildId || 'legacy',
        raid.id
      );
      return res.status(403).json({
        ok: false,
        error: 'Officer permission could not be confirmed for this raid. Refresh and try again.',
      });
    }

    let compNumber;
    try {
      compNumber = parseCompNumber(req.query.comp);
    } catch (error) {
      return sendMutationError(res, error);
    }
    const requestBody = Array.isArray(req.body) ? { changes: req.body } : req.body || {};
    const changesBody = requestBody.changes;
    if (!Array.isArray(changesBody) || changesBody.length === 0) {
      const state = await currentState(pool, raid.id, compNumber);
      return res.json({ ok: true, saved: [], ...state });
    }

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const meta = await lockCompositionMeta(connection, raid.id, compNumber);
      if (
        requestBody.base_revision !== null &&
        requestBody.base_revision !== undefined &&
        Number(requestBody.base_revision) !== Number(meta.revision)
      ) {
        await connection.rollback();
        const state = await currentState(pool, raid.id, compNumber);
        return res.status(409).json({ ok: false, conflict: true, ...state });
      }

      const maxSize = Number(raid.max_size) || 25;
      const normalizedChanges = changesBody.map((entry) =>
        normalizeEntry(entry, maxSize, { allowClear: true })
      );
      const currentRows = await fetchCompositionRows(connection, raid.id, compNumber);
      const finalEntries = mergeCompositionChanges(currentRows, normalizedChanges);
      const eligibleFinalEntries = await validateCompositionEntries(
        connection,
        raid,
        finalEntries,
        { dropIneligible: true }
      );
      const eligibleSlots = new Set(eligibleFinalEntries.map((entry) => entry.role_slot));
      const dropped = finalEntries
        .filter((entry) => !eligibleSlots.has(entry.role_slot))
        .map((entry) => entry.role_slot);
      if (dropped.length > 0) {
        const droppedEntries = finalEntries
          .filter((entry) => dropped.includes(entry.role_slot))
          .map((entry) => ({
            role_slot: entry.role_slot,
            character_id: entry.character_id || null,
            discord_user_id: entry.discord_user_id || null,
          }));
        console.info(
          '[composition] Removing assignments without an eligible signup from raid %s comp %s: %s',
          raid.id,
          compNumber,
          JSON.stringify(droppedEntries)
        );
      }
      const changesBySlot = new Map(normalizedChanges.map((entry) => [entry.role_slot, entry]));
      for (const roleSlot of dropped) {
        changesBySlot.set(roleSlot, { role_slot: roleSlot, clear: true });
      }
      const appliedChanges = [...changesBySlot.values()];
      await applyCompositionChanges(
        connection,
        raid.id,
        compNumber,
        req.session.user_id,
        appliedChanges
      );
      const revision = await bumpCompositionRevision(connection, raid.id, compNumber);
      await connection.commit();

      const rows = await fetchCompositionRows(pool, raid.id, compNumber);
      return res.json({
        ok: true,
        revision,
        saved: appliedChanges.map((entry) => ({
          role_slot: entry.role_slot,
          cleared: entry.clear,
        })),
        dropped,
        entries: serializeCompositionRows(rows),
      });
    } catch (error) {
      await connection.rollback();
      return sendMutationError(res, error);
    } finally {
      connection.release();
    }
  });

  // GET /raids/:raid_number/manage/json  — polling endpoint for collaborative auto-load
  router.get('/:raid_number/manage/json', async (req, res) => {
    if (!req.session.user_id) return res.status(401).json({ ok: false });

    const raidNumber = parseInt(req.params.raid_number);
    const raid = await getRaidByUrlParams(req.session.active_guild_id || null, raidNumber);
    if (!raid) return res.status(404).json({ ok: false, error: 'Raid not found' });

    try {
      const compNumber = parseCompNumber(req.query.comp);
      const state = await currentState(pool, raid.id, compNumber);
      res.json({ ok: true, ...state });
    } catch (error) {
      sendMutationError(res, error);
    }
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

    await ensureCompositionMeta(pool, raidId, 1);
    const [existingCompNums] = await pool.query(
      'SELECT comp_number FROM composition_meta WHERE raid_id = ? ORDER BY comp_number',
      [raidId]
    );
    const allCompNumbers = existingCompNums.map((r) => r.comp_number);
    if (allCompNumbers.length === 0) allCompNumbers.push(1);

    const compLabels = await fetchCompLabels(raidId);

    const compsResult = {};
    for (const cn of allCompNumbers) {
      const rows = await fetchCompositionRows(pool, raidId, cn);

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
                membership_status: comp.membership_status,
                is_saved: Boolean(comp.is_saved),
                is_sfs_collector: Boolean(comp.is_sfs_collector),
                is_val_collector: Boolean(comp.is_val_collector),
              }
            : null,
        };
        const roleKey = comp.slot_role || 'dps';
        if (groups[roleKey]) groups[roleKey].push(entry);
      }

      const warnings = [];
      const tentativeCount = rows.filter((row) => row.signup_status === 'tentative').length;
      const unavailableCount = rows.filter(
        (row) => row.is_saved || (row.membership_status && row.membership_status !== 'active')
      ).length;
      const placeholderCount = rows.filter(
        (row) => !row.character_id && !row.discord_user_id
      ).length;
      const anyCharacterCount = rows.filter(
        (row) => !row.character_id && row.discord_user_id
      ).length;
      if (rows.length < (Number(raid.max_size) || 25)) {
        warnings.push({
          level: 'warning',
          message: `${rows.length}/${Number(raid.max_size) || 25} roster slots are filled.`,
        });
      }
      if (tentativeCount) {
        warnings.push({ level: 'warning', message: `${tentativeCount} tentative player(s).` });
      }
      if (unavailableCount) {
        warnings.push({
          level: 'danger',
          message: `${unavailableCount} assigned character(s) are saved or inactive.`,
        });
      }
      if (placeholderCount) {
        warnings.push({ level: 'info', message: `${placeholderCount} placeholder slot(s).` });
      }
      if (anyCharacterCount) {
        warnings.push({
          level: 'info',
          message: `${anyCharacterCount} player(s) still need a character selected.`,
        });
      }
      const [[meta]] = await pool.query(
        `SELECT revision, published_revision, published_at
         FROM composition_meta WHERE raid_id = ? AND comp_number = ?`,
        [raidId, cn]
      );
      compsResult[cn] = {
        label: compTabLabel(cn, compLabels),
        groups,
        warnings,
        filled: rows.length,
        max_size: Number(raid.max_size) || 25,
        revision: Number(meta.revision),
        published_revision:
          meta.published_revision === null ? null : Number(meta.published_revision),
        published_at: meta.published_at || null,
      };
    }

    res.json({ ok: true, allCompNumbers, comps: compsResult });
  });

  // POST /raids/:raid_number/comps — persist a new blank comp or duplicate one.
  router.post('/:raid_number/comps', express.json(), async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const raidNumber = Number.parseInt(req.params.raid_number, 10);
    const raid = await getRaidByUrlParams(req.session.active_guild_id || null, raidNumber);
    if (!raid) return res.status(404).json({ ok: false, error: 'Raid not found' });

    const action = req.body && req.body.action === 'duplicate' ? 'duplicate' : 'create';
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query('SELECT id FROM raids WHERE id = ? FOR UPDATE', [raid.id]);
      await ensureCompositionMeta(connection, raid.id, 1);
      const [[nextRow]] = await connection.query(
        'SELECT COALESCE(MAX(comp_number), 0) + 1 AS next_comp FROM composition_meta WHERE raid_id = ? FOR UPDATE',
        [raid.id]
      );
      const nextComp = parseCompNumber(nextRow.next_comp);
      let sourceComp = null;
      if (action === 'duplicate') {
        sourceComp = parseCompNumber(req.body.source_comp);
        const [[sourceMeta]] = await connection.query(
          'SELECT revision FROM composition_meta WHERE raid_id = ? AND comp_number = ? FOR UPDATE',
          [raid.id, sourceComp]
        );
        if (!sourceMeta) {
          throw new CompositionValidationError('The source composition no longer exists.', 404);
        }
      }

      await connection.query(
        'INSERT INTO composition_meta (raid_id, comp_number, revision) VALUES (?, ?, ?)',
        [raid.id, nextComp, action === 'duplicate' ? 1 : 0]
      );
      if (action === 'duplicate') {
        await connection.query(
          `INSERT INTO compositions
            (raid_id, character_id, placeholder_text, discord_user_id, role_slot, slot_role,
             comp_number, is_sfs_collector, is_val_collector, created_by, created_at, updated_at)
           SELECT raid_id, character_id, placeholder_text, discord_user_id, role_slot, slot_role,
                  ?, is_sfs_collector, is_val_collector, ?, NOW(3), NOW(3)
           FROM compositions WHERE raid_id = ? AND comp_number = ?`,
          [nextComp, req.session.user_id, raid.id, sourceComp]
        );
        const [[sourceLabel]] = await connection.query(
          'SELECT label FROM comp_labels WHERE raid_id = ? AND comp_number = ?',
          [raid.id, sourceComp]
        );
        if (sourceLabel) {
          await connection.query(
            'INSERT INTO comp_labels (raid_id, comp_number, label) VALUES (?, ?, ?)',
            [raid.id, nextComp, `${sourceLabel.label} Copy`.slice(0, 100)]
          );
        }
      }
      await connection.commit();
      res.json({ ok: true, comp_number: nextComp });
    } catch (error) {
      await connection.rollback();
      sendMutationError(res, error);
    } finally {
      connection.release();
    }
  });

  // DELETE /raids/:raid_number/comps/:comp_number — remove a comp and its publish history.
  router.delete('/:raid_number/comps/:comp_number', async (req, res) => {
    if (!(await requireAdmin(req, res))) return;
    const raidNumber = Number.parseInt(req.params.raid_number, 10);
    const raid = await getRaidByUrlParams(req.session.active_guild_id || null, raidNumber);
    if (!raid) return res.status(404).json({ ok: false, error: 'Raid not found' });

    let compNumber;
    try {
      compNumber = parseCompNumber(req.params.comp_number);
    } catch (error) {
      return sendMutationError(res, error);
    }
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query('SELECT id FROM raids WHERE id = ? FOR UPDATE', [raid.id]);
      const [[countRow]] = await connection.query(
        'SELECT COUNT(*) AS count FROM composition_meta WHERE raid_id = ? FOR UPDATE',
        [raid.id]
      );
      if (Number(countRow.count) <= 1) {
        throw new CompositionValidationError('A raid must keep at least one composition.');
      }
      const [[deletedMeta]] = await connection.query(
        `SELECT discord_message_id FROM composition_meta
         WHERE raid_id = ? AND comp_number = ?`,
        [raid.id, compNumber]
      );
      await connection.query('DELETE FROM compositions WHERE raid_id = ? AND comp_number = ?', [
        raid.id,
        compNumber,
      ]);
      await connection.query('DELETE FROM comp_labels WHERE raid_id = ? AND comp_number = ?', [
        raid.id,
        compNumber,
      ]);
      const [result] = await connection.query(
        'DELETE FROM composition_meta WHERE raid_id = ? AND comp_number = ?',
        [raid.id, compNumber]
      );
      if (!result.affectedRows) {
        throw new CompositionValidationError('Composition not found.', 404);
      }
      const [[fallback]] = await connection.query(
        'SELECT MIN(comp_number) AS comp_number FROM composition_meta WHERE raid_id = ?',
        [raid.id]
      );
      await connection.commit();
      let warning = null;
      if (deletedMeta?.discord_message_id && raid.discord_channel_id) {
        const discordResult = await deleteDiscordMessage(
          String(raid.discord_channel_id),
          String(deletedMeta.discord_message_id)
        );
        if (!discordResult.ok) {
          warning =
            'The composition was deleted, but its old Discord message could not be removed.';
        }
      }
      res.json({ ok: true, next_comp: Number(fallback.comp_number), warning });
    } catch (error) {
      await connection.rollback();
      sendMutationError(res, error);
    } finally {
      connection.release();
    }
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

    let parsedComp;
    try {
      parsedComp = parseCompNumber(comp_number);
    } catch (error) {
      return sendMutationError(res, error);
    }
    const trimmed = label.trim().slice(0, 100);
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await lockCompositionMeta(connection, raidId, parsedComp);
      if (trimmed) {
        await connection.query(
          'INSERT INTO comp_labels (raid_id, comp_number, label) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE label = ?',
          [raidId, parsedComp, trimmed, trimmed]
        );
      } else {
        await connection.query('DELETE FROM comp_labels WHERE raid_id = ? AND comp_number = ?', [
          raidId,
          parsedComp,
        ]);
      }
      const revision = await bumpCompositionRevision(connection, raidId, parsedComp);
      await connection.commit();
      res.json({ ok: true, label: trimmed || null, revision });
    } catch (error) {
      await connection.rollback();
      sendMutationError(res, error);
    } finally {
      connection.release();
    }
  });
}

module.exports = registerManageMutationRoutes;
