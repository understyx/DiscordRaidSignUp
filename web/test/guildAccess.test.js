'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { safeRelativeRedirect, selectAvailableGuilds } = require('../services/guildAccess');

const guilds = [
  { guild_id: '1', guild_name: 'One' },
  { guild_id: '2', guild_name: 'Two' },
  { guild_id: '99', guild_name: 'Notifications' },
];

test('regular users only receive guilds they belong to', () => {
  assert.deepEqual(selectAvailableGuilds(guilds, ['2'], { excludedGuildId: '99' }), [
    { guild_id: '2', guild_name: 'Two', is_dev_only: false },
  ]);
});

test('developer access is explicit and excludes the notification guild', () => {
  assert.deepEqual(selectAvailableGuilds(guilds, ['1'], { isDev: true, excludedGuildId: '99' }), [
    { guild_id: '1', guild_name: 'One', is_dev_only: false },
    { guild_id: '2', guild_name: 'Two', is_dev_only: true },
  ]);
});

test('redirects remain local to the application', () => {
  assert.equal(safeRelativeRedirect('/raids/4'), '/raids/4');
  assert.equal(safeRelativeRedirect('//evil.example'), '/raids');
  assert.equal(safeRelativeRedirect('%2F%2Fevil.example'), '/raids');
  assert.equal(safeRelativeRedirect('/raids%0d%0aLocation:evil'), '/raids');
});
