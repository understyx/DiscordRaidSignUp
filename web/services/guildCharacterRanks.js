'use strict';

function parseGuildCharacterRankIds(value) {
  const values = Array.isArray(value) ? value : [value];
  const roleIds = values.map((roleId) => String(roleId || '').trim()).filter(Boolean);

  if (roleIds.some((roleId) => !/^\d+$/.test(roleId))) {
    return { error: 'Please select valid Discord ranks.', roleIds: [] };
  }

  return { error: null, roleIds: [...new Set(roleIds)] };
}

function resolveGuildCharacterRankIds(savedRoleIds, availableRoles) {
  const saved = [...new Set((savedRoleIds || []).map(String))];
  if (saved.length) return saved;
  return (availableRoles || []).map((role) => String(role.id));
}

function memberHasGuildCharacterRank(member, selectedRoleIds) {
  const selected = new Set((selectedRoleIds || []).map(String));
  return (member.roles || []).some((roleId) => selected.has(String(roleId)));
}

module.exports = {
  memberHasGuildCharacterRank,
  parseGuildCharacterRankIds,
  resolveGuildCharacterRankIds,
};
