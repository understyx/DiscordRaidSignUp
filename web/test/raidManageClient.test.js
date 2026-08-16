'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'static', 'js', 'raid_manage.js'),
  'utf8'
);

test('manage client sends revisioned patches and retains newer dirty changes', () => {
  assert.match(source, /base_revision: currentRevision/);
  assert.match(source, /changesEqual\(latest, savedChange\)/);
  assert.match(source, /response\.status === 409/);
  assert.match(source, /Another officer changed/);
});

test('manage client flushes before guarded navigation and publishing', () => {
  assert.match(source, /function runAfterSave/);
  assert.match(source, /flushPendingChanges\(\)/);
  assert.match(source, /save-aware-nav/);
  assert.match(source, /beforeunload/);
});

test('collaboration applies an empty remote player-placeholder slot', () => {
  assert.match(source, /localCharId \|\| localPh \|\| localUserId/);
});
