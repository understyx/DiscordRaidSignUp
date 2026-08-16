'use strict';

function registerEditRoutes(router, dependencies) {
  const {
    currentUser,
    express,
    formatRaidDateInput,
    getRaidByUrlParams,
    normalizeRaidEditInput,
    pool,
    popFlash,
    raidBaseUrl,
    requireAdmin,
    syncRaidSignupMessage,
  } = dependencies;

  router.get('/:raid_number/edit', async (req, res) => {
    if (!(await requireAdmin(req, res))) return;

    const raidNumber = Number.parseInt(req.params.raid_number, 10);
    const raid = await getRaidByUrlParams(req.session.active_guild_id || null, raidNumber);
    if (!raid) return res.redirect('/raids');

    return res.render('edit_raid.html', {
      raid,
      raid_url: raidBaseUrl(raid),
      date_value: formatRaidDateInput(raid.date),
      flash: popFlash(req),
      user: currentUser(req),
    });
  });

  router.post('/:raid_number/edit', express.urlencoded({ extended: false }), async (req, res) => {
    if (!(await requireAdmin(req, res))) return;

    const raidNumber = Number.parseInt(req.params.raid_number, 10);
    const raid = await getRaidByUrlParams(req.session.active_guild_id || null, raidNumber);
    if (!raid) return res.redirect('/raids');

    const normalized = normalizeRaidEditInput(req.body || {});
    if (normalized.error) {
      req.session.flash = `❌ ${normalized.error}`;
      return res.redirect(`${raidBaseUrl(raid)}/edit`);
    }

    const { name, raidInstance, description, dateSql, maxSize } = normalized.values;
    await pool.query(
      `UPDATE raids
         SET name = ?, raid_instance = ?, date = ?, description = ?, max_size = ?
         WHERE id = ?`,
      [name, raidInstance, dateSql, description, maxSize, raid.id]
    );

    const updatedRaid = await getRaidByUrlParams(req.session.active_guild_id || null, raidNumber);
    let discordWarning = '';
    try {
      const discordResult = await syncRaidSignupMessage(updatedRaid);
      if (!discordResult.ok) discordWarning = ' The Discord post could not be refreshed.';
    } catch (error) {
      console.warn('[edit_raid] Failed to refresh Discord post:', error.message || error);
      discordWarning = ' The Discord post could not be refreshed.';
    }

    req.session.flash = `✅ Raid '${name}' updated.${discordWarning}`;
    return res.redirect(raidBaseUrl(updatedRaid || raid));
  });
}

module.exports = registerEditRoutes;
