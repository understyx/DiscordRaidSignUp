'use strict';

function registerPresetRoutes(router, dependencies) {
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

  // GET /raids/presets — list placeholder presets for the active guild
  router.get('/presets', async (req, res) => {
    if (!req.session.user_id) return res.status(401).json({ ok: false });
    const guildId = req.session.active_guild_id || null;
    const guildIdParam = guildId === '0' || guildId === 'null' || !guildId ? null : guildId;

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

    const presets = rows.map((r) => ({
      id: r.id,
      name: r.name,
      slots: typeof r.slots === 'string' ? JSON.parse(r.slots) : r.slots,
    }));
    res.json({ ok: true, presets });
  });

  // POST /raids/presets — create a new placeholder preset
  router.post('/presets', express.json(), async (req, res) => {
    if (!(await requireAdmin(req, res))) return;

    const guildId = req.session.active_guild_id || null;
    const guildIdParam = guildId === '0' || guildId === 'null' || !guildId ? null : guildId;
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
    if (!(await requireAdmin(req, res))) return;

    const guildId = req.session.active_guild_id || null;
    const guildIdParam = guildId === '0' || guildId === 'null' || !guildId ? null : guildId;
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

    if (result.affectedRows === 0)
      return res.status(404).json({ ok: false, error: 'Preset not found' });
    res.json({ ok: true });
  });
}

module.exports = registerPresetRoutes;
