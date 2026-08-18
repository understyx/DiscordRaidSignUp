'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildCustomMessage,
  buildHelpRaidBotMessage,
  selectBulkRecipients,
  sendDiscordDirectMessage,
  summarizeBulkMessagePayload,
} = require('../services/discordDirectMessages');
const { deliveryNonce } = require('../server/bulkMessageWorker');

test('bulk recipient criteria combine character count and Discord role', () => {
  const members = [
    { user: { id: '1', bot: false }, topRoleId: '10' },
    { user: { id: '2', bot: false }, topRoleId: '20' },
    { user: { id: '3', bot: true }, topRoleId: '10' },
  ];
  const counts = new Map([
    ['1', 0],
    ['2', 2],
  ]);

  assert.deepEqual(
    selectBulkRecipients(members, counts, { characterFilter: 'zero', rankIds: ['10'] }).map(
      (member) => member.user.id
    ),
    ['1']
  );
  assert.deepEqual(
    selectBulkRecipients(members, counts, {
      characterFilter: 'one_or_more',
      rankIds: [],
    }).map((member) => member.user.id),
    ['2']
  );
  assert.deepEqual(
    selectBulkRecipients(members, counts, {
      characterFilter: 'any',
      rankIds: ['10', '20'],
    }).map((member) => member.user.id),
    ['1', '2']
  );
  assert.deepEqual(
    selectBulkRecipients(members, counts, {
      characterFilter: 'specific',
      rankIds: ['20'],
      specificUserId: '1',
    }).map((member) => member.user.id),
    ['1']
  );
});

test('/helpraidbot payload contains an interactive guide and durable guild context', () => {
  const payload = buildHelpRaidBotMessage({
    guildId: '123',
    guildName: 'Citadel',
    webBaseUrl: 'https://raids.example',
  });

  assert.match(payload.embeds[0].footer.text, /Guild ID: 123/);
  assert.equal(payload.components[0].components[0].custom_id, 'helpnoobs:discord');
  assert.equal(
    payload.components[0].components[1].url,
    'https://raids.example/help/add-characters/123'
  );
  assert.equal(payload.components[1].components[0].custom_id, 'helpnoobs:commands');
});

test('custom messages reject empty, oversized, and fake slash-command messages', () => {
  assert.throws(() => buildCustomMessage(''), /Enter a message/);
  assert.throws(() => buildCustomMessage('x'.repeat(2001)), /2000/);
  assert.throws(() => buildCustomMessage('/helpraidbot'), /does not execute slash commands/);
  assert.deepEqual(buildCustomMessage('  Hello guild  '), {
    content: 'Hello guild',
    allowed_mentions: { parse: [] },
  });
});

test('bulk message history recovers the exact text visible to recipients', () => {
  assert.equal(
    summarizeBulkMessagePayload({ content: 'Remember to add your character.' }, 'custom'),
    'Remember to add your character.'
  );
  assert.equal(
    summarizeBulkMessagePayload(
      JSON.stringify({ embeds: [{ title: 'Character guide', description: 'Choose an option.' }] }),
      'helpraidbot'
    ),
    'Character guide\nChoose an option.'
  );
  assert.equal(summarizeBulkMessagePayload('{broken', 'custom'), 'Message unavailable');
});

test('Discord DM delivery creates a channel and posts the supplied payload', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      headers: { get: () => '1' },
      async json() {
        return { id: 'dm-channel' };
      },
    };
  };
  const payload = { content: 'Hello' };

  const result = await sendDiscordDirectMessage('42', payload, {
    botToken: 'token',
    fetchImpl,
    nonce: 'job-recipient-nonce',
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /users\/@me\/channels$/);
  assert.deepEqual(JSON.parse(calls[0].options.body), { recipient_id: '42' });
  assert.match(calls[1].url, /channels\/dm-channel\/messages$/);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    ...payload,
    nonce: 'job-recipient-nonce',
    enforce_nonce: true,
  });
});

test('Discord rate limits are returned to the background queue for retry', async () => {
  const result = await sendDiscordDirectMessage(
    '42',
    { content: 'Hello' },
    {
      botToken: 'token',
      fetchImpl: async () => ({
        ok: false,
        status: 429,
        async json() {
          return { retry_after: 2.5 };
        },
      }),
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
  assert.equal(result.retryAfterMs, 2500);
  assert.equal(result.rateLimited, true);
});

test('delivery nonces are stable, unique, and within Discord limits', () => {
  assert.equal(deliveryNonce('12', '42'), deliveryNonce('12', '42'));
  assert.notEqual(deliveryNonce('12', '42'), deliveryNonce('13', '42'));
  assert.ok(deliveryNonce('12', '42').length <= 25);
});
