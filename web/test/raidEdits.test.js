'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const nunjucks = require('nunjucks');

const { normalizeRaidEditInput, formatRaidDateInput } = require('../services/raidEdits');

test('raid edit input is normalized as an explicit UTC database value', () => {
  const result = normalizeRaidEditInput({
    name: '  Thursday ICC  ',
    raid_instance: ' ICC 25 ',
    date: '2026-08-20T18:30',
    description: ' Bring flasks. ',
    max_size: '25',
  });

  assert.deepEqual(result, {
    values: {
      name: 'Thursday ICC',
      raidInstance: 'ICC 25',
      description: 'Bring flasks.',
      dateSql: '2026-08-20 18:30:00',
      maxSize: 25,
    },
  });
});

test('raid edit input rejects impossible dates and invalid raid sizes', () => {
  const base = {
    name: 'ICC',
    raid_instance: 'ICC 25',
    date: '2026-08-20T18:30',
    description: '',
    max_size: '25',
  };

  assert.match(normalizeRaidEditInput({ ...base, date: '2026-02-30T18:30' }).error, /valid/);
  assert.match(normalizeRaidEditInput({ ...base, max_size: '0' }).error, /between 1 and 100/);
  assert.match(
    normalizeRaidEditInput({ ...base, max_size: '25players' }).error,
    /between 1 and 100/
  );
});

test('raid dates are formatted for a datetime-local UTC field', () => {
  assert.equal(formatRaidDateInput(new Date('2026-08-20T18:30:00Z')), '2026-08-20T18:30');
});

test('officer edit form is prefilled and posts back to the scoped raid URL', () => {
  const templates = nunjucks.configure(path.join(__dirname, '..', 'templates'), {
    autoescape: true,
  });
  const html = templates.render('edit_raid.html', {
    raid: {
      name: 'Thursday ICC',
      raid_instance: 'ICC 25',
      description: 'Bring flasks',
      max_size: 25,
    },
    raid_url: '/raids/12',
    date_value: '2026-08-20T18:30',
    user: { id: '1', is_admin: true },
  });

  assert.match(html, /action="\/raids\/12\/edit"/);
  assert.match(html, /value="Thursday ICC"/);
  assert.match(html, /value="2026-08-20T18:30"/);
  assert.match(html, /Changes also refresh the original Discord raid post/);
});
