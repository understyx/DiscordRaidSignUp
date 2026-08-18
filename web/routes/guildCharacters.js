const express = require('express');
const pool = require('../db');
const { requireAdmin, popFlash, currentUser, parseGS, getRoleFromSpec } = require('./helpers');
const {
  MAX_BULK_RECIPIENTS,
  buildCustomMessage,
  buildHelpRaidBotMessage,
  selectBulkRecipients,
  summarizeBulkMessagePayload,
} = require('../services/discordDirectMessages');
const {
  memberHasGuildCharacterRank,
  parseGuildCharacterRankIds,
  resolveGuildCharacterRankIds,
} = require('../services/guildCharacterRanks');

const router = express.Router();
const DISCORD_API = 'https://discord.com/api/v10';

function guildCharactersUrl(userId) {
  return userId
    ? `/guild-characters?user=${encodeURIComponent(String(userId))}`
    : '/guild-characters';
}

function discordRoleDetails(member, rolesById) {
  const roles = (member.roles || [])
    .map((roleId) => rolesById.get(String(roleId)))
    .filter(Boolean)
    .sort((a, b) => b.position - a.position);
  const topRole = roles[0] || null;
  const colorRole = roles.find((role) => role.colorHex) || topRole;

  return {
    roleId: topRole ? topRole.id : null,
    roleName: topRole ? topRole.name : null,
    roleColor: colorRole ? colorRole.colorHex : null,
  };
}

async function fetchDiscordMembers(guildId, botToken) {
  const headers = { Authorization: `Bot ${botToken}` };
  const members = [];
  let after = null;

  do {
    const params = new URLSearchParams({ limit: '1000' });
    if (after) params.set('after', after);
    const response = await fetch(`${DISCORD_API}/guilds/${guildId}/members?${params}`, { headers });
    if (!response.ok) {
      throw new Error(`Discord API error: ${response.status} ${response.statusText}`);
    }

    const page = await response.json();
    members.push(...page);
    after = page.length === 1000 ? String(page[page.length - 1].user.id) : null;
  } while (after);

  return members.filter((member) => member.user && !member.user.bot);
}

async function cacheDiscordMembers(members) {
  if (!members.length) return;

  const placeholders = members.map(() => '(?, ?, ?, NOW())').join(', ');
  const values = members.flatMap((member) => {
    const username = member.user.username || String(member.user.id);
    return [String(member.user.id), username, member.nick || member.user.global_name || username];
  });

  await pool.query(
    `INSERT INTO discord_users (discord_user_id, username, display_name, updated_at)
     VALUES ${placeholders}
     ON DUPLICATE KEY UPDATE
       username = VALUES(username),
       display_name = VALUES(display_name),
       updated_at = NOW()`,
    values
  );
}

/**
 * Helper: Verify that a specific Discord user is a member of the given guild.
 * Uses the bot token to check membership via Discord API.
 */
async function verifyGuildMembership(guildId, userId) {
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!botToken) return false;

  try {
    const resp = await fetch(`${DISCORD_API}/guilds/${guildId}/members/${userId}`, {
      headers: { Authorization: `Bot ${botToken}` },
    });
    return resp.ok;
  } catch (err) {
    console.error('[verifyGuildMembership] Error:', err);
    return false;
  }
}

