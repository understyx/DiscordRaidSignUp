'use strict';

const { setInterval: scheduleInterval } = require('node:timers');
const pool = require('../db');

// Discord snowflakes are unsigned. Negative IDs keep all demo identities
// provably separate from real Discord guilds and users.
const DEFAULT_DEMO_GUILD_ID = '-1';
const DEFAULT_DEMO_USER_ID = '-99';
const DEFAULT_RESET_INTERVAL_MINUTES = 30;

const DEMO_CHARACTER_TEMPLATES = [
  ['Aegis', 'Paladin', 'Protection', 'tank'],
  ['Dawnsong', 'Priest', 'Discipline', 'healer'],
  ['Ashenbolt', 'Mage', 'Fire', 'dps'],
  ['Nightarrow', 'Hunter', 'Marksmanship', 'dps'],
  ['Wildheart', 'Druid', 'Feral (Cat)', 'dps'],
];

const CHARACTER_TEMPLATES = [
  ['Aegis', 'Paladin', 'Protection', 'tank'],
  ['Starbloom', 'Druid', 'Restoration', 'healer'],
  ['Ashenbolt', 'Mage', 'Fire', 'dps'],
  ['Runeguard', 'Death Knight', 'Blood', 'tank'],
  ['Dawnsong', 'Priest', 'Discipline', 'healer'],
  ['Stormcall', 'Shaman', 'Restoration', 'healer'],
  ['Nightarrow', 'Hunter', 'Marksmanship', 'dps'],
  ['Emberhex', 'Warlock', 'Demonology', 'dps'],
  ['Ironfist', 'Warrior', 'Fury', 'dps'],
  ['Shade', 'Rogue', 'Combat', 'dps'],
  ['Sunhammer', 'Paladin', 'Holy', 'healer'],
  ['Wildheart', 'Druid', 'Feral (Cat)', 'dps'],
  ['Frostbrand', 'Death Knight', 'Frost', 'dps'],
  ['Arcflash', 'Mage', 'Arcane', 'dps'],
  ['Lightwell', 'Priest', 'Holy', 'healer'],
  ['Earthward', 'Shaman', 'Elemental', 'dps'],
  ['Longshot', 'Hunter', 'Survival', 'dps'],
  ['Soulflame', 'Warlock', 'Affliction', 'dps'],
  ['Bulwark', 'Warrior', 'Protection', 'tank'],
  ['Backstab', 'Rogue', 'Assassination', 'dps'],
  ['Moonfall', 'Druid', 'Balance', 'dps'],
  ['Judgement', 'Paladin', 'Retribution', 'dps'],
  ['Gravewind', 'Death Knight', 'Unholy', 'dps'],
  ['Chainlight', 'Shaman', 'Enhancement', 'dps'],
  ['Spellweave', 'Mage', 'Fire', 'dps'],
  ['Shadowmend', 'Priest', 'Shadow', 'dps'],
  ['Beastfang', 'Hunter', 'Beast Mastery', 'dps'],
  ['Felheart', 'Warlock', 'Destruction', 'dps'],
];

const PLAYER_NAMES = [
  'Arden',
  'Brakka',
  'Cinder',
  'Dorian',
  'Elowen',
  'Fenric',
  'Garran',
  'Hesper',
  'Isolde',
  'Joren',
  'Kaelis',
  'Liora',
  'Marek',
  'Neris',
  'Orin',
  'Phaedra',
  'Quill',
  'Riven',
  'Sylas',
  'Tamsin',
  'Ulric',
  'Vesper',
  'Wren',
  'Xara',
  'Yorick',
  'Zephan',
  'Aster',
  'Bram',
  'Corin',
  'Delia',
  'Eamon',
  'Freya',
  'Galen',
  'Helia',
  'Ivar',
  'Juno',
];

const RAID_TEMPLATES = [
  ['Icecrown Citadel 25', 'ICC25', 25, 2, 18],
  ['Ruby Sanctum 25', 'RS25', 25, 5, 0],
  ['Trial of the Grand Crusader', 'TOC25', 25, 8, 23],
];

const MELEE_SPECS = new Set([
  'Assassination',
  'Blood',
  'Combat',
  'Enhancement',
  'Feral (Cat)',
  'Frost',
  'Fury',
  'Retribution',
  'Unholy',
]);

function normalizeHostname(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
}

function isDemoHostname(hostname, baseDomain) {
  const domain = normalizeHostname(baseDomain);
  return Boolean(domain && normalizeHostname(hostname) === `demo.${domain}`);
}

