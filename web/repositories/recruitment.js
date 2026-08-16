'use strict';

function createRecruitmentRepository(pool) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('createRecruitmentRepository requires a database pool');
  }

  async function resolveFormParam(param, requireActive = false) {
    const numericId = Number.parseInt(param, 10);
    const activeClause = requireActive ? ' AND is_active = 1' : '';
    if (numericId && String(numericId) === String(param)) {
      const [[form]] = await pool.query(
        `SELECT * FROM recruitment_forms WHERE id = ?${activeClause}`,
        [numericId]
      );
      return form || null;
    }

    if (/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(param) || /^[a-z0-9]$/.test(param)) {
      const [[form]] = await pool.query(
        `SELECT * FROM recruitment_forms WHERE slug = ?${activeClause}`,
        [param]
      );
      return form || null;
    }
    return null;
  }

  return { resolveFormParam };
}

module.exports = { createRecruitmentRepository };
