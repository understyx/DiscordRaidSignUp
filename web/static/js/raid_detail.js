function toggleRow(row) {
  row.classList.toggle('row-selected');
  const selected = row.classList.contains('row-selected');
  row.setAttribute('aria-selected', selected ? 'true' : 'false');
  // Deselecting a row also clears its priority star
  if (!selected) {
    const star = row.querySelector('.prio-star');
    if (star) {
      star.classList.remove('prio-active');
      star.setAttribute('aria-pressed', 'false');
    }
  }
  updateGroupHighlight(row.dataset.groupIdx);
  buildHiddenInputs();
}

function toggleGroupRows(groupIdx) {
  const rows = document.querySelectorAll(`.signup-row[data-group-idx="${CSS.escape(groupIdx)}"]`);
  const anySelected = Array.from(rows).some(r => r.classList.contains('row-selected'));
  const shouldSelect = !anySelected;
  rows.forEach(row => {
    row.classList.toggle('row-selected', shouldSelect);
    row.setAttribute('aria-selected', shouldSelect ? 'true' : 'false');
    if (!shouldSelect) {
      const star = row.querySelector('.prio-star');
      if (star) {
        star.classList.remove('prio-active');
        star.setAttribute('aria-pressed', 'false');
      }
    }
  });
  updateGroupHighlight(groupIdx);
  buildHiddenInputs();
}

function updateGroupHighlight(groupIdx) {
  const rows = document.querySelectorAll(`.signup-row[data-group-idx="${CSS.escape(groupIdx)}"]`);
  const anySelected = Array.from(rows).some(r => r.classList.contains('row-selected'));
  const firstRow = rows[0];
  if (firstRow) {
    firstRow.querySelectorAll('.group-cell').forEach(cell => {
      cell.classList.toggle('group-cell-selected', anySelected);
    });
  }
}

function togglePrio(star) {
  star.classList.toggle('prio-active');
  const active = star.classList.contains('prio-active');
  star.setAttribute('aria-pressed', active ? 'true' : 'false');
  // Auto-select the row when marking as priority
  if (active) {
    const row = star.closest('tr.signup-row');
    row.classList.add('row-selected');
    row.setAttribute('aria-selected', 'true');
    updateGroupHighlight(row.dataset.groupIdx);
  }
  buildHiddenInputs();
}

function buildHiddenInputs() {
  const container = document.getElementById('hiddenInputs');
  if (!container) return;
  container.innerHTML = '';
  document.querySelectorAll('.signup-row.row-selected').forEach(row => {
    const charId = row.dataset.charId;
    const inp = document.createElement('input');
    inp.type = 'hidden';
    inp.name = 'character_ids';
    inp.value = charId;
    container.appendChild(inp);

    const star = row.querySelector('.prio-star');
    if (star && star.classList.contains('prio-active')) {
      const prioInp = document.createElement('input');
      prioInp.type = 'hidden';
      prioInp.name = 'priority_ids';
      prioInp.value = charId;
      container.appendChild(prioInp);
    }

    const groupIdx = row.dataset.groupIdx;
    const noteInput = document.querySelector(`.signup-note-input[data-group-idx="${CSS.escape(groupIdx)}"]`);
    const note = noteInput ? noteInput.value.trim() : '';
    if (note) {
      const noteIdInp = document.createElement('input');
      noteIdInp.type = 'hidden';
      noteIdInp.name = 'note_ids';
      noteIdInp.value = charId;
      container.appendChild(noteIdInp);

      const noteValInp = document.createElement('input');
      noteValInp.type = 'hidden';
      noteValInp.name = 'note_values';
      noteValInp.value = note;
      container.appendChild(noteValInp);
    }
  });

  const btn = document.getElementById('signupBtn');
  if (btn) {
    const count = document.querySelectorAll('.signup-row.row-selected').length;
    btn.textContent = count > 0 ? 'Update Sign-up' : 'Sign Up';
  }
  const tentativeBtn = document.getElementById('tentativeBtn');
  if (tentativeBtn) {
    const count = document.querySelectorAll('.signup-row.row-selected').length;
    tentativeBtn.textContent = count > 0 ? '❓ Update as Tentative' : '❓ Sign Up as Tentative';
  }
}

