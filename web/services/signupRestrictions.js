'use strict';

/**
 * Parse role IDs from repeated form fields or a comma/whitespace-separated
 * manual entry. Returns an error instead of silently discarding invalid IDs.
 */
function parseSignupRoleIds(value) {
  const values = Array.isArray(value) ? value : [value];
  const roleIds = values
    .flatMap((item) => String(item || '').split(/[\s,]+/))
    .map((roleId) => roleId.trim())
    .filter(Boolean);

  if (roleIds.some((roleId) => !/^\d+$/.test(roleId))) {
    return { error: 'Please select valid Discord roles.' };
  }

  return { roleIds: [...new Set(roleIds)] };
}

function hasAnyRequiredRole(memberRoleIds, requiredRoleIds) {
  const memberRoles = new Set((memberRoleIds || []).map(String));
  return (requiredRoleIds || []).some((roleId) => memberRoles.has(String(roleId)));
}

module.exports = { hasAnyRequiredRole, parseSignupRoleIds };
