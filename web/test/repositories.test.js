'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createRaidRepository } = require('../repositories/raids');
const { createRecruitmentRepository } = require('../repositories/recruitment');

test('raid lookup always scopes a numbered raid to its guild', async () => {
  const calls = [];
  const repository = createRaidRepository({
    async query(sql, params) {
      calls.push([sql, params]);
      return [[{ id: 5 }]];
    },
  });
  assert.deepEqual(await repository.findByGuildRaidNumber('42', 3), { id: 5 });
  assert.match(calls[0][0], /guild_id = \?/);
  assert.deepEqual(calls[0][1], ['42', 3]);
});

test('recruitment lookup can require active forms', async () => {
  const calls = [];
  const repository = createRecruitmentRepository({
    async query(sql, params) {
      calls.push([sql, params]);
      return [[{ id: 4 }]];
    },
  });
  await repository.resolveFormParam('apply-now', true);
  assert.match(calls[0][0], /slug = \? AND is_active = 1/);
  assert.deepEqual(calls[0][1], ['apply-now']);
});