function toggleNoteRow(groupIdx) {
  const noteRow = document.querySelector(`.signup-note-row[data-group-idx="${CSS.escape(groupIdx)}"]`);
  const toggleBtn = document.querySelector(`.note-toggle-btn[data-group-idx="${CSS.escape(groupIdx)}"]`);
  if (!noteRow || !toggleBtn) return;
  const isHidden = noteRow.classList.toggle('d-none');
  const noteInput = noteRow.querySelector('.signup-note-input');
  const hasNoteText = !!(noteInput && noteInput.value.trim());
  toggleBtn.classList.toggle('note-toggle-active', !isHidden || hasNoteText);
  toggleBtn.setAttribute('aria-expanded', (!isHidden).toString());
}

function handleNoteInput(groupIdx) {
  const noteInput = document.querySelector(`.signup-note-input[data-group-idx="${CSS.escape(groupIdx)}"]`);
  const toggleBtn = document.querySelector(`.note-toggle-btn[data-group-idx="${CSS.escape(groupIdx)}"]`);
  if (noteInput && toggleBtn) {
    toggleBtn.classList.toggle('note-toggle-active', !!noteInput.value.trim());
  }
  buildHiddenInputs();
}

function toggleMySignupNote(btn) {
  const card = btn.closest('.card');
  if (!card) return;
  const note = card.querySelector('.my-signup-note');
  if (!note) return;
  const isHidden = note.classList.toggle('d-none');
  btn.setAttribute('aria-expanded', (!isHidden).toString());
}

let _presets = [];
let _savePresetModalInstance = null;

async function loadPresets() {
  try {
    const resp = await fetch('/characters/presets');
    const data = await resp.json();
    if (data.ok) {
      _presets = data.presets;
      const select = document.getElementById('presetSelect');
      if (select) {
        select.innerHTML = '<option value="">— Load Preset —</option>';
        _presets.forEach(p => {
          const opt = document.createElement('option');
          opt.value = p.id;
          opt.textContent = p.name;
          select.appendChild(opt);
        });
      }
    }
  } catch (err) {
    console.error('Failed to load presets', err);
  }
}

function applyPreset(presetId) {
  if (!presetId) return;
  const preset = _presets.find(p => p.id == presetId);
  if (!preset) return;

  const charIds = typeof preset.character_ids === 'string' ? JSON.parse(preset.character_ids) : preset.character_ids;
  const prioIds = typeof preset.priority_ids === 'string' ? JSON.parse(preset.priority_ids) : preset.priority_ids;
  const notesMap = typeof preset.notes === 'string' ? JSON.parse(preset.notes) : preset.notes;

  // Deselect all current
  document.querySelectorAll('.signup-row.row-selected').forEach(row => {
    row.classList.remove('row-selected');
    row.setAttribute('aria-selected', 'false');
    const star = row.querySelector('.prio-star');
    if (star) {
      star.classList.remove('prio-active');
      star.setAttribute('aria-pressed', 'false');
    }
  });

  // Clear notes
  document.querySelectorAll('.signup-note-input').forEach(input => {
    input.value = '';
    handleNoteInput(input.dataset.groupIdx);
  });

  // Apply preset selections
  const groupsToUpdate = new Set();

  charIds.forEach(id => {
    const row = document.querySelector(`.signup-row[data-char-id="${id}"]`);
    if (row) {
      row.classList.add('row-selected');
      row.setAttribute('aria-selected', 'true');
      groupsToUpdate.add(row.dataset.groupIdx);
    }
  });

  prioIds.forEach(id => {
    const row = document.querySelector(`.signup-row[data-char-id="${id}"]`);
    if (row) {
      const star = row.querySelector('.prio-star');
      if (star) {
        star.classList.add('prio-active');
        star.setAttribute('aria-pressed', 'true');
      }
    }
  });

  // Handle notes (notesMap is { charIdStr: note })
  for (const [idStr, note] of Object.entries(notesMap)) {
    const row = document.querySelector(`.signup-row[data-char-id="${idStr}"]`);
    if (row && note) {
      const gIdx = row.dataset.groupIdx;
      const noteInput = document.querySelector(`.signup-note-input[data-group-idx="${CSS.escape(gIdx)}"]`);
      if (noteInput) {
        noteInput.value = note;
        handleNoteInput(gIdx);
        // Show note row if not already visible
        const noteRow = document.querySelector(`.signup-note-row[data-group-idx="${CSS.escape(gIdx)}"]`);
        const toggleBtn = document.querySelector(`.note-toggle-btn[data-group-idx="${CSS.escape(gIdx)}"]`);
        if (noteRow && noteRow.classList.contains('d-none')) {
          noteRow.classList.remove('d-none');
          if (toggleBtn) {
            toggleBtn.classList.add('note-toggle-active');
            toggleBtn.setAttribute('aria-expanded', 'true');
          }
        }
      }
    }
  }

  groupsToUpdate.forEach(gIdx => updateGroupHighlight(gIdx));
  buildHiddenInputs();

  // Reset select
  const select = document.getElementById('presetSelect');
  if (select) select.value = '';
}

