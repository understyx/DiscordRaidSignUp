'use strict';

const express = require('express');
const pool = require('../db');
const { createStatisticsRepository } = require('../repositories/statistics');
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

  try {
    const attendance = await listGuildMemberAttendance(guildId);
    const totals = attendance.reduce(
      (summary, member) => ({
        signups: summary.signups + member.signupCount,
        placements: summary.placements + member.placedCount,
      }),
      { signups: 0, placements: 0 }
    );

    res.render('statistics.html', {
      attendance,
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
