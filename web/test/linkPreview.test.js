'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const nunjucks = require('nunjucks');

const {
  buildLinkEmbed,
  guildIdFromRaidPath,
  hasCustomEmbed,
  isLinkPreviewRequest,
} = require('../services/linkPreview');

test('recognizes Discord link previews and guild-scoped raid links', () => {
  const request = {
    method: 'GET',
    get(name) {
      return name === 'user-agent' ? 'Mozilla/5.0 Discordbot/2.0' : null;
    },
  };

  assert.equal(isLinkPreviewRequest(request), true);
  assert.equal(
    isLinkPreviewRequest({ method: 'GET', get: () => 'Mozilla/5.0 Chrome/140.0' }),
    false
  );
  assert.equal(guildIdFromRaidPath('/raids/123456789012345678/42'), '123456789012345678');
  assert.equal(guildIdFromRaidPath('/raids/42'), null);
});

test('builds complete guild metadata with useful text fallbacks', () => {
  const embed = buildLinkEmbed(
    {
      guild_name: 'Citadel',
      custom_embed: { title: null, description: null, image_url: null, color: '#abc' },
    },
    'https://citadel.example/raids'
  );

  assert.equal(embed.title, 'Citadel Raids');
  assert.equal(embed.description, 'View upcoming raids and sign up with your characters.');
  assert.equal(embed.color, 'abc');
  assert.equal(embed.url, 'https://citadel.example/raids');
  assert.equal(hasCustomEmbed({ color: 'abc' }), true);
  assert.equal(hasCustomEmbed({}), false);
});

test('link preview response renders Open Graph and Twitter metadata', () => {
  const templates = nunjucks.configure(path.join(__dirname, '..', 'templates'), {
    autoescape: true,
  });
  const html = templates.render('link_preview.html', {
    custom_embed: {
      title: 'Citadel Raids',
      description: 'Choose your next raid',
      image_url: 'https://cdn.example/banner.png',
      color: '5865F2',
      site_name: 'Citadel',
      url: 'https://citadel.example/raids',
    },
  });

  assert.match(html, /property="og:type" content="website"/);
  assert.match(html, /property="og:title" content="Citadel Raids"/);
  assert.match(html, /property="og:url" content="https:\/\/citadel\.example\/raids"/);
  assert.match(html, /name="twitter:card" content="summary_large_image"/);
  assert.match(html, /name="theme-color" content="#5865F2"/);
});

test('guild settings includes the live custom embed preview', () => {
  const templates = nunjucks.configure(path.join(__dirname, '..', 'templates'), {
    autoescape: true,
  });
  const html = templates.render('guild_settings.html', {
    guild_id: '123456789012345678',
    active_guild_name: 'Citadel',
    configured_role_ids: [],
    guild_roles: [],
    guild_roles_map: {},
    weekday_names: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
    settings: {
      signup_restriction: 'all',
      signup_role_id: null,
      signup_role_ids: [],
      embed_title: 'Citadel Raids',
      embed_description: 'Choose your next raid',
      embed_image_url: '',
      embed_color: '5865F2',
      weekly_reset_weekday: 3,
      weekly_reset_time: '09:00',
      weekly_reset_timezone: 'Europe/Berlin',
    },
  });

  assert.match(html, /id="linkEmbedPreview"/);
  assert.match(html, /id="linkEmbedPreviewTitle"/);
  assert.match(html, /href="\/css\/guild_settings\.css"/);
  assert.match(html, /action="\/guild-settings\/weekly-reset"/);
  assert.match(html, /value="3" selected>Wednesday/);
  assert.match(html, /value="Europe\/Berlin"/);
  assert.doesNotMatch(html, /Sync color picker with text input/);
});

test('guild settings renders every selected signup role', () => {
  const templates = nunjucks.configure(path.join(__dirname, '..', 'templates'), {
    autoescape: true,
  });
  const html = templates.render('guild_settings.html', {
    guild_id: '123456789012345678',
    configured_role_ids: [],
    guild_roles: [
      { id: '11', name: 'Tank' },
      { id: '22', name: 'Healer' },
      { id: '33', name: 'DPS' },
    ],
    guild_roles_map: {},
    settings: {
      signup_restriction: 'role',
      signup_role_ids: ['11', '22'],
    },
  });

  assert.match(html, /name="signup_role_ids" value="11"\s+checked/);
  assert.match(html, /name="signup_role_ids" value="22"\s+checked/);
  assert.doesNotMatch(html, /name="signup_role_ids" value="33"\s+checked/);
  assert.match(html, /at least one selected Discord role/);
});