function isDemoGuildId(guildId, env = process.env) {
  const config = demoConfig(env);
  return config.enabled && String(guildId || '') === config.guildId;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function demoConfig(env = process.env) {
  const baseDomain = normalizeHostname(env.BASE_DOMAIN);
  return {
    enabled: env.DEMO_GUILD_ENABLED !== 'false' && Boolean(baseDomain),
    baseDomain,
    guildId: String(env.DEMO_GUILD_ID || DEFAULT_DEMO_GUILD_ID),
    guildName: String(env.DEMO_GUILD_NAME || 'Demo Guild'),
    resetIntervalMinutes: positiveInteger(
      env.DEMO_RESET_INTERVAL_MINUTES,
      DEFAULT_RESET_INTERVAL_MINUTES
    ),
    userId: DEFAULT_DEMO_USER_ID,
    username: 'Demo Raider',
  };
}

function applyDemoSession(session, onDemoHost, config) {
  if (config.enabled && onDemoHost) {
    session.user_id = config.userId;
    session.username = config.username;
    session.is_admin = true;
    session.is_demo_session = true;
    session.active_guild_id = config.guildId;
    session.active_guild_name = config.guildName;
    session.user_guild_ids = [config.guildId];
    session.available_guilds = [{ guild_id: config.guildId, guild_name: config.guildName }];
    return true;
  }

  if (session.is_demo_session) {
    delete session.user_id;
    delete session.username;
    delete session.is_admin;
    delete session.is_demo_session;
    delete session.active_guild_id;
    delete session.active_guild_name;
    delete session.user_guild_ids;
    delete session.available_guilds;
  }
  return false;
}

function randomInt(min, max, random = Math.random) {
  return Math.floor(random() * (max - min + 1)) + min;
}

function shuffle(values, random = Math.random) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function buildDemoSeed(config, { now = new Date(), random = Math.random } = {}) {
  const demoCharacters = DEMO_CHARACTER_TEMPLATES.map(([name, charClass, spec, role]) => ({
    userId: config.userId,
    username: config.username,
    name,
    charClass,
    spec,
    role,
    gearscore: randomInt(6100, 6550, random),
  }));

  const shuffledPlayers = shuffle(PLAYER_NAMES, random);
  const shuffledTemplates = shuffle(CHARACTER_TEMPLATES, random);
  const fakeCharacters = shuffledPlayers.flatMap((username, index) => {
    const userId = String(-100n - BigInt(index));
    const templates = [shuffledTemplates[index % shuffledTemplates.length]];
    // A handful of players have an alt so the signup pool demonstrates the
    // same multi-character choices real raiders see.
    if (index % 6 === 0) {
      templates.push(shuffledTemplates[(index + 9) % shuffledTemplates.length]);
    }
    return templates.map(([baseName, charClass, spec, role], characterIndex) => ({
      userId,
      username,
      name: `${baseName}${randomInt(10, 99, random)}${characterIndex ? 'a' : ''}`,
      charClass,
      spec,
      role,
      gearscore: randomInt(5700, 6500, random),
    }));
  });

  const characters = [...demoCharacters, ...fakeCharacters];

  const raids = RAID_TEMPLATES.map(
    ([name, instance, maxSize, daysAhead, compositionSize], index) => ({
      guildRaidNumber: index + 1,
      name,
      instance,
      maxSize,
      compositionSize,
      date: new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000),
      description: index === 0 ? 'Heroic progression. Flasks and food ready before pull.' : '',
    })
  );

  return { characters, raids };
}

function compositionRole(character) {
  if (character.role !== 'dps') return character.role;
  return MELEE_SPECS.has(character.spec) ? 'mdps' : 'rdps';
}

async function deleteIds(connection, table, column, ids) {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(', ');
  await connection.query(`DELETE FROM ${table} WHERE ${column} IN (${placeholders})`, ids);
}

