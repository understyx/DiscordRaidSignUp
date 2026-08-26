'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const nunjucks = require('nunjucks');

const { createStatisticsRepository } = require('../repositories/statistics');
const { registerFilters } = require('../server/filters');
const { buildAttendanceRoleGroups } = require('../services/guildStatistics');

function createTemplates() {
  const templates = nunjucks.configure(path.join(__dirname, '..', 'templates'), {
    autoescape: true,
  });
  registerFilters(templates);
  return templates;
}

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
            last_signup_at: new Date('2026-08-10T18:00:00.000Z'),
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
      lastSignupAt: '2026-08-10T18:00:00.000Z',
    },
  ]);
  assert.deepEqual(calls[0][1], ['42', '42', '42']);
  assert.match(calls[0][0], /COUNT\(DISTINCT s\.raid_id\)/);
  assert.match(calls[0][0], /MAX\(s\.created_at\) AS last_signup_at/);
  assert.match(calls[0][0], /s\.status IN \('signed', 'tentative'\)/);
  assert.match(calls[0][0], /COALESCE\(co\.discord_user_id, c\.discord_user_id\)/);
  assert.match(calls[0][0], /COUNT\(DISTINCT placed_rows\.raid_id\)/);
});

test('attendance uses server display names and groups members by Discord rank', () => {
  const groups = buildAttendanceRoleGroups(
    [
      {
        userId: '100',
        signupCount: 8,
        placedCount: 6,
        lastSignupAt: '2026-08-10T18:00:00.000Z',
      },
      { userId: '200', signupCount: 4, placedCount: 2 },
    ],
    [
      {
        nick: 'Server Guardian',
        joined_at: '2024-01-15T18:30:00.000Z',
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
  assert.equal(groups[0].members[0].joinedAt, '2024-01-15T18:30:00.000Z');
  assert.equal(groups[0].members[0].lastSignupAt, '2026-08-10T18:00:00.000Z');
  assert.equal(groups[0].members[0].nameColor, '#ff8800');
  assert.equal(groups[1].name, 'Raider');
  assert.equal(groups[1].members[0].displayName, 'Global Mage');
  assert.equal(groups[1].members[0].nameColor, '#33aa66');
});

test('statistics page renders attendance for officers', () => {
  const templates = createTemplates();
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
            username: 'guardian',
            displayName: 'Citadel Guardian',
            joinedAt: '2024-01-15T18:30:00.000Z',
            lastSignupAt: '2026-08-10T18:00:00.000Z',
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
  assert.match(html, /id="statisticsSort"/);
  assert.match(html, /id="statisticsSearch"/);
  assert.match(html, /placeholder="Name, username, or Discord ID…"/);
  assert.match(html, /data-search-text="citadel guardian guardian 123456789012345678"/);
  assert.match(html, /id="statisticsSearchEmpty"/);
  assert.match(html, /No players found/);
  assert.match(html, /value="placed_desc" selected/);
  assert.match(html, /value="signups_desc"/);
  assert.match(html, /value="joined_desc"/);
  assert.match(html, /value="joined_asc"/);
  assert.match(html, /value="last_signup_desc"/);
  assert.match(html, /value="last_signup_asc"/);
  assert.match(html, /value="name_asc"/);
  assert.match(html, /data-display-name="Citadel Guardian"/);
  assert.match(html, /data-joined-at="2024-01-15T18:30:00.000Z"/);
  assert.match(html, /<th scope="col">Joined server<\/th>/);
  assert.match(html, /<th scope="col">Last signed up<\/th>/);
  assert.match(html, /datetime="2024-01-15T18:30:00.000Z">2024-01-15<\/time>/);
  assert.match(
    html,
    /datetime="2026-08-10T18:00:00.000Z" data-raid-relative-time>2026-08-10<\/time>/
  );
  assert.match(html, /class="statistics-exact-date">2026-08-10<\/small>/);
  assert.match(html, /data-last-signup-at="2026-08-10T18:00:00.000Z"/);
  assert.match(html, /data-signup-count="8"/);
  assert.match(html, /data-placed-count="6"/);
  assert.match(html, /src="\/js\/statistics\.js"/);
});

test('statistics highlights zero attendance counts in red', () => {
  const templates = createTemplates();
  const html = templates.render('statistics.html', {
    guild_name: 'Citadel',
    member_count: 1,
    role_groups: [
      {
        id: '20',
        name: 'Raider',
        members: [
          {
            userId: '200',
            displayName: 'New Raider',
            signupCount: 0,
            placedCount: 0,
          },
        ],
      },
    ],
    totals: { signups: 0, placements: 0 },
  });

  assert.equal((html.match(/statistics-count-zero/g) || []).length, 2);
  assert.match(html, /class="statistics-never">Never<\/span>/);
});

test('statistics sorting reorders every Discord-rank section', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'static', 'js', 'statistics.js'),
    'utf8'
  );

  assert.match(source, /querySelectorAll\('\[data-statistics-members\]'\)/);
  assert.match(source, /case 'placed_asc'/);
  assert.match(source, /case 'signups_desc'/);
  assert.match(source, /case 'joined_desc'/);
  assert.match(source, /case 'joined_asc'/);
  assert.match(source, /case 'last_signup_desc'/);
  assert.match(source, /case 'last_signup_asc'/);
  assert.match(source, /case 'name_desc'/);
  assert.match(source, /sortSelect\.addEventListener\('change', sortMembers\)/);
});

test('statistics search filters players across Discord-rank sections', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'static', 'js', 'statistics.js'),
    'utf8'
  );

  assert.match(source, /getElementById\('statisticsSearch'\)/);
  assert.match(source, /row\.dataset\.searchText\.includes\(query\)/);
  assert.match(source, /group\.classList\.toggle\('d-none', visibleInGroup === 0\)/);
  assert.match(source, /getElementById\('statisticsSearchEmpty'\)/);
  assert.match(source, /searchInput\.addEventListener\('input', filterMembers\)/);
});

test('website sign-ups record when the member signed up', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'routes', 'raids', 'signupRoutes.js'),
    'utf8'
  );

  assert.match(source, /status, note, created_at\) VALUES \(\?, \?, \?, \?, \?, \?, NOW\(\)\)/);
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
