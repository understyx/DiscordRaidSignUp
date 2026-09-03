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

test('demo guild grants officer access only to the officer identity', async () => {
  const previous = {
    baseDomain: process.env.BASE_DOMAIN,
    enabled: process.env.DEMO_GUILD_ENABLED,
    guildId: process.env.DEMO_GUILD_ID,
  };
  process.env.BASE_DOMAIN = 'raiding.site';
  process.env.DEMO_GUILD_ENABLED = 'true';
  process.env.DEMO_GUILD_ID = '-1';
  try {
    const resolve = resolverWith();
    assert.equal(await resolve('-99', '-1'), true);
    assert.equal(await resolve('-98', '-1'), false);
  } finally {
    for (const [key, value] of [
      ['BASE_DOMAIN', previous.baseDomain],
      ['DEMO_GUILD_ENABLED', previous.enabled],
      ['DEMO_GUILD_ID', previous.guildId],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('admin resolution caches Discord membership checks', async () => {
  let fetchCount = 0;
  const resolve = createAdminResolver({
    botToken: 'token',
    devOverrideEnabled: () => false,
    devUserId: '',
    fetch: async () => {
      fetchCount += 1;
      return {
        ok: true,
        async json() {
          return { roles: ['8'] };
        },
      };
    },
    pool: {
      async query() {
        return [[{ role_id: '8' }]];
      },
    },
  });

  assert.equal(await resolve('100', '42'), true);
  assert.equal(await resolve('100', '42'), true);
  assert.equal(fetchCount, 1);
});

test('transient Discord failures reuse a recently verified permission', async () => {
  let clock = 0;
  let shouldFail = false;
  const resolve = createAdminResolver({
    botToken: 'token',
    cacheTtlMs: 10,
    staleTtlMs: 100,
    now: () => clock,
    logger: { warn() {} },
    devOverrideEnabled: () => false,
    devUserId: '',
    fetch: async () => {
      if (shouldFail) return { ok: false, status: 429 };
      return {
        ok: true,
        async json() {
          return { roles: ['8'] };
        },
      };
    },
    pool: {
      async query() {
        return [[{ role_id: '8' }]];
      },
    },
  });

  assert.equal(await resolve('100', '42'), true);
  clock = 20;
  shouldFail = true;
  assert.equal(await resolve('100', '42'), true);
});

test('a confirmed missing guild member overrides a cached permission', async () => {
  let clock = 0;
  let missing = false;
  const resolve = createAdminResolver({
    botToken: 'token',
    cacheTtlMs: 10,
    staleTtlMs: 100,
    now: () => clock,
    devOverrideEnabled: () => false,
    devUserId: '',
    fetch: async () => {
      if (missing) return { ok: false, status: 404 };
      return {
        ok: true,
        async json() {
          return { roles: ['8'] };
        },
      };
    },
    pool: {
      async query() {
        return [[{ role_id: '8' }]];
      },
    },
  });

  assert.equal(await resolve('100', '42'), true);
  clock = 20;
  missing = true;
  assert.equal(await resolve('100', '42'), false);
});
