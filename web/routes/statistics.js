'use strict';

const express = require('express');
const pool = require('../db');
const { createStatisticsRepository } = require('../repositories/statistics');
const {
  buildAttendanceRoleGroups,
  fetchDiscordGuildData,
  normalizeDiscordRoles,
} = require('../services/guildStatistics');
const { resolveGuildCharacterRankIds } = require('../services/guildCharacterRanks');
const { currentUser, popFlash, requireAdmin } = require('./helpers');

const router = express.Router();
const { listGuildMemberAttendance } = createStatisticsRepository(pool);

router.get('/', async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const guildId = req.session.active_guild_id;
  if (!guildId) {
    req.session.flash = '❌ No active guild selected.';
    return res.redirect('/raids');
  }

  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!botToken) {
    req.session.flash = '❌ Bot token not configured.';
    return res.redirect('/raids');
  }

  try {
    const [attendance, discordData, rankRowsResult] = await Promise.all([
      listGuildMemberAttendance(guildId),
      fetchDiscordGuildData(guildId, botToken),
      pool.query('SELECT role_id FROM guild_character_ranks WHERE guild_id = ? ORDER BY role_id', [
        guildId,
      ]),
    ]);
    const [savedRankRows] = rankRowsResult;
    const availableRoles = normalizeDiscordRoles(discordData.roles, guildId).filter(
      (role) => !role.managed
    );
    const selectedRankIds = resolveGuildCharacterRankIds(
      savedRankRows.map((row) => String(row.role_id)),
      availableRoles
    );
    const roleGroups = buildAttendanceRoleGroups(
      attendance,
      discordData.members,
      discordData.roles,
      selectedRankIds,
      guildId
    );
    const displayedMembers = roleGroups.flatMap((group) => group.members);
    const totals = displayedMembers.reduce(
      (summary, member) => ({
        signups: summary.signups + member.signupCount,
        placements: summary.placements + member.placedCount,
      }),
      { signups: 0, placements: 0 }
    );

    res.render('statistics.html', {
      member_count: displayedMembers.length,
      role_groups: roleGroups,
      totals,
      guild_name: req.session.active_guild_name,
      flash: popFlash(req),
      user: currentUser(req),
    });
  } catch (err) {
    console.error('[statistics] Failed to load attendance:', err);
    req.session.flash = '❌ Failed to load guild statistics.';
    res.redirect('/raids');
  }
});

module.exports = router;
