'use strict';

function parseJsonColumn(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (Buffer.isBuffer(value)) value = value.toString('utf8');
  if (typeof value !== 'string') return value;

  try {
    return JSON.parse(value);
  } catch (_err) {
    return fallback;
  }
}

function integerIds(value) {
  const parsed = parseJsonColumn(value, []);
  if (!Array.isArray(parsed)) return [];
  return [...new Set(parsed.map(Number).filter(Number.isInteger))];
}

/**
 * Convert preset and character database rows into the read-only view model used
 * by the developer preset peek page.
 */
function buildPresetPeek(presetRows, characterRows) {
  const charactersById = new Map(
    characterRows.map((character) => [Number(character.id), character])
  );
  const ownersById = new Map();

  for (const row of presetRows) {
    const ownerId = String(row.discord_user_id);
    let owner = ownersById.get(ownerId);
    if (!owner) {
      owner = {
        id: ownerId,
        username: row.username || null,
        displayName: row.display_name || row.username || `Discord user ${ownerId}`,
        presets: [],
      };
      ownersById.set(ownerId, owner);
    }

    const priorityIds = new Set(integerIds(row.priority_ids));
    const rawNotes = parseJsonColumn(row.notes, {});
    const notes =
      rawNotes && typeof rawNotes === 'object' && !Array.isArray(rawNotes) ? rawNotes : {};
    const characters = integerIds(row.character_ids).map((id) => {
      const character = charactersById.get(id);
      if (!character || String(character.discord_user_id) !== ownerId) {
        return {
          id,
          unavailable: true,
          priority: priorityIds.has(id),
          note: notes[String(id)] || '',
        };
      }

      return {
        id,
        unavailable: false,
        name: character.char_name,
        realm: character.realm,
        charClass: character.char_class,
        spec: character.spec,
        role: character.role,
        gearscore: character.gearscore,
        priority: priorityIds.has(id),
        note: notes[String(id)] || '',
      };
    });

    owner.presets.push({
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      characters,
    });
  }

  return {
    owners: [...ownersById.values()],
    presetCount: presetRows.length,
  };
}

module.exports = { buildPresetPeek, integerIds, parseJsonColumn };
