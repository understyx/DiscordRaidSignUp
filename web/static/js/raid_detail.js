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
      _presets = Array.isArray(data.presets) ? data.presets : [];
      const select = document.getElementById('presetSelect');
      if (select) {
        select.innerHTML = '<option value="" disabled>— Select preset(s) —</option>';
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

function parsePresetValue(value) {
  try {
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch (_err) {
    return null;
  }
}

function applyPresets(presetIds) {
  const selectedIds = Array.isArray(presetIds) ? presetIds : [presetIds];
  const selectedPresets = selectedIds
    .filter(Boolean)
    .map(id => _presets.find(p => p.id == id))
    .filter(Boolean);
  if (selectedPresets.length === 0) return;

  const charIds = new Set();
  const prioIds = new Set();
  const notesMap = {};
  selectedPresets.forEach(preset => {
    const presetCharIds = parsePresetValue(preset.character_ids);
    const presetPrioIds = parsePresetValue(preset.priority_ids);
    const presetNotes = parsePresetValue(preset.notes);
    if (Array.isArray(presetCharIds)) {
      presetCharIds.forEach(id => charIds.add(String(id)));
    }
    if (Array.isArray(presetPrioIds)) {
      presetPrioIds.forEach(id => prioIds.add(String(id)));
    }
    if (presetNotes && typeof presetNotes === 'object' && !Array.isArray(presetNotes)) {
      Object.assign(notesMap, presetNotes);
    }
  });

  // Deselect all current
  const groupsToUpdate = new Set();
  document.querySelectorAll('.signup-row.row-selected').forEach(row => {
    groupsToUpdate.add(row.dataset.groupIdx);
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

async function deleteSelectedPresets() {
  const select = document.getElementById('presetSelect');
  const presetIds = select
    ? Array.from(select.selectedOptions).map(option => option.value).filter(Boolean)
    : [];
  if (presetIds.length === 0) {
    alert('Select one or more presets to delete.');
    return;
  }
  if (!confirm(`Delete ${presetIds.length} selected preset${presetIds.length === 1 ? '' : 's'}?`)) return;

  try {
    for (const presetId of presetIds) {
      const resp = await fetch(`/characters/presets/${encodeURIComponent(presetId)}`, { method: 'DELETE' });
      const data = await resp.json();
      if (!resp.ok || !data.ok) throw new Error(data.error || 'Delete failed');
    }
    await loadPresets();
  } catch (err) {
    console.error('Failed to delete presets', err);
    alert('Could not delete the selected preset(s).');
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
      applyPresets(Array.from(e.target.selectedOptions).map(option => option.value));
    });
  }
});
