'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { savePlaceholderPreset, saveSignupPreset } = require('../services/presets');

function recordingPool(insertId) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return [{ insertId }];
    },
  };
}

test('saving a signup preset upserts within its user and guild scope', async () => {
  const pool = recordingPool(17);
  const id = await saveSignupPreset(pool, {
    userId: '10',
    guildId: '20',
    name: 'Mains',
    characterIds: [1, 2],
    priorityIds: [1],
    notes: { 2: 'Backup' },
  });

  assert.equal(id, 17);
  assert.match(pool.calls[0].sql, /ON DUPLICATE KEY UPDATE/);
  assert.match(pool.calls[0].sql, /id = LAST_INSERT_ID\(id\)/);
  assert.deepEqual(pool.calls[0].params, ['10', '20', 'Mains', '[1,2]', '[1]', '{"2":"Backup"}']);
});

test('saving a placeholder preset upserts within its guild scope', async () => {
  const pool = recordingPool(23);
  const id = await savePlaceholderPreset(pool, {
    guildId: '20',
    userId: '10',
    name: 'Standard',
    slots: [{ role_slot: 1, slot_role: 'tank', placeholder_text: 'Tank' }],
  });

  assert.equal(id, 23);
  assert.match(pool.calls[0].sql, /ON DUPLICATE KEY UPDATE/);
  assert.match(pool.calls[0].sql, /id = LAST_INSERT_ID\(id\)/);
  assert.deepEqual(pool.calls[0].params, [
    '20',
    'Standard',
    '[{"role_slot":1,"slot_role":"tank","placeholder_text":"Tank"}]',
    '10',
  ]);
});
