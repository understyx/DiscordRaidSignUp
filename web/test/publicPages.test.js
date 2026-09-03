'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const nunjucks = require('nunjucks');
const {
  buildBotInviteUrl,
  isApexSiteHost,
  isDemoSiteHost,
  publicSiteLinks,
} = require('../server/app');

const templates = nunjucks.configure(path.join(__dirname, '..', 'templates'), { autoescape: true });

test('recognizes public hosts without treating ordinary guilds as public pages', () => {
  assert.equal(isApexSiteHost('raiding.site', 'raiding.site'), true);
  assert.equal(isApexSiteHost('www.raiding.site', 'raiding.site'), true);
  assert.equal(isApexSiteHost('citadel.raiding.site', 'raiding.site'), false);
  assert.equal(isDemoSiteHost('demo.raiding.site', 'raiding.site'), true);
  assert.equal(isDemoSiteHost('citadel.raiding.site', 'raiding.site'), false);
});

test('builds public links and supports a configured Discord bot invite', () => {
  assert.deepEqual(publicSiteLinks('raiding.site'), {
    home: 'https://raiding.site',
    demo: 'https://demo.raiding.site',
    armory: 'https://armory.raiding.site',
  });
  assert.equal(
    buildBotInviteUrl('123', 'https://discord.example/invite'),
    'https://discord.example/invite'
  );
  const generated = new URL(buildBotInviteUrl('123'));
  assert.equal(generated.hostname, 'discord.com');
  assert.equal(generated.searchParams.get('client_id'), '123');
  assert.match(generated.searchParams.get('scope'), /applications\.commands/);
});

test('landing page links to the armory, demo, Discord login, and bot invite', () => {
  const html = templates.render('landing.html', {
    links: publicSiteLinks('raiding.site'),
    bot_invite_url: 'https://discord.com/oauth2/authorize?client_id=123',
  });
  assert.match(html, /href="https:\/\/armory\.raiding\.site"/);
  assert.match(html, /href="https:\/\/demo\.raiding\.site"/);
  assert.match(html, /href="\/auth\/login"/);
  assert.match(html, /Invite the Discord bot/);
});

test('demo page makes its safe data boundary clear', () => {
  const html = templates.render('demo.html', {
    links: publicSiteLinks('raiding.site'),
    bot_invite_url: null,
  });
  assert.match(html, /No login · no live data/);
  assert.match(html, /nothing here can affect a real guild/);
  assert.match(html, /data-demo-join/);
});
