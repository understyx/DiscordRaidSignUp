'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const nunjucks = require('nunjucks');

const templateDir = path.join(__dirname, '..', 'templates');
const templates = nunjucks.configure(templateDir, { autoescape: true });
templates.addFilter('dateformat', () => '2026-08-18 20:00');
templates.addFilter('dateiso', (value) => new Date(value).toISOString());
templates.addFilter('gsformat', (value) => String(value));
templates.addFilter('discordId', (value) => String(value));

test('raid list exposes ten-at-a-time loading', () => {
  const route = fs.readFileSync(
    path.join(__dirname, '..', 'routes', 'raids', 'listRoutes.js'),
    'utf8'
  );
  const html = templates.render('raids_list.html', {
    raids: [
      {
        raid: {
          guild_raid_number: 12,
          name: 'ICC25',
          raid_instance: 'ICC25',
          date: new Date(),
          status: 'open',
        },
        signup_coming_count: 8,
        signup_tentative_count: 2,
        can_manage: true,
      },
    ],
    has_more: true,
    raid_page_size: 10,
    user: { id: '1' },
  });

  assert.match(route, /const RAID_PAGE_SIZE = 10/);
  assert.match(route, /LIMIT \? OFFSET \?/);
  assert.match(html, /id="loadMoreRaids"/);
  assert.match(html, /Show 10 more raids/);
  assert.match(html, /<th>Time until raid<\/th>/);
  assert.match(html, /data-raid-relative-time/);
  assert.match(html, /href="\/raids\/12\/edit\?return_to=list"/);
  assert.match(html, /action="\/raids\/12\/lock"/);
});

test('characters page renders compact records and preset role shortcuts', () => {
  const html = templates.render('characters.html', {
    charGroups: [
      {
        name: 'Aegis',
        realm: 'Icecrown',
        char_class: 'Paladin',
        rows: [
          {
            id: 7,
            spec: 'Protection',
            role: 'tank',
            gearscore: 6400,
            prof_1: 'Engineering',
            prof_2: 'Jewelcrafting',
          },
        ],
      },
    ],
    gridChars: [],
    instances: [],
    savesMap: {},
    user: { id: '1' },
  });

  assert.match(html, /class="card character-record"/);
  assert.match(html, /data-preset-selection="none"/);
  assert.match(html, /data-preset-selection="tank"/);
  assert.match(html, /data-preset-selection="healer"/);
  assert.match(html, /data-preset-selection="dps"/);
  assert.match(html, /id="presetList"/);
});

test('guild database renders a searchable Discord member sidebar and selected detail', () => {
  const selectedUser = {
    userId: '123456789012345678',
    username: 'guardian',
    displayName: 'Guardian',
    characterCount: 0,
    charGroups: [],
    roleName: 'Raid Leader',
    roleColor: '#ff8800',
    isFormer: false,
  };
  const html = templates.render('guild_characters.html', {
    guild_name: 'Citadel',
    users: [selectedUser],
    selectedUser,
    activeMemberCount: 1,
    formerMemberCount: 0,
    user: { id: '1', is_admin: true },
  });

  assert.match(html, /id="guildMemberSearch"/);
  assert.match(html, /class="guild-member-link active"/);
  assert.match(html, /No characters registered/);
  assert.match(html, /Add their first character/);
  assert.match(html, /Raid Leader/);
  assert.match(html, /color: #ff8800/);
  assert.match(html, /123456789012345678/);
  assert.doesNotMatch(html, /…345678/);
});

test('guild database marks departed character owners and keeps their cached identity', () => {
  const formerUser = {
    userId: '987654321098765432',
    username: 'last-known-user',
    displayName: 'Last Known Nickname',
    characterCount: 2,
    charGroups: [],
    roleName: 'Veteran',
    roleColor: '#cc3344',
    isFormer: true,
  };
  const html = templates.render('guild_characters.html', {
    guild_name: 'Citadel',
    users: [formerUser],
    selectedUser: formerUser,
    activeMemberCount: 0,
    formerMemberCount: 1,
    user: { id: '1', is_admin: true },
  });

  assert.match(html, /guild-member-link former-member active/);
  assert.match(html, /Last Known Nickname/);
  assert.match(html, /@last-known-user/);
  assert.match(html, /Former member/);
  assert.doesNotMatch(html, /Add their first character/);
});
