'use strict';

const { memberHasGuildCharacterRank } = require('./guildCharacterRanks');

const DISCORD_API = 'https://discord.com/api/v10';

function normalizeDiscordRoles(discordRoles, guildId) {
  return (discordRoles || [])
    .filter((role) => String(role.id) !== String(guildId))
    .map((role) => ({
      id: String(role.id),
      name: role.name,
      position: Number(role.position) || 0,
      managed: Boolean(role.managed),
      colorHex: role.color ? `#${Number(role.color).toString(16).padStart(6, '0')}` : null,
    }))
    .sort((a, b) => b.position - a.position);
}

async function fetchDiscordGuildData(guildId, botToken, fetchImpl = fetch) {
  const headers = { Authorization: `Bot ${botToken}` };
  const members = [];
  let after = null;

  do {
    const params = new URLSearchParams({ limit: '1000' });
    if (after) params.set('after', after);
    const response = await fetchImpl(`${DISCORD_API}/guilds/${guildId}/members?${params}`, {
      headers,
    });
    if (!response.ok) {
      throw new Error(`Discord member lookup failed: ${response.status} ${response.statusText}`);
    }

    const page = await response.json();
    members.push(...page);
    after = page.length === 1000 ? String(page[page.length - 1].user.id) : null;
  } while (after);

  const rolesResponse = await fetchImpl(`${DISCORD_API}/guilds/${guildId}/roles`, { headers });
  if (!rolesResponse.ok) {
    throw new Error(
      `Discord role lookup failed: ${rolesResponse.status} ${rolesResponse.statusText}`
    );
  }

  return {
    members: members.filter((member) => member.user && !member.user.bot),
    roles: await rolesResponse.json(),
  };
}

function buildAttendanceRoleGroups(attendance, members, discordRoles, selectedRankIds, guildId) {
  const roles = normalizeDiscordRoles(discordRoles, guildId).filter((role) => !role.managed);
  const rolesById = new Map(roles.map((role) => [role.id, role]));
  const attendanceByUserId = new Map(
    (attendance || []).map((member) => [String(member.userId), member])
  );
  const groupsByRoleId = new Map();

  for (const member of members || []) {
    if (!member.user || member.user.bot) continue;
    if (!memberHasGuildCharacterRank(member, selectedRankIds)) continue;

    const memberRoles = (member.roles || [])
      .map((roleId) => rolesById.get(String(roleId)))
      .filter(Boolean)
      .sort((a, b) => b.position - a.position);
    const topRole = memberRoles[0];
    if (!topRole) continue;

    const colorRole = memberRoles.find((role) => role.colorHex);
    const userId = String(member.user.id);
    const savedAttendance = attendanceByUserId.get(userId);
    const username = member.user.username || userId;
    const serverDisplayName =
      member.nick || member.user.global_name || member.user.username || userId;

    if (!groupsByRoleId.has(topRole.id)) {
      groupsByRoleId.set(topRole.id, {
        id: topRole.id,
        name: topRole.name,
        color: topRole.colorHex,
        position: topRole.position,
        members: [],
      });
    }

    groupsByRoleId.get(topRole.id).members.push({
      userId,
      username,
      displayName: serverDisplayName,
      joinedAt: member.joined_at || null,
      nameColor: colorRole ? colorRole.colorHex : null,
      signupCount: savedAttendance ? savedAttendance.signupCount : 0,
      placedCount: savedAttendance ? savedAttendance.placedCount : 0,
      lastSignupAt: savedAttendance ? savedAttendance.lastSignupAt : null,
    });
  }

  const groups = [...groupsByRoleId.values()].sort(
    (a, b) => b.position - a.position || a.name.localeCompare(b.name)
  );
  for (const group of groups) {
    group.members.sort(
      (a, b) =>
        b.placedCount - a.placedCount ||
        b.signupCount - a.signupCount ||
        a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' })
    );
  }

  return groups;
}

module.exports = {
  buildAttendanceRoleGroups,
  fetchDiscordGuildData,
  normalizeDiscordRoles,
};
