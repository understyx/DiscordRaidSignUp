const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const pool = require('../../db');
const { DISCORD_API } = require('./discord');

const EMOJIS = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', '..', 'emojis.json'), 'utf8')
);

async function fetchSpecAliases() {
  const [rows] = await pool.query(
    'SELECT char_class, alias, canonical FROM spec_aliases'
  );
  const map = {};
  for (const { char_class, alias, canonical } of rows) {
    const clsKey = (char_class || '').toLowerCase().trim();
    const aliasKey = (alias || '').toLowerCase().trim();
    if (!map[clsKey]) map[clsKey] = {};
    map[clsKey][aliasKey] = canonical;
  }
  return map;
}

function getCanonicalSpec(charClass, specText, aliasMap) {
  if (!specText) return null;
  const cls = (charClass || '').toLowerCase().replace(/-/g, ' ').trim();
  const firstSpec = specText.split(',')[0].trim();
  const s = firstSpec.toLowerCase();

  const clsMap = aliasMap ? aliasMap[cls] : null;
  if (clsMap) {
    if (clsMap[s]) return clsMap[s];
    for (const [alias, canonical] of Object.entries(clsMap)) {
      if (s.includes(alias)) return canonical;
    }
  }
  return firstSpec.charAt(0).toUpperCase() + firstSpec.slice(1);
}

function getRoleBasedSpec(charClass, role) {
  const cls = (charClass || '').toLowerCase().replace(/-/g, ' ').trim();

  if (role === 'tank') {
    if (cls === 'paladin') return 'Protection';
    if (cls === 'druid') return 'Guardian';
    if (cls === 'warrior') return 'Protection';
    if (cls === 'death knight') return 'Blood';
  } else if (role === 'healer') {
    if (cls === 'paladin') return 'Holy';
    if (cls === 'priest') return 'Holy'; // or Discipline, but Holy is a safe default
    if (cls === 'shaman') return 'Restoration';
    if (cls === 'druid') return 'Restoration';
  }
  return null;
}

async function fetchCompLabels(raidId) {
  const [rows] = await pool.query(
    'SELECT comp_number, label FROM comp_labels WHERE raid_id = ?',
    [raidId]
  );
  const map = {};
  for (const r of rows) map[r.comp_number] = r.label;
  return map;
}

function compTabLabel(compNumber, compLabels) {
  return (compLabels && compLabels[compNumber]) || `Raid ${compNumber}`;
}

/**
 * Fetch the top Discord guild role name for each of the given user IDs.
 * Returns a map of userId (string) → role name (string) | null.
 * Gracefully returns an empty map on any error.
 */
async function fetchUserGuildRoles(guildId, userIds) {
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!guildId || !botToken || !userIds.length) return {};

  try {
    const rolesResp = await fetch(`${DISCORD_API}/guilds/${guildId}/roles`, {
      headers: { Authorization: `Bot ${botToken}` },
    });
    if (!rolesResp.ok) return {};
    const allRoles = await rolesResp.json();
    const roleMap = {};
    for (const r of allRoles) {
      roleMap[r.id] = { name: r.name, position: r.position };
    }

    const memberResults = await Promise.all(
      userIds.map(async userId => {
        try {
          const resp = await fetch(`${DISCORD_API}/guilds/${guildId}/members/${userId}`, {
            headers: { Authorization: `Bot ${botToken}` },
          });
          if (!resp.ok) return [userId, null];
          const member = await resp.json();
          const memberRoleIds = (member.roles || []).filter(rid => rid !== guildId);
          if (!memberRoleIds.length) return [userId, null];
          const topRoleId = memberRoleIds.reduce((best, rid) => {
            const pos = roleMap[rid]?.position ?? -1;
            const bestPos = best !== null ? (roleMap[best]?.position ?? -1) : -Infinity;
            return pos > bestPos ? rid : best;
          }, null);
          return [userId, topRoleId ? (roleMap[topRoleId]?.name || null) : null];
        } catch (_) {
          return [userId, null];
        }
      })
    );

    const result = {};
    for (const [uid, role] of memberResults) result[uid] = role;
    return result;
  } catch (err) {
    console.warn('[manage] Failed to fetch Discord guild roles:', err.message || err);
    return {};
  }
}

/**
 * Collect unique Discord user IDs (in order of appearance) from all role groups.
 */
