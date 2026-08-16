'use strict';

function registerAdminRoutes(router, dependencies) {
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

  // ── Admin: list forms ─────────────────────────────────────────────────────────

  router.get('/', requireAdmin, async (req, res) => {
    const guildId = req.session.active_guild_id;

    const [forms] = await pool.query(
      `SELECT f.*,
            (SELECT COUNT(*) FROM recruitment_applications a WHERE a.form_id = f.id) AS application_count
       FROM recruitment_forms f
      WHERE f.guild_id = ?
      ORDER BY f.created_at DESC`,
      [guildId]
    );

    const baseUrl = process.env.WEB_BASE_URL || 'http://localhost:8000';

    res.render('recruitment_list.html', {
      forms,
      base_url: baseUrl,
      flash: popFlash(req),
      user: currentUser(req),
    });
  });

  // ── Admin: new form ───────────────────────────────────────────────────────────

  router.get('/new', requireAdmin, async (req, res) => {
    res.render('recruitment_form_builder.html', {
      form: null,
      questions: [],
      flash: popFlash(req),
      user: currentUser(req),
    });
  });

  router.post('/new', requireAdmin, async (req, res) => {
    const guildId = req.session.active_guild_id;
    const title = String(req.body.title || '').trim();
    if (!title) {
      req.session.flash = '❌ Form title is required.';
      return res.redirect('/recruitment/new');
    }

    const description = String(req.body.description || '').trim() || null;

    let slug;
    try {
      slug = normaliseSlug(req.body.slug);
    } catch (msg) {
      req.session.flash = msg;
      return res.redirect('/recruitment/new');
    }

    let result;
    try {
      [result] = await pool.query(
        `INSERT INTO recruitment_forms
         (guild_id, title, description, is_active, created_by, slug)
       VALUES (?, ?, ?, 1, ?, ?)`,
        [guildId, title, description, req.session.user_id, slug]
      );
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        req.session.flash = '❌ That slug is already in use. Please choose a different one.';
        return res.redirect('/recruitment/new');
      }
      throw err;
    }
    const formId = result.insertId;

    const questions = parseQuestions(req.body);
    for (const q of questions) {
      await pool.query(
        `INSERT INTO recruitment_questions
         (form_id, question_text, question_type, options, is_required, sort_order,
          default_value, group_key, group_label, is_group_repeatable, col_width)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          formId,
          q.question_text,
          q.question_type,
          q.options,
          q.is_required,
          q.sort_order,
          q.default_value,
          q.group_key,
          q.group_label,
          q.is_group_repeatable,
          q.col_width,
        ]
      );
    }
    res.redirect(`/recruitment/${formId}/applications`);
  });

  // ── Admin: edit form ──────────────────────────────────────────────────────────

  router.get('/:form_id/edit-form', requireAdmin, async (req, res) => {
    const guildId = req.session.active_guild_id;
    const formId = parseInt(req.params.form_id, 10);
    if (!formId) return res.redirect('/recruitment');

    const [[form]] = await pool.query(
      'SELECT * FROM recruitment_forms WHERE id = ? AND guild_id = ?',
      [formId, guildId]
    );
    if (!form) {
      req.session.flash = '❌ Form not found.';
      return res.redirect('/recruitment');
    }

    const [questions] = await pool.query(
      'SELECT * FROM recruitment_questions WHERE form_id = ? ORDER BY sort_order',
      [formId]
    );

    // Pre-process options_parsed so the builder template can render existing option lists
    const questionsForBuilder = questions.map((q) => ({
      ...q,
      options_parsed: q.options ? JSON.parse(q.options) : [],
    }));

    res.render('recruitment_form_builder.html', {
      form,
      questions: questionsForBuilder,
      flash: popFlash(req),
      user: currentUser(req),
    });
  });

  router.post('/:form_id/edit-form', requireAdmin, async (req, res) => {
    const guildId = req.session.active_guild_id;
    const formId = parseInt(req.params.form_id, 10);
    if (!formId) return res.redirect('/recruitment');

    const [[form]] = await pool.query(
      'SELECT id FROM recruitment_forms WHERE id = ? AND guild_id = ?',
      [formId, guildId]
    );
    if (!form) {
      req.session.flash = '❌ Form not found.';
      return res.redirect('/recruitment');
    }

    const title = String(req.body.title || '').trim();
    if (!title) {
      req.session.flash = '❌ Form title is required.';
      return res.redirect(`/recruitment/${formId}/edit-form`);
    }

    const description = String(req.body.description || '').trim() || null;

    let slug;
    try {
      slug = normaliseSlug(req.body.slug);
    } catch (msg) {
      req.session.flash = msg;
      return res.redirect(`/recruitment/${formId}/edit-form`);
    }

    try {
      await pool.query(
        `UPDATE recruitment_forms
          SET title = ?, description = ?, slug = ?
        WHERE id = ?`,
        [title, description, slug, formId]
      );
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        req.session.flash = '❌ That slug is already in use. Please choose a different one.';
        return res.redirect(`/recruitment/${formId}/edit-form`);
      }
      throw err;
    }

    // Replace questions
    await pool.query('DELETE FROM recruitment_questions WHERE form_id = ?', [formId]);
    const questions = parseQuestions(req.body);
    for (const q of questions) {
      await pool.query(
        `INSERT INTO recruitment_questions
         (form_id, question_text, question_type, options, is_required, sort_order,
          default_value, group_key, group_label, is_group_repeatable, col_width)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          formId,
          q.question_text,
          q.question_type,
          q.options,
          q.is_required,
          q.sort_order,
          q.default_value,
          q.group_key,
          q.group_label,
          q.is_group_repeatable,
          q.col_width,
        ]
      );
    }

    req.session.flash = '✅ Form updated.';
    res.redirect(`/recruitment/${formId}/edit-form`);
  });

  // ── Admin: toggle active ──────────────────────────────────────────────────────

  router.post('/:form_id/toggle', requireAdmin, async (req, res) => {
    const guildId = req.session.active_guild_id;
    const formId = parseInt(req.params.form_id, 10);
    if (!formId) return res.redirect('/recruitment');

    await pool.query(
      `UPDATE recruitment_forms
        SET is_active = 1 - is_active
      WHERE id = ? AND guild_id = ?`,
      [formId, guildId]
    );
    res.redirect('/recruitment');
  });

  // ── Admin: applications list ──────────────────────────────────────────────────

  router.get('/:form_id/applications', requireAdmin, async (req, res) => {
    const guildId = req.session.active_guild_id;
    const formId = parseInt(req.params.form_id, 10);
    if (!formId) return res.redirect('/recruitment');

    const [[form]] = await pool.query(
      'SELECT * FROM recruitment_forms WHERE id = ? AND guild_id = ?',
      [formId, guildId]
    );
    if (!form) {
      req.session.flash = '❌ Form not found.';
      return res.redirect('/recruitment');
    }

    const statusFilter = req.query.status || 'all';
    let query =
      'SELECT * FROM recruitment_applications WHERE form_id = ? ORDER BY submitted_at DESC';
    let params = [formId];

    if (['pending', 'accepted', 'rejected'].includes(statusFilter)) {
      query =
        'SELECT * FROM recruitment_applications WHERE form_id = ? AND status = ? ORDER BY submitted_at DESC';
      params = [formId, statusFilter];
    }

    const [applications] = await pool.query(query, params);

    res.render('recruitment_applications.html', {
      form,
      applications,
      status_filter: statusFilter,
      flash: popFlash(req),
      user: currentUser(req),
    });
  });

  // ── Admin: view single application ────────────────────────────────────────────

  router.get('/:form_id/applications/:app_id', requireAdmin, async (req, res) => {
    const guildId = req.session.active_guild_id;
    const formId = parseInt(req.params.form_id, 10);
    const appId = parseInt(req.params.app_id, 10);
    if (!formId || !appId) return res.redirect('/recruitment');

    const [[form]] = await pool.query(
      'SELECT * FROM recruitment_forms WHERE id = ? AND guild_id = ?',
      [formId, guildId]
    );
    if (!form) {
      req.session.flash = '❌ Form not found.';
      return res.redirect('/recruitment');
    }

    const [[application]] = await pool.query(
      'SELECT * FROM recruitment_applications WHERE id = ? AND form_id = ?',
      [appId, formId]
    );
    if (!application) {
      req.session.flash = '❌ Application not found.';
      return res.redirect(`/recruitment/${formId}/applications`);
    }

    const [questions] = await pool.query(
      'SELECT * FROM recruitment_questions WHERE form_id = ? ORDER BY sort_order',
      [formId]
    );

    const [answers] = await pool.query(
      'SELECT * FROM recruitment_answers WHERE application_id = ?',
      [appId]
    );

    // Build Q&A pairs; format JSON-array answers (repeatable groups) as readable lists.
    // For 'characters' type, resolve IDs to character names.
    const answerMap = {};
    for (const a of answers) answerMap[String(a.question_id)] = a.answer_text;

    // Pre-fetch characters referenced by any 'characters' type answer
    const allCharIds = [];
    for (const q of questions) {
      if (q.question_type !== 'characters') continue;
      const raw = answerMap[String(q.id)] || '[]';
      try {
        const ids = JSON.parse(raw);
        if (Array.isArray(ids))
          allCharIds.push(...ids.map((id) => parseInt(id)).filter((id) => !isNaN(id)));
      } catch {
        /* ignore */
      }
    }
    const charsById = {};
    if (allCharIds.length > 0) {
      const placeholders = allCharIds.map(() => '?').join(',');
      const [charRows] = await pool.query(
        `SELECT id, char_name, char_class, spec, gearscore FROM characters WHERE id IN (${placeholders}) AND guild_id = ? AND is_deleted = 0`,
        [...allCharIds, form.guild_id]
      );
      for (const c of charRows) charsById[c.id] = c;
    }

    const qa = questions.map((q) => {
      const raw = answerMap[String(q.id)] || '';
      let answer = raw;
      if (q.question_type === 'characters') {
        try {
          const ids = JSON.parse(raw || '[]');
          if (Array.isArray(ids) && ids.length > 0) {
            answer = ids
              .map((id) => {
                const c = charsById[id];
                if (!c) return `#${id}`;
                let s = c.char_name;
                if (c.char_class) s += ` (${c.char_class}`;
                if (c.spec) s += `/${c.spec}`;
                if (c.gearscore)
                  s += ` – ${c.gearscore >= BIS_GS ? 'BiS' : Math.floor(c.gearscore)} GS`;
                if (c.char_class) s += ')';
                return s;
              })
              .join(', ');
          } else {
            answer = '(no characters selected)';
          }
        } catch {
          answer = raw;
        }
      } else if (raw.startsWith('[')) {
        try {
          const arr = JSON.parse(raw);
          if (Array.isArray(arr)) {
            // If it's a 2D array (repeatable group with checkboxes), flatten or join specially
            if (arr.length > 0 && Array.isArray(arr[0])) {
              answer = arr.map((sub) => sub.join(', ')).join(' | ');
            } else {
              answer = arr.join(', ');
            }
          }
        } catch {
          /* keep raw */
        }
      }
      return { question: q.question_text, answer };
    });

    res.render('recruitment_application_detail.html', {
      form,
      application,
      qa,
      flash: popFlash(req),
      user: currentUser(req),
    });
  });

  // ── Admin: accept application ─────────────────────────────────────────────────

  router.post('/:form_id/applications/:app_id/accept', requireAdmin, async (req, res) => {
    const guildId = req.session.active_guild_id;
    const formId = parseInt(req.params.form_id, 10);
    const appId = parseInt(req.params.app_id, 10);
    if (!formId || !appId) return res.redirect('/recruitment');

    const [[form]] = await pool.query(
      'SELECT * FROM recruitment_forms WHERE id = ? AND guild_id = ?',
      [formId, guildId]
    );
    const [[application]] = await pool.query(
      'SELECT * FROM recruitment_applications WHERE id = ? AND form_id = ?',
      [appId, formId]
    );

    if (!form || !application) {
      req.session.flash = '❌ Application not found.';
      return res.redirect(`/recruitment/${formId}/applications`);
    }

    await pool.query(
      `UPDATE recruitment_applications
        SET status = 'accepted', reviewed_by = ?, reviewed_at = NOW()
      WHERE id = ?`,
      [req.session.user_id, appId]
    );

    // Send acceptance DM and notification channel ping
    const guildName = req.session.active_guild_name || 'the guild';
    const acceptMsg = `🎉 Congratulations, **${application.applicant_display_name}**! Your application to **${guildName}** has been **accepted**. Welcome aboard!`;
    const dmResult = await sendDiscordDM(application.applicant_discord_id, acceptMsg);
    if (!dmResult.ok) {
      console.warn('[recruitment] Failed to send acceptance DM:', dmResult.reason);
    }
    const pingResult = await sendNotificationChannelPing(
      application.applicant_discord_id,
      acceptMsg
    );
    if (!pingResult.ok) {
      console.warn('[recruitment] Failed to send acceptance channel ping:', pingResult.reason);
    }

    req.session.flash = `✅ Application from ${application.applicant_display_name} accepted.`;
    res.redirect(`/recruitment/${formId}/applications`);
  });

  // ── Admin: reject application ─────────────────────────────────────────────────

  router.post('/:form_id/applications/:app_id/reject', requireAdmin, async (req, res) => {
    const guildId = req.session.active_guild_id;
    const formId = parseInt(req.params.form_id, 10);
    const appId = parseInt(req.params.app_id, 10);
    if (!formId || !appId) return res.redirect('/recruitment');

    const [[form]] = await pool.query(
      'SELECT id FROM recruitment_forms WHERE id = ? AND guild_id = ?',
      [formId, guildId]
    );
    const [[application]] = await pool.query(
      'SELECT * FROM recruitment_applications WHERE id = ? AND form_id = ?',
      [appId, formId]
    );

    if (!form || !application) {
      req.session.flash = '❌ Application not found.';
      return res.redirect(`/recruitment/${formId}/applications`);
    }

    await pool.query(
      `UPDATE recruitment_applications
        SET status = 'rejected', reviewed_by = ?, reviewed_at = NOW()
      WHERE id = ?`,
      [req.session.user_id, appId]
    );

    // Send rejection DM and notification channel ping
    const guildName = req.session.active_guild_name || 'the guild';
    const rejectMsg = `Thank you for your interest in **${guildName}**. After reviewing your application, we have decided not to proceed at this time. We wish you the best!`;
    const dmResult = await sendDiscordDM(application.applicant_discord_id, rejectMsg);
    if (!dmResult.ok) {
      console.warn('[recruitment] Failed to send rejection DM:', dmResult.reason);
    }
    const pingResult = await sendNotificationChannelPing(
      application.applicant_discord_id,
      rejectMsg
    );
    if (!pingResult.ok) {
      console.warn('[recruitment] Failed to send rejection channel ping:', pingResult.reason);
    }

    req.session.flash = `Application from ${application.applicant_display_name} rejected.`;
    res.redirect(`/recruitment/${formId}/applications`);
  });
}

module.exports = registerAdminRoutes;
