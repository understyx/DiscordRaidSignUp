'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  applyDemoSession,
  buildDemoSeed,
  demoConfig,
  ensureDemoGuildData,
  isDemoGuildId,
  isDemoHostname,
  resetDemoGuildData,
  startDemoGuildReset,
} = require('../services/demoGuild');

test('demo configuration is enabled only when a base domain exists', () => {
  assert.equal(demoConfig({}).enabled, false);
  const config = demoConfig({ BASE_DOMAIN: 'raiding.site', DEMO_RESET_INTERVAL_MINUTES: '15' });
  assert.equal(config.enabled, true);
  assert.equal(config.resetIntervalMinutes, 15);
  assert.equal(isDemoHostname('demo.raiding.site', config.baseDomain), true);
  assert.equal(isDemoHostname('guild.raiding.site', config.baseDomain), false);
  assert.equal(isDemoGuildId(config.guildId, { BASE_DOMAIN: 'raiding.site' }), true);
});

test('demo seed contains editable characters and future raids', () => {
  const config = demoConfig({ BASE_DOMAIN: 'raiding.site' });
  const now = new Date('2026-09-04T12:00:00Z');
  const seed = buildDemoSeed(config, { now, random: () => 0.42 });

  assert.equal(seed.characters.length, 50);
  assert.equal(
    seed.characters.filter((character) => character.userId === config.officerUserId).length,
    5
  );
  assert.equal(
    seed.characters.filter((character) => character.userId === config.memberUserId).length,
    3
  );
  assert.equal(new Set(seed.characters.map((character) => character.userId)).size, 38);
  assert.equal(seed.raids.length, 3);
  assert.ok(seed.raids.every((raid) => raid.date > now));
  assert.deepEqual(
    seed.raids.map((raid) => raid.compositionSize),
    [18, 0, 23]
  );
  assert.ok(seed.characters.some((character) => character.role === 'tank'));
  assert.ok(seed.characters.some((character) => character.role === 'healer'));
});

test('demo visitor can switch between officer and normal identities', () => {
  const config = demoConfig({ BASE_DOMAIN: 'raiding.site' });
  const session = {};
  applyDemoSession(session, true, config);
  assert.equal(session.user_id, config.officerUserId);
  assert.equal(session.is_admin, true);
  assert.equal(session.demo_view, 'officer');
  assert.equal(session.active_guild_id, config.guildId);
  assert.equal(session.is_demo_session, true);

  session.demo_view = 'member';
  applyDemoSession(session, true, config);
  assert.equal(session.user_id, config.memberUserId);
  assert.equal(session.is_admin, false);
  assert.equal(session.demo_view, 'member');

  applyDemoSession(session, false, config);
  assert.equal(session.user_id, undefined);
  assert.equal(session.active_guild_id, undefined);
  assert.equal(session.is_demo_session, undefined);
  assert.equal(session.demo_view, undefined);
});

test('demo reset replaces scoped records in one transaction and schedules repeats', async () => {
  let nextCharacterId = 100;
  let nextRaidId = 200;
  let committed = false;
  let released = false;
  const statements = [];
  const compositionCounts = new Map();
  const connection = {
    async beginTransaction() {},
    async commit() {
      committed = true;
    },
    async rollback() {},
    release() {
      released = true;
    },
    async query(sql, params = []) {
      statements.push(sql);
      if (/SELECT id FROM raids/.test(sql)) return [[{ id: 1 }]];
      if (/SELECT id FROM characters/.test(sql)) return [[{ id: 2 }]];
      if (/SELECT id FROM recruitment_forms/.test(sql)) return [[{ id: 3 }]];
      if (/SELECT id FROM recruitment_applications/.test(sql)) return [[{ id: 4 }]];
      if (/SELECT id FROM recruitment_questions/.test(sql)) return [[{ id: 5 }]];
      if (/SELECT id FROM bulk_message_jobs/.test(sql)) return [[{ id: 6 }]];
      if (/INSERT INTO characters/.test(sql)) return [{ insertId: nextCharacterId++ }];
      if (/INSERT INTO raids/.test(sql)) return [{ insertId: nextRaidId++ }];
      if (/INSERT INTO compositions/.test(sql)) {
        compositionCounts.set(params[0], (compositionCounts.get(params[0]) || 0) + 1);
      }
      return [{ affectedRows: 1 }];
    },
  };
  const database = {
    async query(sql) {
      if (/COUNT\(\*\).*raids/.test(sql)) return [[{ count: 0 }]];
      if (/COUNT\(\*\).*characters/.test(sql)) return [[{ count: 0 }]];
      throw new Error(`Unexpected health-check query: ${sql}`);
    },
    async getConnection() {
      return connection;
    },
  };
  const config = demoConfig({ BASE_DOMAIN: 'raiding.site', DEMO_RESET_INTERVAL_MINUTES: '12' });

  const result = await resetDemoGuildData(database, config);
  assert.deepEqual(result, { characters: 50, raids: 3 });
  assert.equal(committed, true);
  assert.equal(released, true);
  assert.ok(statements.some((sql) => /DELETE FROM signups/.test(sql)));
  assert.ok(statements.some((sql) => /INSERT INTO compositions/.test(sql)));
  assert.deepEqual(
    [200, 201, 202].map((raidId) => compositionCounts.get(raidId) || 0),
    [18, 0, 23]
  );

  const ensured = await ensureDemoGuildData(database, config);
  assert.deepEqual(ensured, { characters: 50, raids: 3 });

  let scheduledDelay = null;
  const logs = [];
  await startDemoGuildReset({
    database,
    config,
    logger: { log: (message) => logs.push(message), error: assert.fail },
    setIntervalFn(_callback, delay) {
      scheduledDelay = delay;
      return { unref() {} };
    },
  });
  assert.equal(scheduledDelay, 12 * 60 * 1000);
  assert.match(logs[0], /Rebuilt 3 raids and 50 characters/);
});
