'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { hasAnyRequiredRole, parseSignupRoleIds } = require('../services/signupRestrictions');

test('signup roles accept repeated fields and delimited manual input', () => {
  assert.deepEqual(parseSignupRoleIds(['11', '22', '11']), { roleIds: ['11', '22'] });
  assert.deepEqual(parseSignupRoleIds('11, 22\n33'), { roleIds: ['11', '22', '33'] });
});

test('signup roles reject invalid Discord IDs', () => {
  assert.match(parseSignupRoleIds(['11', 'not-a-role']).error, /valid Discord roles/i);
});

test('a member may sign up when any configured role matches', () => {
  assert.equal(hasAnyRequiredRole(['5', '22'], ['11', '22']), true);
  assert.equal(hasAnyRequiredRole(['5'], ['11', '22']), false);
  assert.equal(hasAnyRequiredRole(['5'], []), false);
});
