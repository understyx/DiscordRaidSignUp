'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const nunjucks = require('nunjucks');

const templateDir = path.join(__dirname, '..', 'templates');
const templates = nunjucks.configure(templateDir, { autoescape: true });
templates.addFilter('dateformat', () => '2026-08-18 20:00');
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
  assert.match(html, /href="\/raids\/12\/edit"/);
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
    userId: '123',
    username: 'guardian',
    displayName: 'Guardian',
    characterCount: 0,
    charGroups: [],
  };
  const html = templates.render('guild_characters.html', {
    guild_name: 'Citadel',
    users: [selectedUser],
    selectedUser,
    user: { id: '1', is_admin: true },
  });

  assert.match(html, /id="guildMemberSearch"/);
  assert.match(html, /class="guild-member-link active"/);
  assert.match(html, /No characters registered/);
  assert.match(html, /Add their first character/);
});
