'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const nunjucks = require('nunjucks');

const templates = nunjucks.configure(path.join(__dirname, '..', 'templates'), {
  autoescape: true,
});
templates.addFilter('dateformat', () => 'Tuesday, 18 August 2026 · 17:00 UTC');
templates.addFilter('dateiso', (value) => new Date(value).toISOString());
templates.addFilter('gsformat', (value) => String(value));

function renderRaid(overrides = {}) {
  return templates.render('raid_detail.html', {
    raid: {
      name: 'ICC 8/12',
      raid_instance: 'ICC25',
      date: new Date('2026-08-18T17:00:00Z'),
      description: 'Bring flasks and a positive attitude.',
      status: 'open',
      signup_coming_count: 7,
      signup_tentative_count: 1,
    },
    raid_url: '/raids/50',
    user_char_groups: [
      {
        char_name: 'Puredecay',
        char_class: 'Hunter',
        note: '',
        specs: [
          { id: 1, spec: 'Survival', gearscore: 6516 },
          { id: 2, spec: 'Marksmanship', gearscore: 6500 },
        ],
      },
    ],
    my_signup_map: { 1: { signup_type: 'prio_character' } },
    my_signup_count: 1,
    my_signup_is_tentative: false,
    signup_note_max_length: 500,
    user: { id: '123', username: 'Raider' },
    can_manage: false,
    ...overrides,
  });
}

test('raid signup renders compact character and spec controls', () => {
  const html = renderRaid();

  assert.match(html, /class="character-grid"/);
  assert.match(html, /class="signup-character"/);
  assert.match(html, /class="spec-toggle"/);
  assert.match(html, /Save as confirmed/);
  assert.match(html, /Save as tentative/);
  assert.match(html, /Saved as confirmed/);
  assert.match(html, /Add all specs and characters/);
  assert.match(html, /id="openSignupPresetsBtn"/);
  assert.match(html, /id="signupPresetModal"/);
  assert.match(html, /Time until raid:/);
  assert.match(html, /datetime="2026-08-18T17:00:00\.000Z" data-raid-relative-time/);
  assert.match(html, /Apply selected presets/);
  assert.match(html, /class="btn btn-danger quick-withdraw-btn"/);
  assert.doesNotMatch(html, /<table/);
  assert.doesNotMatch(html, /Your Sign-ups/);
});

test('raid signup never renders officer edit or status controls', () => {
  const html = renderRaid({ can_manage: true });
  assert.doesNotMatch(html, /href="\/raids\/50\/edit/);
  assert.doesNotMatch(html, /action="\/raids\/50\/lock"/);
  assert.doesNotMatch(html, /action="\/raids\/50\/unlock"/);
});

test('raid signup renders useful empty and closed states', () => {
  const emptyHtml = renderRaid({
    user_char_groups: [],
    my_signup_map: {},
    my_signup_count: 0,
  });
  assert.match(emptyHtml, /Add a character before signing up/);
  assert.match(emptyHtml, /Go to your profile/);
  assert.doesNotMatch(emptyHtml, /id="openSignupPresetsBtn"/);

  const closedHtml = renderRaid({
    raid: {
      name: 'ICC 8/12',
      raid_instance: 'ICC25',
      date: new Date('2026-08-18T17:00:00Z'),
      status: 'locked',
      signup_coming_count: 7,
      signup_tentative_count: 1,
    },
  });
  assert.match(closedHtml, /Sign-ups are closed/);
  assert.doesNotMatch(closedHtml, /id="signupForm"/);
});
