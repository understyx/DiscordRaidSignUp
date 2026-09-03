'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const nunjucks = require('nunjucks');
const { buildBotInviteUrl, isApexSiteHost, publicSiteLinks } = require('../server/app');

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

test('builds or accepts a Discord bot invite URL', () => {
  assert.equal(
    buildBotInviteUrl('123', 'https://discord.example/invite'),
    'https://discord.example/invite'
  );
  const generated = new URL(buildBotInviteUrl('123'));
  assert.equal(generated.hostname, 'discord.com');
  assert.equal(generated.searchParams.get('client_id'), '123');
  assert.match(generated.searchParams.get('scope'), /applications\.commands/);
});

test('landing page contains only the three requested destinations', () => {
  const html = templates.render('landing.html', {
    links: publicSiteLinks('raiding.site'),
    bot_invite_url: 'https://discord.com/oauth2/authorize?client_id=123',
  });
  assert.match(html, /href="https:\/\/armory\.raiding\.site"/);
  assert.match(html, /href="https:\/\/demo\.raiding\.site\/raids"/);
  assert.match(html, /href="\/auth\/login"/);
  assert.equal((html.match(/<a class="landing-action/g) || []).length, 3);
  assert.match(html, /Invite Discord bot/);
});