router.get('/', async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const guildId = req.session.active_guild_id;
  if (!guildId) {
    req.session.flash = '❌ No active guild selected.';
    return res.redirect('/raids');
  }

  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!botToken) {
    req.session.flash = '❌ Bot token not configured.';
    return res.redirect('/raids');
  }

  try {
    // 1. Fetch guild members and role hierarchy from Discord.
    const headers = { Authorization: `Bot ${botToken}` };
    const [members, rolesResp] = await Promise.all([
      fetchDiscordMembers(guildId, botToken),
      fetch(`${DISCORD_API}/guilds/${guildId}/roles`, { headers }),
    ]);
    const discordRoles = rolesResp.ok ? await rolesResp.json() : [];
    if (!rolesResp.ok) {
      console.warn(
        `[guild-characters] Discord API ${rolesResp.status} fetching roles for guild ${guildId}`
      );
    }

    const rolesById = new Map();
    for (const role of discordRoles) {
      if (String(role.id) === String(guildId)) continue;
      const details = {
        id: String(role.id),
        name: role.name,
        position: Number(role.position) || 0,
        managed: Boolean(role.managed),
        colorHex: role.color ? `#${Number(role.color).toString(16).padStart(6, '0')}` : null,
      };
      rolesById.set(details.id, details);
    }

    const guildCharacterRoles = [...rolesById.values()]
      .filter((role) => !role.managed)
      .sort((a, b) => b.position - a.position);
    const [savedRankRows] = await pool.query(
      'SELECT role_id FROM guild_character_ranks WHERE guild_id = ? ORDER BY role_id',
      [guildId]
    );
    const savedRankIds = savedRankRows.map((row) => String(row.role_id));
    const guildCharacterRankIds = resolveGuildCharacterRankIds(savedRankIds, guildCharacterRoles);

    // Refresh the durable identity cache while Discord still supplies nicknames.
    await cacheDiscordMembers(members);

    // 2. Show current Discord members only. Departed owners keep their stored characters but are
    // omitted from this guild-member view.
    const [countRows] = await pool.query(
      `SELECT c.discord_user_id,
              COUNT(DISTINCT CONCAT(c.char_name, '|', c.realm)) AS character_count
       FROM characters c
       WHERE c.guild_id = ? AND c.is_deleted = 0
       GROUP BY c.discord_user_id`,
      [guildId]
    );
    const characterOwners = new Map(countRows.map((row) => [String(row.discord_user_id), row]));
    const compareDisplayNames = (a, b) =>
      a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' });

    const currentUsers = members
      .filter((member) => memberHasGuildCharacterRank(member, guildCharacterRankIds))
      .map((member) => {
        const userId = String(member.user.id);
        const cachedCharacters = characterOwners.get(userId);
        return {
          userId,
          username: member.user.username || userId,
          displayName: member.nick || member.user.global_name || member.user.username || userId,
          characterCount: Number(cachedCharacters?.character_count) || 0,
          ...discordRoleDetails(member, rolesById),
        };
      })
      .sort(compareDisplayNames);
    const currentMembersById = new Map(members.map((member) => [String(member.user.id), member]));
    const users = currentUsers;

    const requestedUserId = String(req.query.user || '');
    const selectedUser =
      users.find((entry) => entry.userId === requestedUserId) ||
      users.find((entry) => entry.characterCount > 0) ||
      users[0] ||
      null;

    // 3. Load only the selected member's records. Selecting another member loads that view on demand.
    let selectedRows = [];
    if (selectedUser) {
      [selectedRows] = await pool.query(
        `SELECT * FROM characters
         WHERE is_deleted = 0 AND guild_id = ? AND discord_user_id = ?
         ORDER BY char_name ASC, id ASC`,
        [guildId, selectedUser.userId]
      );
    }

    const charGroups = [];
    for (const row of selectedRows) {
      const groupKey = `${row.char_name}|${row.realm}`;
      let group = charGroups.find((entry) => `${entry.name}|${entry.realm}` === groupKey);
      if (!group) {
        group = {
          name: row.char_name,
          realm: row.realm,
          char_class: row.char_class,
          rows: [],
        };
        charGroups.push(group);
      }
      group.rows.push(row);
    }
    if (selectedUser) selectedUser.charGroups = charGroups;

    const [bulkMessageJobs] = await pool.query(
      `SELECT j.id, j.created_by, j.message_action, j.payload_json, j.recipient_count,
              j.sent_count, j.failed_count, j.status, j.created_at, j.started_at,
              j.completed_at, du.username AS creator_username,
              du.display_name AS creator_display_name
       FROM bulk_message_jobs j
       LEFT JOIN discord_users du ON du.discord_user_id = j.created_by
       WHERE j.guild_id = ?
       ORDER BY j.created_at DESC
       LIMIT 5`,
      [guildId]
    );

    const recipientsByJobId = new Map(bulkMessageJobs.map((job) => [String(job.id), []]));
    if (bulkMessageJobs.length) {
      const placeholders = bulkMessageJobs.map(() => '?').join(', ');
      const [recipientRows] = await pool.query(
        `SELECT r.job_id, r.discord_user_id, r.status, r.updated_at,
                du.username, du.display_name
         FROM bulk_message_recipients r
         LEFT JOIN discord_users du ON du.discord_user_id = r.discord_user_id
         WHERE r.job_id IN (${placeholders})`,
        bulkMessageJobs.map((job) => job.id)
      );

      for (const recipient of recipientRows) {
        const userId = String(recipient.discord_user_id);
        const username = recipient.username || userId;
        const guildMember = currentMembersById.get(userId);
        const role = guildMember ? discordRoleDetails(guildMember, rolesById) : null;
        recipientsByJobId.get(String(recipient.job_id))?.push({
          userId,
          username,
          displayName: recipient.display_name || username,
          roleId: role?.roleId || null,
          roleName: guildMember ? role?.roleName || 'No Discord rank' : 'Former member',
          roleColor: role?.roleColor || null,
          rolePosition: role?.roleId ? rolesById.get(role.roleId)?.position || 0 : -1,
          status: recipient.status,
          updatedAt: recipient.updated_at,
        });
      }
    }

    for (const job of bulkMessageJobs) {
      job.messagePreview = summarizeBulkMessagePayload(job.payload_json, job.message_action);
      job.recipients = recipientsByJobId.get(String(job.id)) || [];
      job.recipients.sort((a, b) =>
        a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' })
      );
      const recipientGroupsByRole = new Map();
      for (const recipient of job.recipients) {
        const groupKey = recipient.roleId || `unranked:${recipient.roleName}`;
        if (!recipientGroupsByRole.has(groupKey)) {
          recipientGroupsByRole.set(groupKey, {
            roleName: recipient.roleName,
            roleColor: recipient.roleColor,
            rolePosition: recipient.rolePosition,
            recipients: [],
          });
        }
        recipientGroupsByRole.get(groupKey).recipients.push(recipient);
      }
      job.recipientGroups = [...recipientGroupsByRole.values()].sort(
        (a, b) =>
          b.rolePosition - a.rolePosition ||
          a.roleName.localeCompare(b.roleName, undefined, { sensitivity: 'base' })
      );
      job.creatorName = job.creator_display_name || job.creator_username || String(job.created_by);
    }

    res.render('guild_characters.html', {
      users,
      selectedUser,
      activeMemberCount: currentUsers.length,
      discordMemberCount: members.length,
      excludedMemberCount: members.length - currentUsers.length,
      guildCharacterRoles,
      guildCharacterRankIds,
      guildRankFilterConfigured: savedRankIds.length > 0,
      messagingRoles: [...rolesById.values()].sort((a, b) => b.position - a.position),
      maxBulkRecipients: MAX_BULK_RECIPIENTS,
      bulkMessageJobs,
      guild_name: req.session.active_guild_name,
      flash: popFlash(req),
      user: currentUser(req),
    });
  } catch (err) {
    console.error('[guild-characters] Error:', err);
    req.session.flash = '❌ Failed to load guild characters.';
    res.redirect('/raids');
  }
});

