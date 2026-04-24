let qCount = 0;
const questionsContainer = document.getElementById('questionsContainer');
if (questionsContainer && questionsContainer.dataset.initialCount) {
  qCount = parseInt(questionsContainer.dataset.initialCount, 10);
}

function syncHidden(checkbox) {
  checkbox.previousElementSibling.value = checkbox.checked ? 'on' : 'off';
}

function toggleGroupSettings(btn) {
  const row = btn.closest('.question-row');
  const gs  = row.querySelector('.group-settings');
  gs.classList.toggle('d-none');
  btn.textContent = gs.classList.contains('d-none') ? '⚙ Group settings' : '⚙ Hide group';
}

function addQuestion() {
  const container = document.getElementById('questionsContainer');
  const idx = qCount++;
  const row = document.createElement('div');
  row.className = 'question-row mt-3';
  row.id = 'q_row_' + idx;
  row.innerHTML = `
    <div class="d-flex justify-content-between align-items-start mb-2">
      <span class="fw-semibold text-muted small q-number-label">Question ${container.querySelectorAll('.question-row').length + 1}</span>
      <div class="d-flex gap-1">
        <button type="button" class="btn btn-xs btn-outline-secondary" onclick="moveQuestion(this, -1)" title="Move Up">↑</button>
        <button type="button" class="btn btn-xs btn-outline-secondary" onclick="moveQuestion(this, 1)" title="Move Down">↓</button>
        <button type="button" class="btn btn-sm btn-outline-danger ms-2" onclick="removeQuestion(this)">✕</button>
      </div>
    </div>
    <div class="row g-2 mb-2">
      <div class="col-md-6 q-text-wrap">
        <input type="text" class="form-control" name="q_text[]" placeholder="Question text" required>
      </div>
      <div class="col-md-3">
        <select class="form-select q-type-select" name="q_type[]" onchange="toggleOptions(this)">
          <option value="text">Short text</option>
          <option value="textarea">Long text</option>
          <option value="select">Dropdown (select)</option>
          <option value="radio">Multiple choice (radio)</option>
          <option value="checkbox">Checkboxes (multiple)</option>
          <option value="characters">Characters (linked)</option>
          <option value="header">Section Header</option>
          <option value="separator">Separator (line)</option>
        </select>
      </div>
      <div class="col-md-3 col-width-wrap">
        <select class="form-select" name="q_col_width[]" title="Column width in the apply form">
          <option value="full">Full width</option>
          <option value="half">Half (2-col)</option>
          <option value="third">Third (3-col)</option>
        </select>
      </div>
    </div>
    <div class="options-group mb-2">
      <label class="form-label small text-muted">Options (one per line)</label>
      <textarea class="form-control form-control-sm" name="q_options[]" rows="3"
                placeholder="Option 1\nOption 2\nOption 3"></textarea>
    </div>
    <div class="mb-2 default-val-wrap">
      <input type="text" class="form-control form-control-sm" name="q_default[]"
             placeholder="Default / prefill value for applicants (optional)">
    </div>
    <div class="d-flex align-items-center gap-3 flex-wrap mb-1 footer-actions">
      <div class="form-check mb-0 req-wrap">
        <input type="hidden" name="q_required[]" value="off">
        <input class="form-check-input" type="checkbox" id="req_${idx}" value="on"
               onchange="syncHidden(this)">
        <label class="form-check-label small" for="req_${idx}">Required</label>
      </div>
      <button type="button" class="btn btn-sm btn-link p-0 text-muted small group-settings-btn"
              onclick="toggleGroupSettings(this)">⚙ Group settings</button>
    </div>
    <div class="group-settings d-none mt-2 p-2 border border-secondary rounded">
      <div class="row g-2 align-items-end">
        <div class="col-md-3">
          <label class="form-label small text-muted mb-1">Group key</label>
          <input type="text" class="form-control form-control-sm" name="q_group_key[]"
                 placeholder="e.g. alts" pattern="[a-z0-9-]*">
        </div>
        <div class="col-md-5">
          <label class="form-label small text-muted mb-1">Group label</label>
          <input type="text" class="form-control form-control-sm" name="q_group_label[]"
                 placeholder="e.g. Alt characters">
        </div>
        <div class="col-md-4 d-flex align-items-center gap-2 pb-1">
          <input type="hidden" name="q_group_repeatable[]" value="off">
          <input class="form-check-input mt-0" type="checkbox" id="grp_rep_${idx}" value="on"
                 onchange="syncHidden(this)">
          <label class="form-check-label small" for="grp_rep_${idx}">Repeatable</label>
        </div>
      </div>
      <div class="form-text">Questions with the same key are laid out together. "Repeatable" lets applicants add multiple entries.</div>
    </div>
  `;
  container.appendChild(row);
  renumberQuestions();
  updateCharactersAvailability();
}

