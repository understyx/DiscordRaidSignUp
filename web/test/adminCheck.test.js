'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createAdminResolver } = require('../routes/adminCheck');

function resolverWith({ rows = [], memberRoles = [], botToken = 'token', fetchError = null } = {}) {
  return createAdminResolver({
    botToken,
    devOverrideEnabled: () => false,
    devUserId: '',
    fetch: async () => {
      if (fetchError) throw fetchError;
      return {
        ok: true,
        async json() {
          return { roles: memberRoles };
        },
      };
    },
    pool: {
      async query() {
        return [rows];
      },
    },
  });
}

test('guild admin resolution accepts a configured matching role', async () => {
  const resolve = resolverWith({ rows: [{ role_id: '8' }], memberRoles: ['3', '8'] });
  assert.equal(await resolve('100', '42'), true);
});

test('guild admin resolution rejects missing roles and fails closed', async () => {
  const noRole = resolverWith({ rows: [{ role_id: '8' }], memberRoles: ['3'] });
  const networkFailure = resolverWith({
    rows: [{ role_id: '8' }],
    fetchError: new Error('offline'),
  });
  assert.equal(await noRole('100', '42'), false);
  assert.equal(await networkFailure('100', '42'), false);
});

test('guilds without configured admin roles preserve open administration', async () => {
  assert.equal(await resolverWith()('100', '42'), true);
});