// POST /guild-characters/rank-filter — save one shared roster filter for the guild.
router.post('/rank-filter', express.urlencoded({ extended: false }), async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const guildId = req.session.active_guild_id;
  const botToken = process.env.DISCORD_BOT_TOKEN;
  const returnUrl = guildCharactersUrl(req.body.return_user);
  if (!guildId || !botToken) {
    req.session.flash = '❌ The active guild or bot token is missing.';
    return res.redirect(returnUrl);
  }

  const parsed = parseGuildCharacterRankIds(req.body.rank_ids);
  if (parsed.error || !parsed.roleIds.length) {
    req.session.flash = `❌ ${parsed.error || 'Select at least one rank that counts as a guild member.'}`;
    return res.redirect(returnUrl);
  }

  try {
    const rolesResponse = await fetch(`${DISCORD_API}/guilds/${guildId}/roles`, {
      headers: { Authorization: `Bot ${botToken}` },
    });
    if (!rolesResponse.ok) {
      throw new Error(`Discord API error fetching roles: ${rolesResponse.status}`);
    }

    const roles = await rolesResponse.json();
    const validRoleIds = new Set(
      roles
        .filter((role) => String(role.id) !== String(guildId) && !role.managed)
        .map((role) => String(role.id))
    );
    if (parsed.roleIds.some((roleId) => !validRoleIds.has(roleId))) {
      req.session.flash = '❌ One of those Discord ranks no longer exists or cannot be used.';
      return res.redirect(returnUrl);
    }

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query('SELECT guild_id FROM bot_guilds WHERE guild_id = ? FOR UPDATE', [
        guildId,
      ]);
      await connection.query('DELETE FROM guild_character_ranks WHERE guild_id = ?', [guildId]);
      const placeholders = parsed.roleIds.map(() => '(?, ?)').join(', ');
      const values = parsed.roleIds.flatMap((roleId) => [guildId, roleId]);
      await connection.query(
        `INSERT INTO guild_character_ranks (guild_id, role_id) VALUES ${placeholders}`,
        values
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    req.session.flash = '✅ Guild character ranks saved for every officer.';
  } catch (err) {
    console.error('[guild-characters] Rank filter error:', err);
    req.session.flash = '❌ Failed to save the guild character ranks.';
  }

  res.redirect(returnUrl);
});