async function resetDemoGuildData(database = pool, config = demoConfig()) {
  if (!config.enabled) return null;

  const seed = buildDemoSeed(config);
  const connection = await database.getConnection();
  try {
    await connection.beginTransaction();

    await connection.query(
      "UPDATE bot_guilds SET subdomain = NULL WHERE subdomain = 'demo' AND guild_id <> ?",
      [config.guildId]
    );
    await connection.query(
      `INSERT INTO bot_guilds (guild_id, guild_name, icon, subdomain)
       VALUES (?, ?, NULL, 'demo')
       ON DUPLICATE KEY UPDATE guild_name = VALUES(guild_name), icon = NULL, subdomain = 'demo'`,
      [config.guildId, config.guildName]
    );
    await connection.query(
      `INSERT INTO guild_settings
        (guild_id, signup_restriction, signup_role_id, embed_title, embed_description,
         embed_image_url, embed_color, weekly_reset_weekday, weekly_reset_time,
         weekly_reset_timezone)
       VALUES (?, 'all', NULL, NULL, NULL, NULL, NULL, 3, '09:00:00', 'Europe/Berlin')
       ON DUPLICATE KEY UPDATE
         signup_restriction = 'all', signup_role_id = NULL, embed_title = NULL,
         embed_description = NULL, embed_image_url = NULL, embed_color = NULL,
         weekly_reset_weekday = 3, weekly_reset_time = '09:00:00',
         weekly_reset_timezone = 'Europe/Berlin'`,
      [config.guildId]
    );

    const [raidRows] = await connection.query('SELECT id FROM raids WHERE guild_id = ?', [
      config.guildId,
    ]);
    const raidIds = raidRows.map((row) => row.id);
    await deleteIds(connection, 'compositions', 'raid_id', raidIds);
    await deleteIds(connection, 'signups', 'raid_id', raidIds);
    await deleteIds(connection, 'comp_labels', 'raid_id', raidIds);
    await deleteIds(connection, 'composition_meta', 'raid_id', raidIds);
    await deleteIds(connection, 'raid_log_messages', 'raid_id', raidIds);
    await deleteIds(connection, 'raids', 'id', raidIds);

    const [characterRows] = await connection.query('SELECT id FROM characters WHERE guild_id = ?', [
      config.guildId,
    ]);
    const characterIds = characterRows.map((row) => row.id);
    await deleteIds(connection, 'char_raid_saves', 'character_id', characterIds);
    await deleteIds(connection, 'character_suggestions', 'character_id', characterIds);
    await deleteIds(connection, 'characters', 'id', characterIds);

    const [formRows] = await connection.query(
      'SELECT id FROM recruitment_forms WHERE guild_id = ?',
      [config.guildId]
    );
    const formIds = formRows.map((row) => row.id);
    const [applicationRows] = await connection.query(
      'SELECT id FROM recruitment_applications WHERE guild_id = ?',
      [config.guildId]
    );
    const applicationIds = applicationRows.map((row) => row.id);
    const [questionRows] = formIds.length
      ? await connection.query(
          `SELECT id FROM recruitment_questions WHERE form_id IN (${formIds.map(() => '?').join(', ')})`,
          formIds
        )
      : [[]];
    await deleteIds(connection, 'recruitment_answers', 'application_id', applicationIds);
    await deleteIds(
      connection,
      'recruitment_answers',
      'question_id',
      questionRows.map((row) => row.id)
    );
    await deleteIds(connection, 'recruitment_applications', 'id', applicationIds);
    await deleteIds(connection, 'recruitment_questions', 'form_id', formIds);
    await deleteIds(connection, 'recruitment_forms', 'id', formIds);
    await connection.query('DELETE FROM recruitment_oauth_tokens WHERE guild_id = ?', [
      config.guildId,
    ]);

    const [jobRows] = await connection.query(
      'SELECT id FROM bulk_message_jobs WHERE guild_id = ?',
      [config.guildId]
    );
    const jobIds = jobRows.map((row) => row.id);
    await deleteIds(connection, 'bulk_message_recipients', 'job_id', jobIds);
    await deleteIds(connection, 'bulk_message_jobs', 'id', jobIds);

    for (const table of [
      'guild_admin_roles',
      'guild_signup_roles',
      'guild_character_ranks',
      'guild_player_notes',
      'placeholder_presets',
      'signup_presets',
    ]) {
      await connection.query(`DELETE FROM ${table} WHERE guild_id = ?`, [config.guildId]);
    }
    await connection.query('DELETE FROM discord_users WHERE discord_user_id BETWEEN -999 AND -99');

    const users = new Map(
      seed.characters.map((character) => [character.userId, character.username])
    );
    for (const [userId, username] of users) {
      await connection.query(
        `INSERT INTO discord_users (discord_user_id, username, display_name, updated_at)
         VALUES (?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE username = VALUES(username), display_name = VALUES(display_name), updated_at = NOW()`,
        [userId, username.replaceAll(' ', '').toLowerCase(), username]
      );
    }

    const insertedCharacters = [];
    for (const character of seed.characters) {
      const [result] = await connection.query(
        `INSERT INTO characters
          (discord_user_id, char_name, realm, role, char_class, spec, gearscore,
           last_updated, is_deleted, guild_id, prof_1, prof_2, membership_status, discord_role)
         VALUES (?, ?, 'Icecrown', ?, ?, ?, ?, NOW(), 0, ?, 'Engineering', 'Jewelcrafting', 'active', 'Raider')`,
        [
          character.userId,
          character.name,
          character.role,
          character.charClass,
          character.spec,
          character.gearscore,
          config.guildId,
        ]
      );
      insertedCharacters.push({ ...character, id: result.insertId });
    }

    for (const raidData of seed.raids) {
      const [raidResult] = await connection.query(
        `INSERT INTO raids
          (guild_id, guild_raid_number, name, date, description, raid_instance,
           max_size, status, created_by, discord_message_id, discord_channel_id, discord_log_thread_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, NULL, NULL, NULL)`,
        [
          config.guildId,
          raidData.guildRaidNumber,
          raidData.name,
          raidData.date,
          raidData.description,
          raidData.instance,
          raidData.maxSize,
          config.userId,
        ]
      );
      const raidId = raidResult.insertId;
      const demoCharacters = insertedCharacters.filter(
        (character) => character.userId === config.userId
      );
      const fakeCharacters = insertedCharacters.filter(
        (character) => character.userId !== config.userId
      );
      const guaranteedRoleMix = [
        ...shuffle(
          fakeCharacters.filter((character) => character.role === 'tank'),
          Math.random
        ).slice(0, 2),
        ...shuffle(
          fakeCharacters.filter((character) => character.role === 'healer'),
          Math.random
        ).slice(0, 6),
        ...shuffle(
          fakeCharacters.filter((character) => character.role === 'dps'),
          Math.random
        ).slice(0, 24),
      ];
      const selectedIds = new Set(guaranteedRoleMix.map((character) => character.id));
      const targetFakeSignups = randomInt(32, 36);
      const extraCharacters = shuffle(
        fakeCharacters.filter((character) => !selectedIds.has(character.id)),
        Math.random
      ).slice(0, Math.max(0, targetFakeSignups - guaranteedRoleMix.length));
      const signupPool = [...demoCharacters, ...guaranteedRoleMix, ...extraCharacters];
      const signedCharacters = [
        ...new Map(signupPool.map((character) => [character.id, character])).values(),
      ];

      for (const [index, character] of signedCharacters.entries()) {
        await connection.query(
          `INSERT INTO signups
            (raid_id, discord_user_id, character_id, signup_type, status, is_saved, note, created_at)
           VALUES (?, ?, ?, 'fill', ?, 0, NULL, NOW())`,
          [
            raidId,
            character.userId,
            character.id,
            index >= signedCharacters.length - 3 ? 'tentative' : 'signed',
          ]
        );
      }

      await connection.query(
        'INSERT INTO composition_meta (raid_id, comp_number, revision) VALUES (?, 1, 0)',
        [raidId]
      );
      const confirmedCharacters = signedCharacters.slice(0, -3);
      const roster = [
        ...confirmedCharacters.filter((character) => character.role === 'tank').slice(0, 2),
        ...confirmedCharacters.filter((character) => character.role === 'healer').slice(0, 5),
        ...confirmedCharacters.filter((character) => character.role === 'dps').slice(0, 16),
      ].slice(0, raidData.compositionSize);
      for (const [index, character] of roster.entries()) {
        await connection.query(
          `INSERT INTO compositions
            (raid_id, character_id, role_slot, slot_role, comp_number, created_by, created_at)
           VALUES (?, ?, ?, ?, 1, ?, NOW())`,
          [raidId, character.id, `slot_${index + 1}`, compositionRole(character), config.userId]
        );
      }
    }

    await connection.commit();
    return { characters: seed.characters.length, raids: seed.raids.length };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function startDemoGuildReset({
  database = pool,
  config = demoConfig(),
  logger = console,
  setIntervalFn = scheduleInterval,
} = {}) {
  if (!config.enabled) return null;
  let running = false;

  async function runReset() {
    if (running) return;
    running = true;
    try {
      const result = await resetDemoGuildData(database, config);
      logger.log(
        `[demo-reset] Rebuilt ${result.raids} raids and ${result.characters} characters for ${config.guildName}.`
      );
    } catch (error) {
      logger.error('[demo-reset] Failed to rebuild demo data:', error.message || error);
    } finally {
      running = false;
    }
  }

  await runReset();
  const timer = setIntervalFn(runReset, config.resetIntervalMinutes * 60 * 1000);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

module.exports = {
  applyDemoSession,
  buildDemoSeed,
  demoConfig,
  isDemoGuildId,
  isDemoHostname,
  resetDemoGuildData,
  startDemoGuildReset,
};