function showSavePresetModal() {
  const selectedRows = document.querySelectorAll('.signup-row.row-selected');
  if (selectedRows.length === 0) {
    alert("Please select at least one character to save as a preset.");
    return;
  }

  const errEl = document.getElementById('savePresetError');
  if (errEl) {
    errEl.textContent = '';
    errEl.classList.add('d-none');
  }

  const nameInput = document.getElementById('presetNameInput');
  if (nameInput) nameInput.value = '';

  if (!_savePresetModalInstance) {
    _savePresetModalInstance = new bootstrap.Modal(document.getElementById('savePresetModal'));
  }
  _savePresetModalInstance.show();
}

async function submitSavePreset() {
  const name = document.getElementById('presetNameInput').value.trim();
  const errEl = document.getElementById('savePresetError');

  if (!name) {
    errEl.textContent = 'Preset name is required.';
    errEl.classList.remove('d-none');
    return;
  }

  const charIds = [];
  const prioIds = [];
  const notes = {};

  document.querySelectorAll('.signup-row.row-selected').forEach(row => {
    const id = parseInt(row.dataset.charId);
    charIds.push(id);

    const star = row.querySelector('.prio-star');
    if (star && star.classList.contains('prio-active')) {
      prioIds.push(id);
    }

    const gIdx = row.dataset.groupIdx;
    const noteInput = document.querySelector(`.signup-note-input[data-group-idx="${CSS.escape(gIdx)}"]`);
    if (noteInput && noteInput.value.trim()) {
      notes[id] = noteInput.value.trim();
    }
  });

  if (charIds.length === 0) {
    errEl.textContent = 'No characters selected.';
    errEl.classList.remove('d-none');
    return;
  }

  try {
    const resp = await fetch('/characters/presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name,
        character_ids: charIds,
        priority_ids: prioIds,
        notes: notes
      })
    });

    const data = await resp.json();
    if (data.ok) {
      if (_savePresetModalInstance) _savePresetModalInstance.hide();
      await loadPresets();
    } else {
      errEl.textContent = data.error || 'Failed to save preset.';
      errEl.classList.remove('d-none');
    }
  } catch (err) {
    errEl.textContent = 'An error occurred while saving.';
    errEl.classList.remove('d-none');
  }
}

// Populate hidden inputs and group highlights on page load
document.addEventListener('DOMContentLoaded', () => {
  buildHiddenInputs();
  const groups = new Set();
  document.querySelectorAll('.signup-row[data-group-idx]').forEach(row => {
    groups.add(row.dataset.groupIdx);
  });
  groups.forEach(gIdx => updateGroupHighlight(gIdx));
  document.querySelectorAll('.signup-note-input[data-group-idx]').forEach(input => {
    handleNoteInput(input.dataset.groupIdx);
  });

  loadPresets();

  const select = document.getElementById('presetSelect');
  if (select) {
    select.addEventListener('change', (e) => {
      applyPreset(e.target.value);
    });
  }
});
