'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const nunjucks = require('nunjucks');

const { createStatisticsRepository } = require('../repositories/statistics');

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
  assert.match(calls[0][0], /c\.membership_status = 'active'/);
});

test('statistics page renders attendance for officers', () => {
  const templates = nunjucks.configure(path.join(__dirname, '..', 'templates'), {
    autoescape: true,
  });
  const html = templates.render('statistics.html', {
    guild_name: 'Citadel',
    attendance: [
      {
        userId: '123456789012345678',
        username: 'guardian',
        displayName: 'Guardian',
        signupCount: 8,
        placedCount: 6,
      },
    ],
    totals: { signups: 8, placements: 6 },
    user: { id: '1', is_admin: true },
  });

  assert.match(html, /📊 Statistics/);
  assert.match(html, /Guild member raid attendance/);
  assert.match(html, /Raid sign-ups/);
  assert.match(html, /Comp placements/);
  assert.match(html, /Guardian/);
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
