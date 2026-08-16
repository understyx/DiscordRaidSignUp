'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const nunjucks = require('nunjucks');
const { registerFilters } = require('../server/filters');

test('manage page renders the guarded workflow controls', () => {
  const environment = new nunjucks.Environment(
    new nunjucks.FileSystemLoader(path.join(__dirname, '..', 'templates')),
    { autoescape: true }
  );
  registerFilters(environment);
  assert.equal(environment.getFilter('tojson')(undefined), 'null');
  assert.doesNotMatch(environment.getFilter('tojson')('</script>'), /<\/script>/);

  const html = environment.render('raid_manage.html', {
    raid: { id: 1, name: 'Icecrown', status: 'open', max_size: 1 },
    raid_url: '/raids/1',
    can_edit: true,
    comp_meta: { 1: { revision: 2, published_revision: 1, published_at: null } },
    current_meta: { revision: 2, published_revision: 1, published_at: null },
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
    roster_config: {
      CAN_EDIT: true,
      CURRENT_COMP: 1,
      RAID_URL: '/raids/1',
      CURRENT_REVISION: 2,
      PUBLISHED_REVISION: 1,
      MAX_SIZE: 1,
    },
  });

  assert.match(html, /Review &amp; Publish/);
  assert.match(html, /Changed since publish/);
  assert.match(html, /Save now/);
  assert.match(html, /Merge into empty or placeholder slots/);
  assert.match(html, /aria-live="polite"/);
  const configMatch = html.match(
    /<script id="rosterConfig" type="application\/json">\s*([\s\S]*?)\s*<\/script>/
  );
  assert.ok(configMatch);
  const config = JSON.parse(configMatch[1]);
  assert.equal(config.RAID_URL, '/raids/1');
  assert.equal(config.PUBLISHED_REVISION, 1);
});
