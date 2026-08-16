'use strict';

function registerPublicRoutes(router, dependencies) {
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

  // ── Public: view / start application ─────────────────────────────────────────
  // This must come AFTER all more specific GET routes above.

  router.get('/:form_id', async (req, res) => {
    const form = await resolveFormParam(req.params.form_id, true);
    if (!form) {
      req.session.flash = '❌ This recruitment form is not available.';
      return res.redirect('/');
    }
    const formId = form.id;

    // Require Discord recruitment auth
    if (!req.session.recruit_discord_id) {
      req.session.recruit_return_form_id = formId;
      return redirectToRecruitmentOAuth(req, res, formId);
    }

    // Store the guild context for character registration/updates
    req.session.recruit_guild_id = form.guild_id;

    // Duplicate application guard: pending or accepted → redirect to edit
    const [[existing]] = await pool.query(
      `SELECT id FROM recruitment_applications
      WHERE form_id = ? AND applicant_discord_id = ? AND status IN ('pending','accepted')`,
      [formId, req.session.recruit_discord_id]
    );
    if (existing) {
      req.session.flash =
        '📝 You already have an active application — you can view or edit it below.';
      return res.redirect(`/recruitment/${formId}/edit`);
    }

    const [questions] = await pool.query(
      'SELECT * FROM recruitment_questions WHERE form_id = ? ORDER BY sort_order',
      [formId]
    );

    // Parse options for select/radio questions
    const questionsForTemplate = questions.map((q) => ({
      ...q,
      options_parsed: q.options ? JSON.parse(q.options) : [],
    }));

    const blocks = buildQuestionBlocks(questionsForTemplate);
    // For a new application, all group blocks start with one blank instance
    for (const b of blocks) {
      if (b.type === 'group') b.instances = [{}];
    }

    // Fetch the applicant's registered characters for any 'characters' type questions.
    // All characters are pre-selected by default on a fresh application.
    let applicantCharacters = [];
    const preselectedCharsByQuestion = {};
    const hasCharsQuestion = questionsForTemplate.some((q) => q.question_type === 'characters');
    if (hasCharsQuestion) {
      [applicantCharacters] = await pool.query(
        'SELECT id, char_name, realm, char_class, spec, gearscore FROM characters WHERE discord_user_id = ? AND guild_id = ? AND is_deleted = 0 ORDER BY char_name ASC',
        [req.session.recruit_discord_id, form.guild_id]
      );
      for (const q of questionsForTemplate.filter((q) => q.question_type === 'characters')) {
        preselectedCharsByQuestion[String(q.id)] = applicantCharacters.map((c) => c.id);
      }
    }

    res.render('recruitment_apply.html', {
      form,
      questions: questionsForTemplate,
      blocks,
      recruit_username: req.session.recruit_username,
      recruit_display_name: req.session.recruit_display_name,
      is_editing: false,
      application: null,
      existing_answers: {},
      display_answers: {},
      applicant_characters: applicantCharacters,
      preselected_chars_by_question: preselectedCharsByQuestion,
      flash: popFlash(req),
      user: currentUser(req),
    });
  });

  // ── Public: submit application ────────────────────────────────────────────────

  router.post('/:form_id/submit', async (req, res) => {
    const form = await resolveFormParam(req.params.form_id, true);
    if (!form) {
      req.session.flash = '❌ This recruitment form is not available.';
      return res.redirect('/');
    }
    const formId = form.id;

    if (!req.session.recruit_discord_id) {
      req.session.recruit_return_form_id = formId;
      return redirectToRecruitmentOAuth(req, res, formId);
    }

    // Store the guild context for character registration/updates
    req.session.recruit_guild_id = form.guild_id;

    // Duplicate guard
    const [[existing]] = await pool.query(
      `SELECT id FROM recruitment_applications
      WHERE form_id = ? AND applicant_discord_id = ? AND status IN ('pending','accepted')`,
      [formId, req.session.recruit_discord_id]
    );
    if (existing) {
      req.session.flash =
        '📝 You already have an active application — you can view or edit it below.';
      return res.redirect(`/recruitment/${formId}/edit`);
    }

    const [questions] = await pool.query(
      'SELECT * FROM recruitment_questions WHERE form_id = ? ORDER BY sort_order',
      [formId]
    );

    // Validate required fields
    for (const q of questions) {
      if (q.is_required) {
        if (q.question_type === 'characters') {
          const selected = [].concat(req.body[`char_sel_${q.id}`] || []);
          if (selected.length === 0) {
            req.session.flash = `❌ Please select at least one character for: "${q.question_text}"`;
            return res.redirect(`/recruitment/${formId}`);
          }
        } else if (q.question_type === 'checkbox') {
          const key = q.is_group_repeatable && q.group_key ? `answer_${q.id}_0` : `answer_${q.id}`;
          const selected = [].concat(req.body[key] || []);
          if (selected.filter(Boolean).length === 0) {
            req.session.flash = `❌ Please select at least one option for: "${q.question_text}"`;
            return res.redirect(`/recruitment/${formId}`);
          }
        } else {
          // Repeatable-group questions are indexed; check index 0
          const key = q.is_group_repeatable && q.group_key ? `answer_${q.id}_0` : `answer_${q.id}`;
          const answer = String(req.body[key] || '').trim();
          if (!answer) {
            req.session.flash = `❌ Please answer: "${q.question_text}"`;
            return res.redirect(`/recruitment/${formId}`);
          }
        }
      }
    }

    const [appResult] = await pool.query(
      `INSERT INTO recruitment_applications
       (form_id, guild_id, applicant_discord_id, applicant_username, applicant_display_name,
        status)
     VALUES (?, ?, ?, ?, ?, 'pending')`,
      [
        formId,
        form.guild_id,
        req.session.recruit_discord_id,
        req.session.recruit_username,
        req.session.recruit_display_name,
      ]
    );
    const appId = appResult.insertId;

    for (const q of questions) {
      let answerText;
      if (q.question_type === 'characters') {
        // Store selected character IDs as a JSON array
        const selected = [].concat(req.body[`char_sel_${q.id}`] || []);
        answerText = JSON.stringify(selected.map((id) => parseInt(id)).filter((id) => !isNaN(id)));
      } else if (q.question_type === 'checkbox') {
        if (q.is_group_repeatable && q.group_key) {
          const values = [];
          let idx = 0;
          while (req.body[`answer_${q.id}_${idx}`] !== undefined) {
            const selected = [].concat(req.body[`answer_${q.id}_${idx}`] || []);
            values.push(selected.filter(Boolean));
            idx++;
          }
          answerText = values.length > 0 ? JSON.stringify(values) : '';
        } else {
          const selected = [].concat(req.body[`answer_${q.id}`] || []);
          answerText = JSON.stringify(selected.filter(Boolean));
        }
      } else if (q.is_group_repeatable && q.group_key) {
        // Collect all indexed values and store as JSON array
        const values = [];
        let idx = 0;
        while (req.body[`answer_${q.id}_${idx}`] !== undefined) {
          values.push(String(req.body[`answer_${q.id}_${idx}`] || '').trim());
          idx++;
        }
        answerText = values.length > 0 ? JSON.stringify(values) : '';
      } else {
        answerText = String(req.body[`answer_${q.id}`] || '').trim();
      }
      await pool.query(
        'INSERT INTO recruitment_answers (application_id, question_id, answer_text) VALUES (?, ?, ?)',
        [appId, q.id, answerText]
      );
    }

    req.session.flash = '✅ Your application has been submitted successfully!';
    res.redirect(`/recruitment/${formId}/edit`);
  });

  // ── Public: edit / view own application ───────────────────────────────────────

  router.get('/:form_id/edit', async (req, res) => {
    const form = await resolveFormParam(req.params.form_id);
    if (!form) {
      req.session.flash = '❌ Form not found.';
      return res.redirect('/');
    }
    const formId = form.id;

    if (!req.session.recruit_discord_id) {
      req.session.recruit_return_form_id = formId;
      return redirectToRecruitmentOAuth(req, res, formId);
    }

    // Store the guild context for character registration/updates
    req.session.recruit_guild_id = form.guild_id;

    const [[application]] = await pool.query(
      `SELECT * FROM recruitment_applications
      WHERE form_id = ? AND applicant_discord_id = ?
      ORDER BY submitted_at DESC LIMIT 1`,
      [formId, req.session.recruit_discord_id]
    );

    if (!application) {
      return res.redirect(`/recruitment/${formId}`);
    }

    const [questions] = await pool.query(
      'SELECT * FROM recruitment_questions WHERE form_id = ? ORDER BY sort_order',
      [formId]
    );

    const [answers] = await pool.query(
      'SELECT * FROM recruitment_answers WHERE application_id = ?',
      [application.id]
    );

    const existingAnswers = {};
    for (const a of answers) existingAnswers[String(a.question_id)] = a.answer_text;

    const questionsForTemplate = questions.map((q) => ({
      ...q,
      options_parsed: q.options ? JSON.parse(q.options) : [],
    }));

    const blocks = buildQuestionBlocks(questionsForTemplate);
    const groupInstances = buildExistingGroupInstances(blocks, existingAnswers);
    // Attach instances to group blocks
    for (const b of blocks) {
      if (b.type === 'group') {
        const inst = groupInstances[b.key];
        b.instances = inst && inst.length > 0 ? inst : [{}];
      }
    }

    // Fetch the applicant's registered characters for any 'characters' type questions.
    // Pre-select only the IDs stored in the existing answer (or all if no answer yet).
    let applicantCharacters = [];
    const preselectedCharsByQuestion = {};
    const hasCharsQuestion = questionsForTemplate.some((q) => q.question_type === 'characters');
    if (hasCharsQuestion) {
      [applicantCharacters] = await pool.query(
        'SELECT id, char_name, realm, char_class, spec, gearscore FROM characters WHERE discord_user_id = ? AND guild_id = ? AND is_deleted = 0 ORDER BY char_name ASC',
        [req.session.recruit_discord_id, form.guild_id]
      );
      for (const q of questionsForTemplate.filter((q) => q.question_type === 'characters')) {
        const raw = existingAnswers[String(q.id)];
        if (raw && raw.startsWith('[')) {
          try {
            const ids = JSON.parse(raw);
            preselectedCharsByQuestion[String(q.id)] = Array.isArray(ids)
              ? ids.map((id) => parseInt(id)).filter((id) => !isNaN(id))
              : applicantCharacters.map((c) => c.id);
          } catch {
            preselectedCharsByQuestion[String(q.id)] = applicantCharacters.map((c) => c.id);
          }
        } else {
          preselectedCharsByQuestion[String(q.id)] = applicantCharacters.map((c) => c.id);
        }
      }
    }

    // Build display-friendly answers (format JSON arrays for read-only view).
    // For 'characters' questions, look up names from the DB.
    const charsById = Object.fromEntries(applicantCharacters.map((c) => [c.id, c]));
    const displayAnswers = {};
    for (const [qid, raw] of Object.entries(existingAnswers)) {
      const q = questionsForTemplate.find((qq) => String(qq.id) === qid);
      if (q && q.question_type === 'characters' && raw && raw.startsWith('[')) {
        try {
          const ids = JSON.parse(raw);
          if (Array.isArray(ids) && ids.length > 0) {
            // Fetch full details for any chars not already in applicantCharacters
            const missingIds = ids.filter((id) => !charsById[id]);
            let extraChars = [];
            if (missingIds.length > 0) {
              const placeholders = missingIds.map(() => '?').join(',');
              [extraChars] = await pool.query(
                `SELECT id, char_name, char_class, spec, gearscore FROM characters WHERE id IN (${placeholders}) AND guild_id = ? AND is_deleted = 0`,
                [...missingIds, form.guild_id]
              );
              for (const c of extraChars) charsById[c.id] = c;
            }
            displayAnswers[qid] = ids
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
            displayAnswers[qid] = '(no characters selected)';
          }
        } catch {
          displayAnswers[qid] = raw;
        }
      } else if (raw && raw.startsWith('[')) {
        try {
          const arr = JSON.parse(raw);
          displayAnswers[qid] = Array.isArray(arr) ? arr.join(' | ') : raw;
        } catch {
          displayAnswers[qid] = raw;
        }
      } else {
        displayAnswers[qid] = raw;
      }
    }

    res.render('recruitment_apply.html', {
      form,
      questions: questionsForTemplate,
      blocks,
      recruit_username: req.session.recruit_username,
      recruit_display_name: req.session.recruit_display_name,
      is_editing: true,
      application,
      existing_answers: existingAnswers,
      display_answers: displayAnswers,
      applicant_characters: applicantCharacters,
      preselected_chars_by_question: preselectedCharsByQuestion,
      flash: popFlash(req),
      user: currentUser(req),
    });
  });

  router.post('/:form_id/edit', async (req, res) => {
    const form = await resolveFormParam(req.params.form_id);
    if (!form) return res.redirect('/');
    const formId = form.id;

    if (!req.session.recruit_discord_id) {
      req.session.recruit_return_form_id = formId;
      return redirectToRecruitmentOAuth(req, res, formId);
    }

    // Store the guild context for character registration/updates
    req.session.recruit_guild_id = form.guild_id;

    const [[application]] = await pool.query(
      `SELECT * FROM recruitment_applications
      WHERE form_id = ? AND applicant_discord_id = ? AND status = 'pending'
      ORDER BY submitted_at DESC LIMIT 1`,
      [formId, req.session.recruit_discord_id]
    );

    if (!application) {
      req.session.flash = '❌ No editable application found.';
      return res.redirect(`/recruitment/${formId}/edit`);
    }

    const [questions] = await pool.query(
      'SELECT * FROM recruitment_questions WHERE form_id = ? ORDER BY sort_order',
      [formId]
    );

    // Validate required fields
    for (const q of questions) {
      if (q.is_required) {
        if (q.question_type === 'characters') {
          const selected = [].concat(req.body[`char_sel_${q.id}`] || []);
          if (selected.length === 0) {
            req.session.flash = `❌ Please select at least one character for: "${q.question_text}"`;
            return res.redirect(`/recruitment/${formId}/edit`);
          }
        } else if (q.question_type === 'checkbox') {
          const key = q.is_group_repeatable && q.group_key ? `answer_${q.id}_0` : `answer_${q.id}`;
          const selected = [].concat(req.body[key] || []);
          if (selected.filter(Boolean).length === 0) {
            req.session.flash = `❌ Please select at least one option for: "${q.question_text}"`;
            return res.redirect(`/recruitment/${formId}/edit`);
          }
        } else {
          const key = q.is_group_repeatable && q.group_key ? `answer_${q.id}_0` : `answer_${q.id}`;
          const answer = String(req.body[key] || '').trim();
          if (!answer) {
            req.session.flash = `❌ Please answer: "${q.question_text}"`;
            return res.redirect(`/recruitment/${formId}/edit`);
          }
        }
      }
    }

    // Delete old answers and re-insert
    await pool.query('DELETE FROM recruitment_answers WHERE application_id = ?', [application.id]);
    for (const q of questions) {
      let answerText;
      if (q.question_type === 'characters') {
        const selected = [].concat(req.body[`char_sel_${q.id}`] || []);
        answerText = JSON.stringify(selected.map((id) => parseInt(id)).filter((id) => !isNaN(id)));
      } else if (q.question_type === 'checkbox') {
        if (q.is_group_repeatable && q.group_key) {
          const values = [];
          let idx = 0;
          while (req.body[`answer_${q.id}_${idx}`] !== undefined) {
            const selected = [].concat(req.body[`answer_${q.id}_${idx}`] || []);
            values.push(selected.filter(Boolean));
            idx++;
          }
          answerText = values.length > 0 ? JSON.stringify(values) : '';
        } else {
          const selected = [].concat(req.body[`answer_${q.id}`] || []);
          answerText = JSON.stringify(selected.filter(Boolean));
        }
      } else if (q.is_group_repeatable && q.group_key) {
        const values = [];
        let idx = 0;
        while (req.body[`answer_${q.id}_${idx}`] !== undefined) {
          values.push(String(req.body[`answer_${q.id}_${idx}`] || '').trim());
          idx++;
        }
        answerText = values.length > 0 ? JSON.stringify(values) : '';
      } else {
        answerText = String(req.body[`answer_${q.id}`] || '').trim();
      }
      await pool.query(
        'INSERT INTO recruitment_answers (application_id, question_id, answer_text) VALUES (?, ?, ?)',
        [application.id, q.id, answerText]
      );
    }

    req.session.flash = '✅ Your application has been updated.';
    res.redirect(`/recruitment/${formId}/edit`);
  });
}

module.exports = registerPublicRoutes;
