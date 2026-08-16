'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { parseSignupSelection } = require('../services/signup');

test('signup selection normalizes IDs, priority, notes, and status', () => {
  const result = parseSignupSelection({
    character_ids: ['7', '7', '9'],
    priority_ids: ['9'],
    note_ids: ['7', '9'],
    note_values: ['  tank if needed ', ''],
    signup_mode: 'tentative',
  });

  assert.deepEqual(result.characterIds, [7, 9]);
  assert.deepEqual([...result.priorityIds], [9]);
  assert.equal(result.notes.get(7), 'tank if needed');
  assert.equal(result.isTentative, true);
});

test('signup rejects empty or unrelated character selections', () => {
  assert.match(parseSignupSelection({}).error, /select at least one/i);
  assert.match(
    parseSignupSelection({ character_ids: ['7'], priority_ids: ['8'] }).error,
    /must be part of the signup/i
  );
});

test('signup enforces the note length limit', () => {
  const result = parseSignupSelection(
    {
      character_ids: ['7'],
      note_ids: ['7'],
      note_values: ['123456'],
    },
    5
  );
  assert.match(result.error, /5 characters or fewer/);
});
