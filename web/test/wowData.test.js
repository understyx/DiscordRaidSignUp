'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const WOW_DATA = require('../../shared/wow.json');
const { getRoleFromSpec } = require('../routes/helpers');

test('shared WoW data has canonical class/spec role mappings', () => {
  assert.equal(Object.keys(WOW_DATA.classes).length, 10);
  assert.equal(WOW_DATA.classes.Druid.specs['Feral (Bear)'].role, 'tank');
  assert.equal(getRoleFromSpec('pally', 'holy'), 'healer');
  assert.equal(getRoleFromSpec('death knight', 'unholy'), 'dps');
});
