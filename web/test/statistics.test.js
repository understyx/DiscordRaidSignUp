'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const nunjucks = require('nunjucks');

const { createStatisticsRepository } = require('../repositories/statistics');
const { buildAttendanceRoleGroups } = require('../services/guildStatistics');

test('attendance is guild-scoped and counts each member once per raid', async () => {
  const calls = [];
  const repository = createStatisticsRepository({
    async query(sql, params) {
      calls.push([sql, params]);
      return [
        [
          {
            discord_user_id: '123456789012345678',
            username: 'guardian',
            display_name: 'Guardian',
            signup_count: '8',
            placed_count: '6',
          },
        ],
      ];
    },
  });

  const rows = await repository.listGuildMemberAttendance('42');

  assert.deepEqual(rows, [
    {
      userId: '123456789012345678',
      username: 'guardian',
      displayName: 'Guardian',
      signupCount: 8,
      placedCount: 6,
    },
  ]);
  assert.deepEqual(calls[0][1], ['42', '42', '42']);
  assert.match(calls[0][0], /COUNT\(DISTINCT s\.raid_id\)/);
  assert.match(calls[0][0], /s\.status IN \('signed', 'tentative'\)/);
  assert.match(calls[0][0], /COALESCE\(co\.discord_user_id, c\.discord_user_id\)/);
  assert.match(calls[0][0], /COUNT\(DISTINCT placed_rows\.raid_id\)/);
});

test('attendance uses server display names and groups members by Discord rank', () => {
  const groups = buildAttendanceRoleGroups(
    [
      { userId: '100', signupCount: 8, placedCount: 6 },
      { userId: '200', signupCount: 4, placedCount: 2 },
    ],
    [
      {
        nick: 'Server Guardian',
        roles: ['10', '20'],
        user: { id: '100', username: 'guardian', global_name: 'Global Guardian' },
      },
      {
        nick: null,
        roles: ['20'],
        user: { id: '200', username: 'mage', global_name: 'Global Mage' },
      },
      {
        nick: 'Guest',
        roles: ['30'],
        user: { id: '300', username: 'guest' },
      },
    ],
    [
      { id: '42', name: '@everyone', position: 0, color: 0 },
      { id: '10', name: 'Officer', position: 10, color: 0xff8800 },
      { id: '20', name: 'Raider', position: 5, color: 0x33aa66 },
      { id: '30', name: 'Guest', position: 1, color: 0 },
    ],
    ['10', '20'],
    '42'
  );

  assert.equal(groups.length, 2);
  assert.equal(groups[0].name, 'Officer');
  assert.equal(groups[0].members[0].displayName, 'Server Guardian');
  assert.equal(groups[0].members[0].nameColor, '#ff8800');
  assert.equal(groups[1].name, 'Raider');
  assert.equal(groups[1].members[0].displayName, 'Global Mage');
  assert.equal(groups[1].members[0].nameColor, '#33aa66');
});

test('statistics page renders attendance for officers', () => {
  const templates = nunjucks.configure(path.join(__dirname, '..', 'templates'), {
    autoescape: true,
  });
  const html = templates.render('statistics.html', {
    guild_name: 'Citadel',
    member_count: 1,
    role_groups: [
      {
        id: '10',
        name: 'Raid Leader',
        color: '#ff8800',
        members: [
          {
            userId: '123456789012345678',
            displayName: 'Citadel Guardian',
            nameColor: '#ff8800',
            signupCount: 8,
            placedCount: 6,
          },
        ],
      },
    ],
    totals: { signups: 8, placements: 6 },
    user: { id: '1', is_admin: true },
  });

  assert.match(html, /📊 Statistics/);
  assert.match(html, /Guild member raid attendance/);
  assert.match(html, /Raid sign-ups/);
  assert.match(html, /Comp placements/);
  assert.match(html, /Raid Leader/);
  assert.match(html, /Citadel Guardian/);
  assert.match(html, /style="color: #ff8800"/);
  assert.doesNotMatch(html, /@guardian/);
  assert.match(html, /123456789012345678/);
  assert.match(html, /<th scope="col" class="text-end">Signed up<\/th>/);
  assert.match(html, /<th scope="col" class="text-end">Placed in a comp<\/th>/);
});

test('officer navigation links to statistics', () => {
  const templates = nunjucks.configure(path.join(__dirname, '..', 'templates'), {
    autoescape: true,
  });
  const html = templates.render('base.html', {
    user: { id: '1', is_admin: true },
    has_any_guild: true,
  });

  assert.match(html, /href="\/statistics">📊 Statistics<\/a>/);
});
