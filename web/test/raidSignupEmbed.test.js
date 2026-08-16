'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildSignupEmbed, signupMessageComponents } = require('../routes/raids/embeds');

test('raid signup embed reflects edited raid details and current signups', () => {
  const embed = buildSignupEmbed(
    {
      id: 9,
      name: 'Edited ICC',
      raid_instance: 'ICC 25 Heroic',
      date: new Date('2026-08-20T18:30:00Z'),
      description: 'Updated instructions',
      status: 'locked',
    },
    [
      {
        discord_user_id: '123',
        status: 'tentative',
        char_name: 'Aegis',
        char_class: 'Paladin',
        spec: 'Holy',
        display_name: 'Guardian',
      },
    ]
  );

  assert.equal(embed.title, '⚔️ Edited ICC');
  assert.equal(embed.description, 'Updated instructions');
  assert.equal(embed.footer.text, 'Raid ID: 9');
  assert.ok(embed.fields.some((field) => field.value === '🔒 Locked'));
  assert.ok(embed.fields.some((field) => /Guardian/.test(field.value)));
});

test('signup controls are removed when locked and restored when open', () => {
  assert.deepEqual(signupMessageComponents(false), []);
  const rows = signupMessageComponents(true);
  assert.equal(rows.length, 3);
  assert.ok(rows[0].components.some((button) => button.custom_id === 'signup:multi'));
  assert.ok(rows[2].components.some((button) => button.custom_id === 'signup:edit_notes'));
});
