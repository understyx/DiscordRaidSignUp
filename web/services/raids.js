'use strict';

function raidBaseUrl(raid) {
  return `/raids/${raid.guild_raid_number}`;
}

module.exports = { raidBaseUrl };
