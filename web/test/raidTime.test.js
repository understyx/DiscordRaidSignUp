'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { formatRaidRelativeTime } = require('../static/js/base');

test('raid countdown formats future times relative to the viewer', () => {
  assert.equal(
    formatRaidRelativeTime('2026-08-18T19:00:00Z', '2026-08-18T17:00:00Z', 'en'),
    'in 2 hours'
  );
  assert.equal(
    formatRaidRelativeTime('2026-08-20T17:00:00Z', '2026-08-18T17:00:00Z', 'en'),
    'in 2 days'
  );
});

test('raid countdown identifies raids that already started', () => {
  assert.equal(
    formatRaidRelativeTime('2026-08-18T14:00:00Z', '2026-08-18T17:00:00Z', 'en'),
    '3 hours ago'
  );
});
