'use strict';

const VALID_ROLES = new Set(['tank', 'healer', 'dps', 'mdps', 'rdps']);
const MAX_COMP_NUMBER = 100;

class CompositionValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'CompositionValidationError';
    this.status = status;
  }
}

function parseCompNumber(value, fallback = 1) {
  const parsed = Number.parseInt(value, 10);
  const compNumber = Number.isFinite(parsed) ? parsed : fallback;
  if (!Number.isInteger(compNumber) || compNumber < 1 || compNumber > MAX_COMP_NUMBER) {
    throw new CompositionValidationError(
      `Composition number must be between 1 and ${MAX_COMP_NUMBER}.`
    );
  }
  return compNumber;
}

function normalizeEntry(entry, maxSize, { allowClear = false } = {}) {
  if (!entry || typeof entry !== 'object') {
    throw new CompositionValidationError('Every composition entry must be an object.');
  }

  const match = /^slot_(\d+)$/.exec(String(entry.role_slot || ''));
  const slotNumber = match ? Number.parseInt(match[1], 10) : 0;
  if (!match || slotNumber < 1 || slotNumber > maxSize) {
    throw new CompositionValidationError(`Invalid roster slot: ${entry.role_slot || '(missing)'}.`);
  }

  const clear = allowClear && entry.clear === true;
  const characterId =
    entry.character_id !== null && entry.character_id !== undefined && entry.character_id !== ''
      ? Number.parseInt(entry.character_id, 10)
      : null;
  const discordUserId = entry.discord_user_id ? String(entry.discord_user_id) : null;
  const placeholderText = entry.placeholder_text ? String(entry.placeholder_text).trim() : null;
  const contentCount = [
    characterId !== null,
    Boolean(discordUserId),
    Boolean(placeholderText),
    clear,
  ].filter(Boolean).length;

  if (contentCount !== 1 || (characterId !== null && !Number.isInteger(characterId))) {
    throw new CompositionValidationError(
      `${entry.role_slot} must contain exactly one character, player, placeholder, or clear action.`
    );
  }
  if (discordUserId && !/^\d{1,20}$/.test(discordUserId)) {
    throw new CompositionValidationError(`Invalid Discord user for ${entry.role_slot}.`);
  }
  if (placeholderText && placeholderText.length > 100) {
    throw new CompositionValidationError(
      `Placeholder in ${entry.role_slot} is longer than 100 characters.`
    );
  }

  return {
    role_slot: `slot_${slotNumber}`,
    slot_role: VALID_ROLES.has(entry.slot_role) ? entry.slot_role : 'dps',
    character_id: characterId,
    discord_user_id: discordUserId,
    placeholder_text: placeholderText,
    is_sfs_collector: characterId !== null && entry.is_sfs_collector === true,
    is_val_collector: characterId !== null && entry.is_val_collector === true,
    clear,
  };
}

async function validateCompositionEntries(db, raid, entries, options = {}) {
  if (!Array.isArray(entries)) {
    throw new CompositionValidationError('Composition entries must be a list.');
  }

  const maxSize = Number(raid.max_size) || 25;
  const normalized = entries.map((entry) => normalizeEntry(entry, maxSize, options));
  const seenSlots = new Set();
  for (const entry of normalized) {
    if (seenSlots.has(entry.role_slot)) {
      throw new CompositionValidationError(
        `Roster slot ${entry.role_slot} appears more than once.`
      );
    }
    seenSlots.add(entry.role_slot);
  }

  let activeEntries = normalized.filter((entry) => !entry.clear);
  const characterIds = [
    ...new Set(activeEntries.map((entry) => entry.character_id).filter(Boolean)),
  ];
  const characterOwners = new Map();
  if (characterIds.length > 0) {
    const placeholders = characterIds.map(() => '?').join(', ');
    const [rows] = await db.query(
      `SELECT DISTINCT c.id, c.discord_user_id
       FROM characters c
       JOIN signups s ON s.character_id = c.id AND s.raid_id = ? AND s.is_saved = 0
       WHERE c.id IN (${placeholders}) AND c.guild_id = ? AND c.is_deleted = 0`,
      [raid.id, ...characterIds, raid.guild_id]
    );
    for (const row of rows) characterOwners.set(Number(row.id), String(row.discord_user_id));
    if (characterOwners.size !== characterIds.length && !options.dropIneligible) {
      throw new CompositionValidationError(
        'Every assigned character must be an active character signed up for this raid.'
      );
    }
    if (options.dropIneligible) {
      activeEntries = activeEntries.filter(
        (entry) => entry.character_id === null || characterOwners.has(entry.character_id)
      );
    }
  }

  const playerIds = [
    ...new Set(activeEntries.map((entry) => entry.discord_user_id).filter(Boolean)),
  ];
  if (playerIds.length > 0) {
    const placeholders = playerIds.map(() => '?').join(', ');
    const [rows] = await db.query(
      `SELECT DISTINCT discord_user_id FROM signups
       WHERE raid_id = ? AND is_saved = 0 AND discord_user_id IN (${placeholders})`,
      [raid.id, ...playerIds]
    );
    const signedPlayers = new Set(rows.map((row) => String(row.discord_user_id)));
    if (signedPlayers.size !== playerIds.length && !options.dropIneligible) {
      throw new CompositionValidationError(
        'Every assigned player must be signed up for this raid.'
      );
    }
    if (options.dropIneligible) {
      activeEntries = activeEntries.filter(
        (entry) => !entry.discord_user_id || signedPlayers.has(entry.discord_user_id)
      );
    }
  }

  const seenOwners = new Set();
  for (const entry of activeEntries) {
    const owner = entry.character_id
      ? characterOwners.get(entry.character_id)
      : entry.discord_user_id;
    if (!owner) continue;
    if (seenOwners.has(owner)) {
      throw new CompositionValidationError(
        'Each Discord user can only occupy one slot in a composition.'
      );
    }
    seenOwners.add(owner);
  }

  if (!options.dropIneligible) return normalized;

  const eligibleSlots = new Set(activeEntries.map((entry) => entry.role_slot));
  return normalized.filter((entry) => entry.clear || eligibleSlots.has(entry.role_slot));
}

