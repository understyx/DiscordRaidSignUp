const pool = require('../../db');

// Slugs that must not collide with top-level or recruitment-router path segments
const RESERVED_SLUGS = [
  'new', 'oauth-callback',
  'auth', 'raids', 'admin', 'guild-settings', 'select-guild', 'recruitment',
];

/**
 * Validate and normalise a user-supplied slug value.
 * Returns the lowercase slug string, null (if blank), or throws a string error message.
 */
function normaliseSlug(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  // Must start and end with a letter or digit; allow hyphens in between
  if (!/^[a-z0-9][a-z0-9-]{0,98}[a-z0-9]$/.test(s) && !/^[a-z0-9]$/.test(s)) {
    throw '❌ Slug must start and end with a letter or digit and may only contain lowercase letters, numbers, and hyphens (max 100 characters).';
  }
  if (s.length > 100) {
    throw '❌ Slug may be at most 100 characters.';
  }
  if (RESERVED_SLUGS.includes(s)) {
    throw `❌ "${s}" is a reserved slug and cannot be used.`;
  }
  return s;
}

/**
 * Resolve a URL parameter (numeric ID or slug) to a recruitment_forms row.
 * Returns the form row or null.
 */
async function resolveFormParam(param, requireActive = false) {
  const numericId = parseInt(param, 10);
  const activeClause = requireActive ? ' AND is_active = 1' : '';
  if (numericId && String(numericId) === String(param)) {
    const [[form]] = await pool.query(
      `SELECT * FROM recruitment_forms WHERE id = ?${activeClause}`,
      [numericId]
    );
    return form || null;
  }
  // Treat as slug
  if (/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(param) || /^[a-z0-9]$/.test(param)) {
    const [[form]] = await pool.query(
      `SELECT * FROM recruitment_forms WHERE slug = ?${activeClause}`,
      [param]
    );
    return form || null;
  }
  return null;
}

/** Parse questions from a form builder POST body. Returns array of question objects. */
function parseQuestions(body) {
  const texts     = [].concat(body.q_text     || []);
  const types     = [].concat(body.q_type     || []);
  const opts      = [].concat(body.q_options  || []);
  const reqs      = [].concat(body.q_required || []);
  const defaults  = [].concat(body.q_default  || []);
  const groupKeys = [].concat(body.q_group_key        || []);
  const groupLabels = [].concat(body.q_group_label    || []);
  const groupReps = [].concat(body.q_group_repeatable || []);
  const colWidths = [].concat(body.q_col_width        || []);

  const questions = [];
  const MAX_QUESTIONS = 50;
  const limit = Math.min(texts.length, MAX_QUESTIONS);
  for (let i = 0; i < limit; i++) {
    const text = String(texts[i] || '').trim();
    const type = ['text', 'textarea', 'select', 'radio', 'characters', 'checkbox', 'header', 'separator'].includes(types[i])
      ? types[i]
      : 'text';

    if (!text && type !== 'separator') continue;

    let options = null;
    if (['select', 'radio', 'checkbox'].includes(type)) {
      const rawOpts = String(opts[i] || '').trim();
      if (rawOpts) {
        options = JSON.stringify(rawOpts.split('\n').map(o => o.trim()).filter(Boolean));
      }
    }

    const isLayout = ['header', 'separator'].includes(type);
    const defaultValue = (type === 'characters' || isLayout) ? null : (String(defaults[i] || '').trim() || null);
    const rawGroupKey  = (type === 'characters' || isLayout) ? '' : String(groupKeys[i] || '').trim().toLowerCase();
    const groupKey     = rawGroupKey.replace(/[^a-z0-9-]/g, '') || null;
    const groupLabel   = groupKey ? (String(groupLabels[i] || '').trim() || null) : null;
    const isGroupRepeatable = (groupKey && groupReps[i] === 'on') ? 1 : 0;
    // 'characters', 'header', 'separator' are always full-width; group settings do not apply to them
    const colWidth = (type === 'characters' || isLayout)
      ? 'full'
      : (['full', 'half', 'third'].includes(colWidths[i]) ? colWidths[i] : 'full');

    questions.push({
      question_text:       text,
      question_type:       type,
      options:             (type === 'characters' || isLayout) ? null : options,
      is_required:         isLayout ? 0 : (reqs[i] === 'on' ? 1 : 0),
      sort_order:          i,
      default_value:       defaultValue,
      group_key:           groupKey,
      group_label:         groupLabel,
      is_group_repeatable: isGroupRepeatable,
      col_width:           colWidth,
    });
  }

  // Only one 'characters' question is allowed per form — keep the first occurrence.
  let seenCharacters = false;
  return questions.filter(q => {
    if (q.question_type !== 'characters') return true;
    if (!seenCharacters) { seenCharacters = true; return true; }
    return false;
  });
}

/**
 * Organise a flat list of questions into rendering blocks.
 * Questions without a group_key become individual 'question' blocks.
 * Questions sharing a group_key are merged into a 'group' block.
 */
function buildQuestionBlocks(questions) {
  const blocks   = [];
  const groupMap = new Map();

  for (const q of questions) {
    if (!q.group_key) {
      blocks.push({ type: 'question', question: q });
    } else {
      if (groupMap.has(q.group_key)) {
        const grp = groupMap.get(q.group_key);
        grp.questions.push(q);
        if (q.is_group_repeatable) grp.is_repeatable = true;
        if (q.group_label && !grp._has_label) {
          grp.label       = q.group_label;
          grp._has_label  = true;
        }
      } else {
        const grp = {
          type:          'group',
          key:           q.group_key,
          label:         q.group_label || q.group_key,
          _has_label:    !!q.group_label,
          is_repeatable: !!q.is_group_repeatable,
          questions:     [q],
          instances:     [{}], // default: one blank instance
        };
        groupMap.set(q.group_key, grp);
        blocks.push(grp);
      }
    }
  }

  // Remove internal flag
  for (const b of blocks) {
    if (b.type === 'group') delete b._has_label;
  }

  return blocks;
}

/**
 * For repeatable groups, build a per-group array of per-instance answer maps.
 * Answers for repeatable questions are stored as a JSON array in answer_text.
 * Returns { group_key: [ { question_id: value, … }, … ] }
 */
function buildExistingGroupInstances(blocks, existingAnswers) {
  const result = {};

  for (const block of blocks) {
    if (block.type !== 'group' || !block.is_repeatable) continue;

    // Determine how many instances exist
    let maxInstances = 1;
    for (const q of block.questions) {
      const raw = existingAnswers[String(q.id)] || '';
      if (raw.startsWith('[')) {
        try {
          const arr = JSON.parse(raw);
          if (Array.isArray(arr)) maxInstances = Math.max(maxInstances, arr.length);
        } catch { /* ignore */ }
      }
    }

    const instances = [];
    for (let i = 0; i < maxInstances; i++) {
      const inst = {};
      for (const q of block.questions) {
        const raw = existingAnswers[String(q.id)] || '';
        if (raw.startsWith('[')) {
          try {
            const arr = JSON.parse(raw);
            inst[String(q.id)] = Array.isArray(arr) ? (arr[i] !== undefined ? arr[i] : '') : '';
          } catch {
            inst[String(q.id)] = i === 0 ? raw : '';
          }
        } else {
          inst[String(q.id)] = i === 0 ? raw : '';
        }
      }
      instances.push(inst);
    }
    result[block.key] = instances;
  }

  return result;
}

module.exports = {
  RESERVED_SLUGS,
  normaliseSlug,
  resolveFormParam,
  parseQuestions,
  buildQuestionBlocks,
  buildExistingGroupInstances,
};
