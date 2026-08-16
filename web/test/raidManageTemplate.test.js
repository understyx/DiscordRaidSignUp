'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const nunjucks = require('nunjucks');

test('manage page renders the guarded workflow controls', () => {
  const environment = new nunjucks.Environment(
    new nunjucks.FileSystemLoader(path.join(__dirname, '..', 'templates')),
    { autoescape: true }
  );
  environment.addFilter('gsformat', (value) => String(value || 0));
  environment.addFilter('tojson', (value) => JSON.stringify(value));

  const html = environment.render('raid_manage.html', {
    raid: { id: 1, name: 'Icecrown', status: 'open', max_size: 1 },
    raid_url: '/raids/1',
    can_edit: true,
    comp_meta: { 1: { revision: 2, published_revision: 1, published_at: null } },
    comp_numbers: [1],
    comp_labels: {},
    comp_summaries: { 1: {} },
    current_comp: 1,
    next_comp: 2,
    available_player_count: 0,
    signupsByUser: [],
    slots: ['slot_1'],
    slot_role_map: { slot_1: 'dps' },
    comp_map: {},
    comp_character_map: {},
    comp_status_map: {},
    signup_by_char_id: {},
    player_placeholder_map: {},
    placeholder_map: {},
    chars_in_comps: {},
    char_collectors: {},
    max_size: 1,
    wotlk_buffs: [],
    emojis: {},
    user: { id: '1' },
  });

  assert.match(html, /Review &amp; Publish/);
  assert.match(html, /Changed since publish/);
  assert.match(html, /Save now/);
  assert.match(html, /Merge into empty or placeholder slots/);
  assert.match(html, /aria-live="polite"/);
});