async function describeIneligibleEntries(db, raid, entries) {
  const details = [];
  const characterEntries = entries.filter((entry) => entry.character_id !== null);
  const characterIds = [...new Set(characterEntries.map((entry) => entry.character_id))];
  const characterState = new Map();

  if (characterIds.length > 0) {
    const placeholders = characterIds.map(() => '?').join(', ');
    const [rows] = await db.query(
      `SELECT c.id, c.guild_id, c.is_deleted,
              COUNT(s.id) AS signup_count,
              COALESCE(MAX(CASE WHEN s.is_saved = 0 THEN 1 ELSE 0 END), 0) AS has_available_signup
       FROM characters c
       LEFT JOIN signups s ON s.character_id = c.id AND s.raid_id = ?
       WHERE c.id IN (${placeholders})
       GROUP BY c.id, c.guild_id, c.is_deleted`,
      [raid.id, ...characterIds]
    );
    for (const row of rows) characterState.set(Number(row.id), row);
  }

  for (const entry of characterEntries) {
    const state = characterState.get(entry.character_id);
    let reason = 'character missing';
    if (state) {
      if (String(state.guild_id) !== String(raid.guild_id))
        reason = 'character belongs to another guild';
      else if (Number(state.is_deleted) !== 0) reason = 'character is deleted';
      else if (Number(state.signup_count) === 0)
        reason = 'character is not signed up for this raid';
      else if (Number(state.has_available_signup) === 0)
        reason = 'character signup is marked saved';
      else reason = 'character failed an unknown eligibility check';
    }
    details.push({
      role_slot: entry.role_slot,
      character_id: entry.character_id,
      discord_user_id: null,
      reason,
    });
  }

  const playerEntries = entries.filter(
    (entry) => entry.character_id === null && Boolean(entry.discord_user_id)
  );
  const playerIds = [...new Set(playerEntries.map((entry) => entry.discord_user_id))];
  const availablePlayers = new Set();
  const signedPlayers = new Set();
  if (playerIds.length > 0) {
    const placeholders = playerIds.map(() => '?').join(', ');
    const [rows] = await db.query(
      `SELECT discord_user_id,
              COUNT(*) AS signup_count,
              COALESCE(MAX(CASE WHEN is_saved = 0 THEN 1 ELSE 0 END), 0) AS has_available_signup
       FROM signups
       WHERE raid_id = ? AND discord_user_id IN (${placeholders})
       GROUP BY discord_user_id`,
      [raid.id, ...playerIds]
    );
    for (const row of rows) {
      const playerId = String(row.discord_user_id);
      signedPlayers.add(playerId);
      if (Number(row.has_available_signup) !== 0) availablePlayers.add(playerId);
    }
  }

  for (const entry of playerEntries) {
    const reason = !signedPlayers.has(entry.discord_user_id)
      ? 'player is not signed up for this raid'
      : !availablePlayers.has(entry.discord_user_id)
        ? 'all player signups are marked saved'
        : 'player failed an unknown eligibility check';
    details.push({
      role_slot: entry.role_slot,
      character_id: null,
      discord_user_id: entry.discord_user_id,
      reason,
    });
  }

  return details;
}

async function ensureCompositionMeta(db, raidId, compNumber) {
  await db.query('INSERT IGNORE INTO composition_meta (raid_id, comp_number) VALUES (?, ?)', [
    raidId,
    compNumber,
  ]);
}

async function lockCompositionMeta(db, raidId, compNumber) {
  await ensureCompositionMeta(db, raidId, compNumber);
  const [[meta]] = await db.query(
    `SELECT revision, published_revision, published_at, discord_message_id
     FROM composition_meta WHERE raid_id = ? AND comp_number = ? FOR UPDATE`,
    [raidId, compNumber]
  );
  return meta;
}

