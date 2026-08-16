'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('guided character page provides the three-step form and completion actions', () => {
  const template = fs.readFileSync(
    path.join(__dirname, '..', 'templates', 'characters.html'),
    'utf8'
  );
  const script = fs.readFileSync(
    path.join(__dirname, '..', 'static', 'js', 'characters.js'),
    'utf8'
  );

  assert.match(template, /Guided character setup/);
  assert.match(template, /data-guide-progress="1"/);
  assert.match(template, /data-guide-progress="2"/);
  assert.match(template, /data-guide-progress="3"/);
  assert.match(template, /name="guided" value="1"/);
  assert.match(template, /✅ Finish/);
  assert.match(script, /WOW_DATA\.classes/);
  assert.match(script, /characterGuideSummary/);
});
