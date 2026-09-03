'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const nunjucks = require('nunjucks');
const { isApexSiteHost, publicSiteLinks } = require('../server/app');

const templates = nunjucks.configure(path.join(__dirname, '..', 'templates'), { autoescape: true });

test('recognizes public hosts without treating ordinary guilds as public pages', () => {
  assert.equal(isApexSiteHost('raiding.site', 'raiding.site'), true);
  assert.equal(isApexSiteHost('www.raiding.site', 'raiding.site'), true);
  assert.equal(isApexSiteHost('citadel.raiding.site', 'raiding.site'), false);
});

test('builds public links', () => {
  assert.deepEqual(publicSiteLinks('raiding.site'), {
    home: 'https://raiding.site',
    demo: 'https://demo.raiding.site',
    armory: 'https://armory.raiding.site',
  });
});

test('landing page contains only the three requested destinations', () => {
  const html = templates.render('landing.html', {
    links: publicSiteLinks('raiding.site'),
  });
  assert.match(html, /href="https:\/\/armory\.raiding\.site"/);
  assert.match(html, /href="https:\/\/demo\.raiding\.site\/raids"/);
  assert.match(html, /href="\/auth\/login"/);
  assert.equal((html.match(/class="btn /g) || []).length, 3);
});
