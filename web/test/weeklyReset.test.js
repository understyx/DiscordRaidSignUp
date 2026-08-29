'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { getWeeklyResetWindow, normalizeWeeklyResetSettings } = require('../services/weeklyReset');

test('uses the Wednesday morning default and observes daylight-saving time', () => {
  const summer = getWeeklyResetWindow('2026-08-29T12:00:00Z');
  assert.equal(summer.start.toISOString(), '2026-08-26T07:00:00.000Z');
  assert.equal(summer.end.toISOString(), '2026-09-02T07:00:00.000Z');

  const winter = getWeeklyResetWindow('2026-01-03T12:00:00Z');
  assert.equal(winter.start.toISOString(), '2025-12-31T08:00:00.000Z');
  assert.equal(winter.end.toISOString(), '2026-01-07T08:00:00.000Z');
});

test('a raid before the reset time belongs to the previous reset window', () => {
  const window = getWeeklyResetWindow('2026-08-26T06:59:00Z');
  assert.equal(window.start.toISOString(), '2026-08-19T07:00:00.000Z');
  assert.equal(window.end.toISOString(), '2026-08-26T07:00:00.000Z');
});

test('calculates both boundaries independently when daylight-saving time changes mid-window', () => {
  const window = getWeeklyResetWindow('2026-03-30T12:00:00Z');
  assert.equal(window.start.toISOString(), '2026-03-25T08:00:00.000Z');
  assert.equal(window.end.toISOString(), '2026-04-01T07:00:00.000Z');
});

test('supports a guild-defined weekday, time, and timezone', () => {
  const window = getWeeklyResetWindow('2026-08-29T12:00:00Z', {
    weekday: 2,
    time: '18:30',
    timezone: 'America/New_York',
  });
  assert.equal(window.start.toISOString(), '2026-08-25T22:30:00.000Z');
  assert.equal(window.end.toISOString(), '2026-09-01T22:30:00.000Z');
});

test('rejects invalid reset settings', () => {
  assert.throws(() => normalizeWeeklyResetSettings({ weekday: 7 }), /weekday/i);
  assert.throws(() => normalizeWeeklyResetSettings({ time: '25:00' }), /time/i);
  assert.throws(
    () => normalizeWeeklyResetSettings({ timezone: 'Somewhere/Imaginary' }),
    /timezone/i
  );
});
