const express = require('express');
const pool = require('../db');
const { requireAdmin, popFlash, currentUser, parseGS, getRoleFromSpec } = require('./helpers');

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
    roleName: topRole ? topRole.name : null,
    roleColor: colorRole ? colorRole.colorHex : null,
  };
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
    const [resp, rolesResp] = await Promise.all([
      fetch(`${DISCORD_API}/guilds/${guildId}/members?limit=1000`, { headers }),
      fetch(`${DISCORD_API}/guilds/${guildId}/roles`, { headers }),
    ]);

    if (!resp.ok) {
      throw new Error(`Discord API error: ${resp.status} ${resp.statusText}`);
    }

    const members = (await resp.json()).filter((member) => member.user && !member.user.bot);
    const discordRoles = rolesResp.ok ? await rolesResp.json() : [];
    if (!rolesResp.ok) {
      console.warn(
        `[guild-characters] Discord API ${rolesResp.status} fetching roles for guild ${guildId}`
      );
    }

    const rolesById = new Map();
    const rolesByName = new Map();
    for (const role of discordRoles) {
      if (String(role.id) === String(guildId)) continue;
      const details = {
        id: String(role.id),
        name: role.name,
        position: Number(role.position) || 0,
        colorHex: role.color ? `#${Number(role.color).toString(16).padStart(6, '0')}` : null,
      };
      rolesById.set(details.id, details);
      const existing = rolesByName.get(details.name);
      if (!existing || details.position > existing.position) rolesByName.set(details.name, details);
    }

    // Refresh the durable identity cache while Discord still supplies nicknames.
    await cacheDiscordMembers(members);

    // 2. Include current Discord members plus cached character owners who have left the guild.
    const [countRows] = await pool.query(
      `SELECT c.discord_user_id,
              COUNT(DISTINCT CONCAT(c.char_name, '|', c.realm)) AS character_count,
              MAX(c.discord_role) AS discord_role,
              du.username,
              du.display_name
       FROM characters c
       LEFT JOIN discord_users du ON du.discord_user_id = c.discord_user_id
       WHERE c.guild_id = ? AND c.is_deleted = 0
       GROUP BY c.discord_user_id, du.username, du.display_name`,
      [guildId]
    );
    const characterOwners = new Map(countRows.map((row) => [String(row.discord_user_id), row]));
    const currentMemberIds = new Set(members.map((member) => String(member.user.id)));
    const compareDisplayNames = (a, b) =>
      a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' });

    const currentUsers = members
      .map((member) => {
        const userId = String(member.user.id);
        const cachedCharacters = characterOwners.get(userId);
        return {
          userId,
          username: member.user.username || userId,
          displayName: member.nick || member.user.global_name || member.user.username || userId,
          characterCount: Number(cachedCharacters?.character_count) || 0,
          isFormer: false,
          ...discordRoleDetails(member, rolesById),
        };
      })
      .sort(compareDisplayNames);

    const formerUsers = countRows
      .filter((row) => !currentMemberIds.has(String(row.discord_user_id)))
      .map((row) => {
        const userId = String(row.discord_user_id);
        const lastRole = row.discord_role ? rolesByName.get(row.discord_role) : null;
        return {
          userId,
          username: row.username || userId,
          displayName: row.display_name || row.username || userId,
          characterCount: Number(row.character_count) || 0,
          roleName: row.discord_role || null,
          roleColor: lastRole?.colorHex || null,
          isFormer: true,
        };
      })
      .sort(compareDisplayNames);
    const users = [...currentUsers, ...formerUsers];

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

    res.render('guild_characters.html', {
      users,
      selectedUser,
      activeMemberCount: currentUsers.length,
      formerMemberCount: formerUsers.length,
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