function collectUniqueUserIds(groups) {
  const seen = new Set();
  const ids = [];
  for (const roleKey of ['tank', 'healer', 'mdps', 'rdps', 'dps']) {
    for (const e of groups[roleKey] || []) {
      const userId = e.is_player_placeholder ? e.discord_user_id : (e.character && e.character.discord_user_id);
      if (userId) {
        const id = String(userId);
        if (!seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      }
    }
  }
  return ids;
}

function buildCompEmbed(raid, groups, compNumber, totalComps, compLabels, specAliasesMap) {
  const label = compTabLabel(compNumber, compLabels);
  const compLabel = totalComps > 1 ? ` – ${label}` : '';
  const unixTs = Math.floor(new Date(raid.date).getTime() / 1000);
  const dateStr = `<t:${unixTs}:F>`;

  const fields = [];

  const roleEmojis = {
    tank: '🛡️',
    healer: '💚',
    mdps: '🗡️',
    rdps: '🏹',
    dps: '⚔️'
  };

  const sections = [
    { label: '🛡️ Tanks', keys: ['tank'] },
    { label: '💚 Healers', keys: ['healer'] },
    { label: '⚔️ DPS', keys: ['mdps', 'rdps', 'dps'] },
  ];

  for (const section of sections) {
    const entries = [];
    for (const key of section.keys) {
      if (groups[key]) entries.push(...groups[key]);
    }

    if (entries.length === 0) continue;

    const lines = entries.map(e => {
      let emoji = roleEmojis[e.slot_role] || '❓';

      if (!e.is_placeholder && !e.is_player_placeholder && e.character) {
        const c = e.character;
        if (c.char_class && EMOJIS[c.char_class]) {
          const classData = EMOJIS[c.char_class];
          let specToLookup = null;

          if (c.spec && classData.specs && classData.specs[c.spec]) {
            specToLookup = c.spec;
          }
          if (!specToLookup) {
            const canonical = getCanonicalSpec(c.char_class, c.spec, specAliasesMap);
            if (canonical && classData.specs && classData.specs[canonical]) {
              specToLookup = canonical;
            }
          }
          if (!specToLookup) {
            const roleBased = getRoleBasedSpec(c.char_class, e.slot_role);
            if (roleBased && classData.specs && classData.specs[roleBased]) {
              specToLookup = roleBased;
            }
          }

          if (specToLookup && classData.specs && classData.specs[specToLookup]) {
            emoji = classData.specs[specToLookup];
          } else if (classData.emoji) {
            emoji = classData.emoji;
          }
        }
      }

      if (e.is_placeholder) {
        const text = e.placeholder_text || '?';
        const startsWithEmoji = /^\p{Emoji}/u.test(text);
        return startsWithEmoji ? `*${text}*` : `${emoji} *${text}*`;
      }
      if (e.is_player_placeholder) {
        const mention = e.discord_user_id ? ` <@${e.discord_user_id}>` : '';
        return `${emoji} **Any Character**${mention}`;
      }
      const c = e.character;
      const mention = c.discord_user_id ? ` <@${c.discord_user_id}>` : '';
      const tentative = c.status === 'tentative' ? ' [:question:]' : '';
      return `${emoji} **${c.char_name}**${mention}${tentative}`;
    });

    // Chunk strings to respect the strict 1024 character value limit per field
    // Chunk strings to respect the strict 1024 character value limit per field
    let currentFieldText = "";
    let chunkIndex = 1;

    for (const line of lines) {
      // Check if appending this line (plus a newline character) breaks the 1024 cap
      if (currentFieldText.length + line.length + 1 > 1024) {
        fields.push({
          // Uses the section label for the first chunk, and a zero-width space for additions
          name: chunkIndex === 1 ? `${section.label} [${entries.length}]` : '\u200b',
          value: currentFieldText || '—',
          inline: false,
        });
        currentFieldText = line;
        chunkIndex++;
      } else {
        currentFieldText = currentFieldText ? `${currentFieldText}\n${line}` : line;
      }
    }

    // Append any leftover lines from the loop execution
    if (currentFieldText) {
      fields.push({
        name: chunkIndex === 1 ? `${section.label} [${entries.length}]` : '\u200b',
        value: currentFieldText,
        inline: false,
      });
    }
  }

  const allIds = collectUniqueUserIds(groups);
  const content = allIds.map(id => `<@${id}>`).join(' ');

  return {
    content: content || undefined,
    embeds: [
      {
        title: `📋 ${raid.name}${compLabel}`,
        description: `**${raid.raid_instance}** | ${dateStr}`,
        color: 0xe6cc80,
        fields,
        footer: { text: `Raid ID: ${raid.id}` },
      },
    ],
  };
}

module.exports = {
  fetchSpecAliases,
  getCanonicalSpec,
  getRoleBasedSpec,
  fetchCompLabels,
  compTabLabel,
  fetchUserGuildRoles,
  collectUniqueUserIds,
  buildCompEmbed,
};