async function bumpCompositionRevision(db, raidId, compNumber) {
  await db.query(
    `UPDATE composition_meta SET revision = revision + 1, updated_at = NOW(3)
     WHERE raid_id = ? AND comp_number = ?`,
    [raidId, compNumber]
  );
  const [[row]] = await db.query(
    'SELECT revision FROM composition_meta WHERE raid_id = ? AND comp_number = ?',
    [raidId, compNumber]
  );
  return Number(row.revision);
}

async function replaceCompositionRows(db, raidId, compNumber, userId, entries) {
  await db.query('DELETE FROM compositions WHERE raid_id = ? AND comp_number = ?', [
    raidId,
    compNumber,
  ]);
  for (const entry of entries) {
    if (entry.clear) continue;
    await insertCompositionRow(db, raidId, compNumber, userId, entry);
  }
}

async function applyCompositionChanges(db, raidId, compNumber, userId, changes) {
  for (const change of changes) {
    await db.query(
      'DELETE FROM compositions WHERE raid_id = ? AND comp_number = ? AND role_slot = ?',
      [raidId, compNumber, change.role_slot]
    );
    if (!change.clear) {
      await insertCompositionRow(db, raidId, compNumber, userId, change);
    }
  }
}

async function insertCompositionRow(db, raidId, compNumber, userId, entry) {
  await db.query(
    `INSERT INTO compositions
      (raid_id, character_id, placeholder_text, discord_user_id, role_slot, slot_role,
       comp_number, is_sfs_collector, is_val_collector, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3))`,
    [
      raidId,
      entry.character_id,
      entry.placeholder_text,
      entry.discord_user_id,
      entry.role_slot,
      entry.slot_role,
      compNumber,
      entry.is_sfs_collector,
      entry.is_val_collector,
      userId,
    ]
  );
}

async function fetchCompositionRows(db, raidId, compNumber, { forUpdate = false } = {}) {
  const [rows] = await db.query(
    `SELECT co.role_slot, co.slot_role, co.character_id, co.placeholder_text, co.discord_user_id,
            co.is_sfs_collector, co.is_val_collector,
            c.char_name, c.char_class, c.spec, c.gearscore, c.sfs_count, c.val_count,
            c.discord_user_id AS char_discord_user_id, c.membership_status,
            s.status AS signup_status, s.is_saved,
            du.username AS du_username, du.display_name AS du_display_name
     FROM compositions co
     LEFT JOIN characters c ON co.character_id = c.id
     LEFT JOIN signups s ON s.raid_id = co.raid_id AND s.character_id = co.character_id
     LEFT JOIN discord_users du ON du.discord_user_id = COALESCE(co.discord_user_id, s.discord_user_id, c.discord_user_id)
     WHERE co.raid_id = ? AND co.comp_number = ?
     ORDER BY CAST(SUBSTRING_INDEX(co.role_slot, '_', -1) AS UNSIGNED)
     ${forUpdate ? 'FOR UPDATE' : ''}`,
    [raidId, compNumber]
  );
  return rows;
}

function serializeCompositionRows(rows) {
  return rows.map((row) => ({
    role_slot: row.role_slot,
    slot_role: row.slot_role || 'dps',
    character_id: row.character_id ? String(row.character_id) : null,
    placeholder_text: row.placeholder_text || null,
    discord_user_id: row.discord_user_id
      ? String(row.discord_user_id)
      : row.char_discord_user_id
        ? String(row.char_discord_user_id)
        : null,
    display_label:
      row.du_username && row.du_display_name && row.du_display_name !== row.du_username
        ? `${row.du_username} – ${row.du_display_name}`
        : row.du_display_name || row.du_username || null,
    char_name: row.char_name || null,
    char_class: row.char_class ? row.char_class.toLowerCase().replace(/ /g, '-') : null,
    spec: row.spec || null,
    gearscore: row.gearscore || 0,
    sfs_count: row.sfs_count,
    val_count: row.val_count,
    is_sfs_collector: Boolean(row.is_sfs_collector),
    is_val_collector: Boolean(row.is_val_collector),
    status: row.signup_status || null,
    membership_status: row.membership_status || null,
    is_saved: Boolean(row.is_saved),
  }));
}

function mergeCompositionChanges(rows, changes) {
  const merged = new Map(
    rows.map((row) => [
      row.role_slot,
      {
        role_slot: row.role_slot,
        slot_role: row.slot_role,
        character_id: row.character_id,
        discord_user_id: row.discord_user_id,
        placeholder_text: row.placeholder_text,
        is_sfs_collector: Boolean(row.is_sfs_collector),
        is_val_collector: Boolean(row.is_val_collector),
      },
    ])
  );
  for (const change of changes) {
    if (change.clear) merged.delete(change.role_slot);
    else merged.set(change.role_slot, change);
  }
  return [...merged.values()];
}

module.exports = {
  CompositionValidationError,
  VALID_ROLES,
  applyCompositionChanges,
  bumpCompositionRevision,
  describeIneligibleEntries,
  ensureCompositionMeta,
  fetchCompositionRows,
  lockCompositionMeta,
  mergeCompositionChanges,
  normalizeEntry,
  parseCompNumber,
  replaceCompositionRows,
  serializeCompositionRows,
  validateCompositionEntries,
};