// POST /guild-characters/message — DM current guild members matching officer-selected criteria.
router.post('/message', express.urlencoded({ extended: false }), async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const guildId = req.session.active_guild_id;
  const botToken = process.env.DISCORD_BOT_TOKEN;
  const characterFilter = String(req.body.character_filter || 'zero');
  const submittedRankIds = [...new Set([].concat(req.body.rank_ids || []).map(String))].filter(
    Boolean
  );
  const rankIds = characterFilter === 'specific' ? [] : submittedRankIds;
  const specificUserId = String(req.body.specific_user_id || '');
  const messageAction = String(req.body.message_action || 'helpraidbot');

  if (!guildId || !botToken) {
    req.session.flash = '❌ The active guild or bot token is missing.';
    return res.redirect('/guild-characters');
  }
  if (!['any', 'zero', 'one_or_more', 'specific'].includes(characterFilter)) {
    req.session.flash = '❌ Invalid character-count criterion.';
    return res.redirect('/guild-characters');
  }
  if (characterFilter === 'specific' && !/^\d+$/.test(specificUserId)) {
    req.session.flash = '❌ Choose a specific guild member.';
    return res.redirect('/guild-characters');
  }
  if (rankIds.some((rankId) => !/^\d+$/.test(rankId))) {
    req.session.flash = '❌ Invalid Discord rank criterion.';
    return res.redirect('/guild-characters');
  }

  try {
    const headers = { Authorization: `Bot ${botToken}` };
    const [members, rolesResponse, countResult, savedRankResult] = await Promise.all([
      fetchDiscordMembers(guildId, botToken),
      fetch(`${DISCORD_API}/guilds/${guildId}/roles`, { headers }),
      pool.query(
        `SELECT discord_user_id,
                COUNT(DISTINCT CONCAT(char_name, '|', realm)) AS character_count
         FROM characters
         WHERE guild_id = ? AND is_deleted = 0
         GROUP BY discord_user_id`,
        [guildId]
      ),
      pool.query('SELECT role_id FROM guild_character_ranks WHERE guild_id = ?', [guildId]),
    ]);

    if (!rolesResponse.ok) {
      throw new Error(`Discord API error fetching roles: ${rolesResponse.status}`);
    }
    const roles = await rolesResponse.json();
    const guildCharacterRoles = roles.filter(
      (role) => String(role.id) !== String(guildId) && !role.managed
    );
    const guildCharacterRankIds = resolveGuildCharacterRankIds(
      savedRankResult[0].map((row) => String(row.role_id)),
      guildCharacterRoles
    );
    const rolesById = new Map(
      roles
        .filter((role) => String(role.id) !== String(guildId))
        .map((role) => [
          String(role.id),
          { id: String(role.id), position: Number(role.position) || 0 },
        ])
    );
    if (rankIds.some((rankId) => !rolesById.has(rankId))) {
      req.session.flash = '❌ One of those Discord ranks no longer exists.';
      return res.redirect('/guild-characters');
    }

    const rankedMembers = members
      .filter((member) => memberHasGuildCharacterRank(member, guildCharacterRankIds))
      .map((member) => {
        const topRole = (member.roles || [])
          .map((memberRoleId) => rolesById.get(String(memberRoleId)))
          .filter(Boolean)
          .sort((a, b) => b.position - a.position)[0];
        return { ...member, topRoleId: topRole?.id || null };
      });

    const characterCounts = new Map(
      countResult[0].map((row) => [String(row.discord_user_id), Number(row.character_count) || 0])
    );
    const recipients = selectBulkRecipients(rankedMembers, characterCounts, {
      characterFilter,
      rankIds,
      specificUserId,
    });

    if (!recipients.length) {
      req.session.flash = 'ℹ️ No current guild members match those criteria.';
      return res.redirect('/guild-characters');
    }
    if (recipients.length > MAX_BULK_RECIPIENTS) {
      req.session.flash =
        `❌ ${recipients.length} members match. Narrow the criteria to ` +
        `${MAX_BULK_RECIPIENTS} recipients or fewer.`;
      return res.redirect('/guild-characters');
    }

    let payload;
    if (messageAction === 'helpraidbot') {
      payload = buildHelpRaidBotMessage({
        guildId,
        guildName: req.session.active_guild_name,
        webBaseUrl: process.env.WEB_BASE_URL,
      });
    } else if (messageAction === 'custom') {
      payload = buildCustomMessage(req.body.custom_message);
    } else {
      req.session.flash = '❌ Unsupported bot action.';
      return res.redirect('/guild-characters');
    }

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [jobResult] = await connection.query(
        `INSERT INTO bulk_message_jobs
           (guild_id, created_by, message_action, criteria_json, payload_json, recipient_count)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          guildId,
          req.session.user_id,
          messageAction,
          JSON.stringify({
            characterFilter,
            rankIds,
            specificUserId: characterFilter === 'specific' ? specificUserId : null,
          }),
          JSON.stringify(payload),
          recipients.length,
        ]
      );

      const recipientIds = recipients.map((member) => String(member.user.id));
      for (let offset = 0; offset < recipientIds.length; offset += 500) {
        const batch = recipientIds.slice(offset, offset + 500);
        const placeholders = batch.map(() => '(?, ?)').join(', ');
        const values = batch.flatMap((userId) => [jobResult.insertId, userId]);
        await connection.query(
          `INSERT INTO bulk_message_recipients (job_id, discord_user_id)
           VALUES ${placeholders}`,
          values
        );
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    req.session.flash =
      `✅ Queued ${recipients.length} message${recipients.length === 1 ? '' : 's'}. ` +
      'Delivery will continue safely in the background.';
  } catch (err) {
    console.error('[guild-characters] Bulk message error:', err);
    req.session.flash = `❌ ${err.message || 'Failed to send bulk messages.'}`;
  }

  res.redirect('/guild-characters');
});

// POST /guild-characters/update-spec/:char_id
router.post('/update-spec/:char_id', express.urlencoded({ extended: false }), async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const guildId = req.session.active_guild_id;
  const charId = parseInt(req.params.char_id);
  const spec = (req.body.spec || '').trim() || null;

  try {
    const [[char]] = await pool.query(
      'SELECT discord_user_id, char_name, char_class FROM characters WHERE id = ? AND guild_id = ? AND is_deleted = 0',
      [charId, guildId]
    );
    if (!char) {
      req.session.flash = '❌ Character not found.';
      return res.redirect(guildCharactersUrl(req.body.return_user));
    }

    if (!(await verifyGuildMembership(guildId, char.discord_user_id))) {
      req.session.flash = '❌ Permission denied: Character owner is not in this guild.';
      return res.redirect(guildCharactersUrl(req.body.return_user));
    }

    const role = getRoleFromSpec(char.char_class, spec);
    const { fetchUserGuildRoles } = require('./raids/embeds');
    const userGuildRolesMap = await fetchUserGuildRoles(guildId, [char.discord_user_id]);
    const discordRole = userGuildRolesMap[char.discord_user_id] || null;

    await pool.query(
      'UPDATE characters SET spec = ?, role = ?, discord_role = ?, membership_status = "active", last_updated = NOW() WHERE id = ? AND guild_id = ?',
      [spec, role, discordRole, charId, guildId]
    );
    req.session.flash = `✅ Spec updated for ${char.char_name}.`;
  } catch (err) {
    console.error('[guild-characters] Update spec error:', err);
    req.session.flash = '❌ Failed to update spec.';
  }

  res.redirect(guildCharactersUrl(req.body.return_user));
});

// POST /guild-characters/update-name/:char_id
router.post('/update-name/:char_id', express.urlencoded({ extended: false }), async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const guildId = req.session.active_guild_id;
  const charId = parseInt(req.params.char_id);
  const newName = (req.body.char_name || '').trim();

  if (!newName) {
    req.session.flash = '❌ Character name cannot be empty.';
    return res.redirect(guildCharactersUrl(req.body.return_user));
  }

  const newNameCap = newName.charAt(0).toUpperCase() + newName.slice(1).toLowerCase();

  try {
    const [[char]] = await pool.query(
      'SELECT discord_user_id, char_name, realm FROM characters WHERE id = ? AND guild_id = ? AND is_deleted = 0',
      [charId, guildId]
    );
    if (!char) {
      req.session.flash = '❌ Character not found.';
      return res.redirect(guildCharactersUrl(req.body.return_user));
    }

    if (!(await verifyGuildMembership(guildId, char.discord_user_id))) {
      req.session.flash = '❌ Permission denied: Character owner is not in this guild.';
      return res.redirect(guildCharactersUrl(req.body.return_user));
    }

    // Update all specs for this character (matched by user + old name + realm)
    await pool.query(
      'UPDATE characters SET char_name = ?, last_updated = NOW() WHERE discord_user_id = ? AND guild_id = ? AND char_name = ? AND realm = ?',
      [newNameCap, char.discord_user_id, guildId, char.char_name, char.realm]
    );
    req.session.flash = `✅ Character renamed to ${newNameCap}.`;
  } catch (err) {
    console.error('[guild-characters] Update name error:', err);
    req.session.flash = '❌ Failed to update name.';
  }

  res.redirect(guildCharactersUrl(req.body.return_user));
});

// POST /guild-characters/update-gs/:char_id
router.post('/update-gs/:char_id', express.urlencoded({ extended: false }), async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const guildId = req.session.active_guild_id;
  const charId = parseInt(req.params.char_id);
  const gearscore = parseGS(req.body.gearscore);

  try {
    const [[char]] = await pool.query(
      'SELECT discord_user_id, char_name FROM characters WHERE id = ? AND guild_id = ? AND is_deleted = 0',
      [charId, guildId]
    );
    if (!char) {
      req.session.flash = '❌ Character not found.';
      return res.redirect(guildCharactersUrl(req.body.return_user));
    }

    if (!(await verifyGuildMembership(guildId, char.discord_user_id))) {
      req.session.flash = '❌ Permission denied: Character owner is not in this guild.';
      return res.redirect(guildCharactersUrl(req.body.return_user));
    }

    await pool.query(
      'UPDATE characters SET gearscore = ?, last_updated = NOW() WHERE id = ? AND guild_id = ?',
      [gearscore, charId, guildId]
    );
    req.session.flash = `✅ GS updated for ${char.char_name}.`;
  } catch (err) {
    console.error('[guild-characters] Update GS error:', err);
    req.session.flash = '❌ Failed to update GS.';
  }

  res.redirect(guildCharactersUrl(req.body.return_user));
});

// POST /guild-characters/delete/:char_id
router.post('/delete/:char_id', express.urlencoded({ extended: false }), async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const guildId = req.session.active_guild_id;
  const charId = parseInt(req.params.char_id);

  try {
    const [[char]] = await pool.query(
      'SELECT discord_user_id, char_name FROM characters WHERE id = ? AND guild_id = ? AND is_deleted = 0',
      [charId, guildId]
    );
    if (!char) {
      req.session.flash = '❌ Character not found.';
      return res.redirect(guildCharactersUrl(req.body.return_user));
    }

    if (!(await verifyGuildMembership(guildId, char.discord_user_id))) {
      req.session.flash = '❌ Permission denied: Character owner is not in this guild.';
      return res.redirect(guildCharactersUrl(req.body.return_user));
    }

    await pool.query('UPDATE characters SET is_deleted = 1 WHERE id = ? AND guild_id = ?', [
      charId,
      guildId,
    ]);
    req.session.flash = `✅ Character ${char.char_name} hidden.`;
  } catch (err) {
    console.error('[guild-characters] Delete error:', err);
    req.session.flash = '❌ Failed to delete character.';
  }

  res.redirect(guildCharactersUrl(req.body.return_user));
});

// POST /guild-characters/register
router.post('/register', express.urlencoded({ extended: false }), async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const guildId = req.session.active_guild_id;
  const targetUserId = req.body.discord_user_id;
  const charName = (req.body.char_name || '').trim();
  const realm = (req.body.realm || 'Icecrown').trim();
  const charClass = (req.body.char_class || '').trim() || null;
  const spec = (req.body.spec || '').trim() || null;
  const gearscore = parseGS(req.body.gearscore);

  if (!targetUserId || !charName) {
    req.session.flash = '❌ User ID and character name are required.';
    return res.redirect(guildCharactersUrl(targetUserId));
  }

  try {
    if (!(await verifyGuildMembership(guildId, targetUserId))) {
      req.session.flash = '❌ Permission denied: Target user is not in this guild.';
      return res.redirect(guildCharactersUrl(targetUserId));
    }

    const charNameCap = charName.charAt(0).toUpperCase() + charName.slice(1).toLowerCase();
    const realmCap = realm.charAt(0).toUpperCase() + realm.slice(1).toLowerCase();
    const specNorm = spec || null;

    const [[existing]] = await pool.query(
      `SELECT id FROM characters
       WHERE discord_user_id = ? AND guild_id = ? AND char_name = ? AND realm = ?
         AND (spec <=> ?)
       LIMIT 1`,
      [targetUserId, guildId, charNameCap, realmCap, specNorm]
    );

    const role = getRoleFromSpec(charClass, spec);
    const { fetchUserGuildRoles } = require('./raids/embeds');
    const userGuildRolesMap = await fetchUserGuildRoles(guildId, [targetUserId]);
    const discordRole = userGuildRolesMap[targetUserId] || null;

    if (existing) {
      await pool.query(
        'UPDATE characters SET char_class = ?, role = ?, discord_role = ?, membership_status = "active", gearscore = ?, is_deleted = 0, last_updated = NOW() WHERE id = ? AND guild_id = ?',
        [charClass, role, discordRole, gearscore, existing.id, guildId]
      );
    } else {
      await pool.query(
        `INSERT INTO characters (discord_user_id, guild_id, char_name, realm, char_class, spec, role, discord_role, membership_status, gearscore, is_deleted, last_updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, "active", ?, 0, NOW())`,
        [
          targetUserId,
          guildId,
          charNameCap,
          realmCap,
          charClass,
          spec,
          role,
          discordRole,
          gearscore,
        ]
      );
    }

    // If a class was provided, ensure all other specs of this character have the same class
    if (charClass) {
      await pool.query(
        'UPDATE characters SET char_class = ? WHERE discord_user_id = ? AND guild_id = ? AND char_name = ? AND realm = ?',
        [charClass, targetUserId, guildId, charNameCap, realmCap]
      );
    }

    req.session.flash = `✅ Character ${charNameCap} registered for user.`;
  } catch (err) {
    console.error('[guild-characters] Register error:', err);
    req.session.flash = '❌ Failed to register character.';
  }

  res.redirect(guildCharactersUrl(targetUserId));
});

module.exports = router;
