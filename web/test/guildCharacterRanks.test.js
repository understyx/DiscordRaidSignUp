'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  memberHasGuildCharacterRank,
  parseGuildCharacterRankIds,
  resolveGuildCharacterRankIds,
} = require('../services/guildCharacterRanks');

test('guild character rank IDs are validated and deduplicated', () => {
  assert.deepEqual(parseGuildCharacterRankIds(['10', '20', '10']), {
    error: null,
    roleIds: ['10', '20'],
  });
  assert.match(parseGuildCharacterRankIds(['10', 'invalid']).error, /valid Discord ranks/);
});

test('all available ranks are the default until the guild saves a filter', () => {
  const roles = [{ id: '10' }, { id: '20' }];
  assert.deepEqual(resolveGuildCharacterRankIds([], roles), ['10', '20']);
  assert.deepEqual(resolveGuildCharacterRankIds(['20'], roles), ['20']);
});

test('a member counts when they have any selected guild rank', () => {
  assert.equal(memberHasGuildCharacterRank({ roles: ['5', '10'] }, ['10', '20']), true);
  assert.equal(memberHasGuildCharacterRank({ roles: ['5'] }, ['10', '20']), false);
  assert.equal(memberHasGuildCharacterRank({ roles: [] }, ['10', '20']), false);
});
