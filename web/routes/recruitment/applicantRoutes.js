'use strict';

function registerApplicantRoutes(router, dependencies) {
  const {
    BIS_GS,
    DISCORD_API,
    DISCORD_OAUTH_URL,
    DISCORD_TOKEN_URL,
    DISCORD_USER_URL,
    NOTIFY_CHANNEL_ID,
    NOTIFY_GUILD_ID,
    NOTIFY_INVITE_URL,
    buildExistingGroupInstances,
    buildQuestionBlocks,
    currentUser,
    express,
    normaliseSlug,
    parseGS,
    parseQuestions,
    pool,
    popFlash,
    redirectToRecruitmentOAuth,
    requireAdmin,
    resolveFormParam,
    sendDiscordDM,
    sendNotificationChannelPing,
  } = dependencies;

  // ── Recruitment applicant: register a character ───────────────────────────────
  // Used by the 'characters' question type in the apply form.
  // Requires a valid recruitment OAuth session (recruit_discord_id).

  router.post('/characters/register', express.json(), async (req, res) => {
    if (!req.session.recruit_discord_id) {
      return res
        .status(401)
        .json({ error: 'Not authenticated. Please reload the page and try again.' });
    }

    const userId = req.session.recruit_discord_id;
    const charName = (req.body.char_name || '').trim();
    const realm = (req.body.realm || 'Icecrown').trim();
    const charClass = (req.body.char_class || '').trim() || null;
    const spec = (req.body.spec || '').trim() || null;
    const gearscore = parseGS(req.body.gearscore);

    if (!charName) {
      return res.status(400).json({ error: 'Character name is required.' });
    }

    const charNameCap = charName.charAt(0).toUpperCase() + charName.slice(1).toLowerCase();
    const realmCap = realm.charAt(0).toUpperCase() + realm.slice(1).toLowerCase();
    const specNorm = spec || null;

    const guildId = req.session.recruit_guild_id || null;

    const [[existing]] = await pool.query(
      `SELECT id FROM characters
     WHERE discord_user_id = ? AND guild_id <=> ? AND char_name = ? AND realm = ?
       AND (spec <=> ?)
     LIMIT 1`,
      [userId, guildId, charNameCap, realmCap, specNorm]
    );

    let charId;
    if (existing) {
      await pool.query(
        'UPDATE characters SET char_class = ?, gearscore = ?, is_deleted = 0, last_updated = NOW() WHERE id = ? AND guild_id <=> ?',
        [charClass, gearscore, existing.id, guildId]
      );
      charId = existing.id;
    } else {
      const [result] = await pool.query(
        `INSERT INTO characters (discord_user_id, guild_id, char_name, realm, char_class, spec, gearscore, is_deleted, last_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, NOW())`,
        [userId, guildId, charNameCap, realmCap, charClass, specNorm, gearscore]
      );
      charId = result.insertId;
    }

    const [[char]] = await pool.query(
      'SELECT id, char_name, realm, char_class, spec, gearscore FROM characters WHERE id = ? AND guild_id <=> ?',
      [charId, guildId]
    );

    return res.json({ ok: true, character: char });
  });

  // ── Recruitment applicant: update character name ──────────────────────────────
  router.post('/characters/:char_id/update-name', express.json(), async (req, res) => {
    if (!req.session.recruit_discord_id) {
      return res.status(401).json({ error: 'Not authenticated.' });
    }

    const userId = req.session.recruit_discord_id;
    const guildId = req.session.recruit_guild_id || null;
    const charId = parseInt(req.params.char_id);
    const newName = (req.body.char_name || '').trim();

    if (!newName) {
      return res.status(400).json({ error: 'Character name is required.' });
    }

    const [[char]] = await pool.query(
      'SELECT id, char_name FROM characters WHERE id = ? AND discord_user_id = ? AND guild_id <=> ? AND is_deleted = 0',
      [charId, userId, guildId]
    );

    if (!char) {
      return res.status(404).json({ error: 'Character not found.' });
    }

    const nameCap = newName.charAt(0).toUpperCase() + newName.slice(1).toLowerCase();

    await pool.query(
      'UPDATE characters SET char_name = ?, last_updated = NOW() WHERE char_name = ? AND discord_user_id = ? AND guild_id <=> ? AND is_deleted = 0',
      [nameCap, char.char_name, userId, guildId]
    );

    return res.json({ ok: true });
  });

  // ── Recruitment applicant: update character realm ─────────────────────────────
  router.post('/characters/:char_id/update-realm', express.json(), async (req, res) => {
    if (!req.session.recruit_discord_id) {
      return res.status(401).json({ error: 'Not authenticated.' });
    }

    const userId = req.session.recruit_discord_id;
    const guildId = req.session.recruit_guild_id || null;
    const charId = parseInt(req.params.char_id);
    const realm = (req.body.realm || 'Icecrown').trim();

    const [[char]] = await pool.query(
      'SELECT id, char_name FROM characters WHERE id = ? AND discord_user_id = ? AND guild_id <=> ? AND is_deleted = 0',
      [charId, userId, guildId]
    );

    if (!char) {
      return res.status(404).json({ error: 'Character not found.' });
    }

    const realmCap = realm.charAt(0).toUpperCase() + realm.slice(1).toLowerCase();

    await pool.query(
      'UPDATE characters SET realm = ?, last_updated = NOW() WHERE char_name = ? AND discord_user_id = ? AND guild_id <=> ? AND is_deleted = 0',
      [realmCap, char.char_name, userId, guildId]
    );

    return res.json({ ok: true });
  });

  // ── Recruitment applicant: update character class ─────────────────────────────
  router.post('/characters/:char_id/update-class', express.json(), async (req, res) => {
    if (!req.session.recruit_discord_id) {
      return res.status(401).json({ error: 'Not authenticated.' });
    }

    const userId = req.session.recruit_discord_id;
    const guildId = req.session.recruit_guild_id || null;
    const charId = parseInt(req.params.char_id);
    const charClass = (req.body.char_class || '').trim() || null;

    const [[char]] = await pool.query(
      'SELECT id, char_name FROM characters WHERE id = ? AND discord_user_id = ? AND guild_id <=> ? AND is_deleted = 0',
      [charId, userId, guildId]
    );

    if (!char) {
      return res.status(404).json({ error: 'Character not found.' });
    }

    await pool.query(
      'UPDATE characters SET char_class = ?, last_updated = NOW() WHERE char_name = ? AND discord_user_id = ? AND guild_id <=> ? AND is_deleted = 0',
      [charClass, char.char_name, userId, guildId]
    );

    return res.json({ ok: true });
  });

  // ── Recruitment applicant: update character spec ──────────────────────────────
  router.post('/characters/:char_id/update-spec', express.json(), async (req, res) => {
    if (!req.session.recruit_discord_id) {
      return res.status(401).json({ error: 'Not authenticated.' });
    }

    const userId = req.session.recruit_discord_id;
    const guildId = req.session.recruit_guild_id || null;
    const charId = parseInt(req.params.char_id);
    const spec = (req.body.spec || '').trim() || null;

    const [[char]] = await pool.query(
      'SELECT id FROM characters WHERE id = ? AND discord_user_id = ? AND guild_id <=> ? AND is_deleted = 0',
      [charId, userId, guildId]
    );

    if (!char) {
      return res.status(404).json({ error: 'Character not found.' });
    }

    await pool.query(
      'UPDATE characters SET spec = ?, last_updated = NOW() WHERE id = ? AND guild_id <=> ?',
      [spec, charId, guildId]
    );

    return res.json({ ok: true });
  });

  // ── Recruitment applicant: update character gearscore ────────────────────────
  router.post('/characters/:char_id/update-gs', express.json(), async (req, res) => {
    if (!req.session.recruit_discord_id) {
      return res.status(401).json({ error: 'Not authenticated.' });
    }

    const userId = req.session.recruit_discord_id;
    const guildId = req.session.recruit_guild_id || null;
    const charId = parseInt(req.params.char_id);
    const gearscore = parseGS(req.body.gearscore);

    const [[char]] = await pool.query(
      'SELECT id FROM characters WHERE id = ? AND discord_user_id = ? AND guild_id <=> ? AND is_deleted = 0',
      [charId, userId, guildId]
    );

    if (!char) {
      return res.status(404).json({ error: 'Character not found.' });
    }

    await pool.query(
      'UPDATE characters SET gearscore = ?, last_updated = NOW() WHERE id = ? AND guild_id <=> ?',
      [gearscore, charId, guildId]
    );

    return res.json({ ok: true });
  });

  // ── Recruitment applicant: delete (soft-delete) a character spec ──────────────
  router.post('/characters/:char_id/delete', express.json(), async (req, res) => {
    if (!req.session.recruit_discord_id) {
      return res.status(401).json({ error: 'Not authenticated.' });
    }

    const userId = req.session.recruit_discord_id;
    const guildId = req.session.recruit_guild_id || null;
    const charId = parseInt(req.params.char_id);

    const [[char]] = await pool.query(
      'SELECT id FROM characters WHERE id = ? AND discord_user_id = ? AND guild_id <=> ? AND is_deleted = 0',
      [charId, userId, guildId]
    );

    if (!char) {
      return res.status(404).json({ error: 'Character not found.' });
    }

    await pool.query('UPDATE characters SET is_deleted = 1 WHERE id = ? AND guild_id <=> ?', [
      charId,
      guildId,
    ]);

    return res.json({ ok: true });
  });

  // ── OAuth callback (must be before /:form_id) ─────────────────────────────────

  router.get('/oauth-callback', async (req, res) => {
    const { code, state } = req.query;

    if (!code) {
      req.session.flash = '❌ Discord authorisation failed.';
      return res.redirect('/');
    }

    const expectedState = req.session.recruit_oauth_state;
    delete req.session.recruit_oauth_state;

    if (!expectedState || state !== expectedState) {
      req.session.flash = '❌ Invalid OAuth state. Please try again.';
      return res.redirect('/');
    }

    const redirectUri =
      process.env.RECRUITMENT_DISCORD_REDIRECT_URI ||
      `${process.env.WEB_BASE_URL || 'http://localhost:8000'}/recruitment/oauth-callback`;

    try {
      const tokenRes = await fetch(DISCORD_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: process.env.DISCORD_CLIENT_ID || '',
          client_secret: process.env.DISCORD_CLIENT_SECRET || '',
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
        }),
      });

      if (!tokenRes.ok) {
        req.session.flash = '❌ Failed to exchange Discord token.';
        return res.redirect('/');
      }

      const tokenData = await tokenRes.json();
      const accessToken = tokenData.access_token;

      const userRes = await fetch(DISCORD_USER_URL, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!userRes.ok) {
        req.session.flash = '❌ Failed to fetch Discord user info.';
        return res.redirect('/');
      }
      const userData = await userRes.json();

      // Store recruit session data
      req.session.recruit_discord_id = userData.id;
      req.session.recruit_username = userData.username;
      req.session.recruit_display_name = userData.global_name || userData.username;

      const returnFormId = req.session.recruit_return_form_id || null;
      delete req.session.recruit_return_form_id;

      if (returnFormId) {
        return res.redirect(`/recruitment/${returnFormId}`);
      }
      return res.redirect('/');
    } catch (err) {
      console.error('[recruitment] OAuth callback error:', err);
      req.session.flash = '❌ An error occurred during Discord login. Please try again.';
      return res.redirect('/');
    }
  });
}

module.exports = registerApplicantRoutes;
