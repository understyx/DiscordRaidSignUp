'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const nunjucks = require('nunjucks');
const { registerFilters } = require('../server/filters');
const { buildPresetPeek } = require('../services/presetPeek');

test('builds an owner-grouped read-only view of signup presets', () => {
  const result = buildPresetPeek(
    [
      {
        id: 4,
        discord_user_id: '100',
        username: 'raider',
        display_name: 'The Raider',
        name: 'Main team',
        character_ids: '[7,8]',
        priority_ids: '[8]',
        notes: '{"7":"Can flex"}',
        created_at: new Date('2026-08-18T10:00:00Z'),
      },
    ],
    [
      {
        id: 7,
        discord_user_id: '100',
        char_name: 'Aegis',
        realm: 'Icecrown',
        char_class: 'Paladin',
        spec: 'Protection',
        role: 'tank',
        gearscore: 6400,
      },
      // A stale/tampered preset ID must not expose another user's character.
      { id: 8, discord_user_id: '200', char_name: 'Secret' },
    ]
  );

  assert.equal(result.presetCount, 1);
  assert.equal(result.owners.length, 1);
  assert.equal(result.owners[0].displayName, 'The Raider');
  assert.equal(result.owners[0].presets[0].characters[0].name, 'Aegis');
  assert.equal(result.owners[0].presets[0].characters[0].note, 'Can flex');
  assert.equal(result.owners[0].presets[0].characters[1].unavailable, true);
  assert.equal(result.owners[0].presets[0].characters[1].priority, true);
});

test('developer preset page shows owners, priority, notes, and empty state', () => {
  const templates = nunjucks.configure(path.join(__dirname, '..', 'templates'), {
    autoescape: true,
  });
  registerFilters(templates);

  const owner = {
    id: '100',
    username: 'raider',
    displayName: 'The Raider',
    presets: [
      {
        id: 4,
        name: 'Main team',
        createdAt: new Date('2026-08-18T10:00:00Z'),
        characters: [
          {
            id: 7,
            name: 'Aegis',
            realm: 'Icecrown',
            charClass: 'Paladin',
            spec: 'Protection',
            gearscore: 6400,
            priority: true,
            note: 'Can flex',
          },
        ],
      },
    ],
  };

  const html = templates.render('admin_signup_presets.html', {
    owners: [owner],
    presetCount: 1,
    active_guild_name: 'Citadel',
  });
  assert.match(html, /Everyone's Signup Presets/);
  assert.match(html, /The Raider/);
  assert.match(html, /Main team/);
  assert.match(html, /Aegis<\/strong>-Icecrown/);
  assert.match(html, /Priority/);
  assert.match(html, /Can flex/);

  const emptyHtml = templates.render('admin_signup_presets.html', {
    owners: [],
    presetCount: 0,
    active_guild_name: 'Citadel',
  });
  assert.match(emptyHtml, /Nobody has saved a signup preset/);
});

test('Dev Tools links to the everyone presets page only for the developer', () => {
  const templates = nunjucks.configure(path.join(__dirname, '..', 'templates'), {
    autoescape: true,
  });

  const developerHtml = templates.render('base.html', {
    user: { id: '100', is_admin: true },
    dev_user_id: '100',
  });
  assert.match(developerHtml, /href="\/admin\/signup-presets"/);
  assert.match(developerHtml, /Everyone's Presets/);

  const userHtml = templates.render('base.html', {
    user: { id: '200', is_admin: true },
    dev_user_id: '100',
  });
  assert.doesNotMatch(userHtml, /href="\/admin\/signup-presets"/);
});
