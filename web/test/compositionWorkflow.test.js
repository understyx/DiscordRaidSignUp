'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CompositionValidationError,
  describeIneligibleEntries,
  mergeCompositionChanges,
  normalizeEntry,
  parseCompNumber,
  serializeCompositionRows,
  validateCompositionEntries,
} = require('../services/compositionWorkflow');

const raid = { id: 42, guild_id: '9001', max_size: 10 };

function validationDb({ characters = [], players = [] } = {}) {
  return {
    async query(sql) {
      if (sql.includes('FROM characters c')) return [characters];
      if (sql.includes('SELECT DISTINCT discord_user_id FROM signups')) return [players];
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
}

test('composition numbers and absolute slots are bounded', () => {
  assert.equal(parseCompNumber('2'), 2);
  assert.throws(() => parseCompNumber('0'), CompositionValidationError);
  assert.throws(
    () => normalizeEntry({ role_slot: 'slot_11', placeholder_text: 'Tank' }, 10),
    /Invalid roster slot/
  );
});

test('composition validation accepts signed guild characters and placeholders', async () => {
  const entries = await validateCompositionEntries(
    validationDb({ characters: [{ id: 7, discord_user_id: '101' }] }),
    raid,
    [
      { role_slot: 'slot_1', slot_role: 'tank', character_id: 7 },
      { role_slot: 'slot_2', slot_role: 'healer', placeholder_text: 'Healer' },
    ]
  );

  assert.equal(entries[0].character_id, 7);
  assert.equal(entries[1].placeholder_text, 'Healer');
});

test('composition validation rejects the same Discord player in two forms', async () => {
  await assert.rejects(
    validateCompositionEntries(
      validationDb({
        characters: [{ id: 7, discord_user_id: '101' }],
        players: [{ discord_user_id: '101' }],
      }),
      raid,
      [
        { role_slot: 'slot_1', character_id: 7 },
        { role_slot: 'slot_2', discord_user_id: '101' },
      ]
    ),
    /only occupy one slot/
  );
});

test('composition validation can drop characters and players whose sign-ups changed', async () => {
  const entries = await validateCompositionEntries(
    validationDb({
      characters: [{ id: 7, discord_user_id: '101' }],
      players: [{ discord_user_id: '202' }],
    }),
    raid,
    [
      { role_slot: 'slot_1', character_id: 7 },
      { role_slot: 'slot_2', character_id: 8 },
      { role_slot: 'slot_3', discord_user_id: '202' },
      { role_slot: 'slot_4', discord_user_id: '303' },
      { role_slot: 'slot_5', placeholder_text: 'Flexible DPS' },
    ],
    { dropIneligible: true }
  );

  assert.deepEqual(
    entries.map((entry) => entry.role_slot),
    ['slot_1', 'slot_3', 'slot_5']
  );
});

test('ineligible composition entries include actionable reasons', async () => {
  const db = {
    async query(sql) {
      if (sql.includes('FROM characters c')) {
        return [
          [
            {
              id: 7,
              guild_id: '9001',
              is_deleted: 0,
              signup_count: 1,
              has_available_signup: 0,
            },
            {
              id: 8,
              guild_id: '9999',
              is_deleted: 0,
              signup_count: 1,
              has_available_signup: 1,
            },
          ],
        ];
      }
      if (sql.includes('FROM signups')) return [[]];
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const details = await describeIneligibleEntries(db, raid, [
    { role_slot: 'slot_1', character_id: 7, discord_user_id: null },
    { role_slot: 'slot_2', character_id: 8, discord_user_id: null },
    { role_slot: 'slot_3', character_id: 9, discord_user_id: null },
  ]);

  assert.deepEqual(
    details.map((entry) => entry.reason),
    ['character signup is marked saved', 'character belongs to another guild', 'character missing']
  );
});

test('patch merging preserves untouched slots and applies clears', () => {
  const rows = [
    { role_slot: 'slot_1', slot_role: 'tank', character_id: 7 },
    { role_slot: 'slot_2', slot_role: 'healer', placeholder_text: 'Healer' },
  ];
  const merged = mergeCompositionChanges(rows, [
    { role_slot: 'slot_1', clear: true },
    { role_slot: 'slot_3', slot_role: 'rdps', placeholder_text: 'Mage' },
  ]);
  assert.deepEqual(merged.map((entry) => entry.role_slot).sort(), ['slot_2', 'slot_3']);
});

test('serialized collaborative state includes availability and collector fields', () => {
  const [entry] = serializeCompositionRows([
    {
      role_slot: 'slot_1',
      slot_role: 'tank',
      character_id: 7,
      char_discord_user_id: '101',
      char_name: 'Aegis',
      char_class: 'Death Knight',
      is_sfs_collector: 1,
      is_saved: 1,
      membership_status: 'inactive',
    },
  ]);
  assert.equal(entry.char_class, 'death-knight');
  assert.equal(entry.discord_user_id, '101');
  assert.equal(entry.is_sfs_collector, true);
  assert.equal(entry.is_saved, true);
  assert.equal(entry.membership_status, 'inactive');
});