function removeQuestion(btn) {
  const row = btn.closest('.question-row');
  if (document.querySelectorAll('.question-row').length <= 1) {
    alert('A form must have at least one question.');
    return;
  }
  row.remove();
  renumberQuestions();
  updateCharactersAvailability();
}

function renumberQuestions() {
  const rows = document.querySelectorAll('.question-row');
  rows.forEach((row, i) => {
    const label = row.querySelector('.q-number-label');
    if (label) label.textContent = 'Question ' + (i + 1);
  });
}

function moveQuestion(btn, direction) {
  const row = btn.closest('.question-row');
  const container = row.parentNode;
  if (direction === -1 && row.previousElementSibling) {
    container.insertBefore(row, row.previousElementSibling);
  } else if (direction === 1 && row.nextElementSibling) {
    container.insertBefore(row.nextElementSibling, row);
  }
  renumberQuestions();
}

function toggleOptions(select) {
  const row = select.closest('.question-row');
  const optGroup = row.querySelector('.options-group');
  const defaultWrap = row.querySelector('.default-val-wrap');
  const colWidthWrap = row.querySelector('.col-width-wrap');
  const groupSettingsBtn = row.querySelector('.group-settings-btn');
  const groupSettingsPanel = row.querySelector('.group-settings');
  const reqWrap = row.querySelector('.req-wrap');
  const textInput = row.querySelector('.q-text-wrap input');

  const val = select.value;
  const isChars = val === 'characters';
  const isHeader = val === 'header';
  const isSep = val === 'separator';
  const isLayout = isHeader || isSep;
  const needsOptions = val === 'select' || val === 'radio' || val === 'checkbox';

  if (needsOptions) {
    optGroup.classList.add('visible');
  } else {
    optGroup.classList.remove('visible');
  }

  if (isChars || isLayout) {
    if (defaultWrap) defaultWrap.style.display = 'none';
    if (colWidthWrap) colWidthWrap.style.display = 'none';
    if (groupSettingsBtn) groupSettingsBtn.style.display = 'none';
    if (groupSettingsPanel) groupSettingsPanel.classList.add('d-none');
    if (reqWrap) reqWrap.style.display = 'none';
  } else {
    if (defaultWrap) defaultWrap.style.display = '';
    if (colWidthWrap) colWidthWrap.style.display = '';
    if (groupSettingsBtn) groupSettingsBtn.style.display = '';
    if (reqWrap) reqWrap.style.display = '';
  }

  if (isSep) {
    if (textInput) {
      textInput.required = false;
      textInput.placeholder = '(Optional label for separator)';
    }
  } else {
    if (textInput) {
      textInput.required = true;
      textInput.placeholder = isHeader ? 'Header text' : 'Question text';
    }
  }

  updateCharactersAvailability();
}

/**
 * Only one 'characters' question is allowed per form.
 * When one already exists, disable the 'characters' option in all other rows.
 */
function updateCharactersAvailability() {
  const rows = Array.from(document.querySelectorAll('.question-row'));
  const charsRow = rows.find(r => {
    const sel = r.querySelector('.q-type-select');
    return sel && sel.value === 'characters';
  });

  rows.forEach(row => {
    const sel = row.querySelector('.q-type-select');
    if (!sel) return;
    const opt = sel.querySelector('option[value="characters"]');
    if (!opt) return;
    if (charsRow && row !== charsRow) {
      opt.disabled = true;
      opt.title = 'Only one Characters question is allowed per form';
    } else {
      opt.disabled = false;
      opt.title = '';
    }
  });
}

// Initialise state for questions that are already rendered on page load
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.q-type-select').forEach(sel => toggleOptions(sel));
});
