'use strict';

function signupRows(groupIdx) {
  return document.querySelectorAll(
    `.signup-row[data-group-idx="${CSS.escape(String(groupIdx))}"]`
  );
}

function setRowSelected(row, selected) {
  row.classList.toggle('row-selected', selected);
  if (row.hasAttribute('aria-selected')) {
    row.setAttribute('aria-selected', selected ? 'true' : 'false');
  }
  const specToggle = row.querySelector('.spec-toggle');
  if (specToggle) {
    specToggle.setAttribute('aria-pressed', selected ? 'true' : 'false');
    specToggle.setAttribute(
      'aria-label',
      `${selected ? 'Remove' : 'Select'} ${row.dataset.charName} ${row.dataset.specName}`
    );
  }

  if (!selected) {
    const star = row.querySelector('.prio-star');
    if (star) {
      star.classList.remove('prio-active');
      star.setAttribute('aria-pressed', 'false');
    }
  }
}

function toggleRow(row) {
  setRowSelected(row, !row.classList.contains('row-selected'));
  updateGroupState(row.dataset.groupIdx);
  buildHiddenInputs();
}

function toggleGroupRows(groupIdx) {
  const rows = Array.from(signupRows(groupIdx));
  const allSelected = rows.length > 0 && rows.every((row) => row.classList.contains('row-selected'));
  const anySelected = rows.some((row) => row.classList.contains('row-selected'));
  const shouldSelect = rows[0]?.tagName === 'TR' ? !anySelected : !allSelected;

  rows.forEach((row) => setRowSelected(row, shouldSelect));
  updateGroupState(groupIdx);
  buildHiddenInputs();
}

function updateGroupState(groupIdx) {
  const rows = Array.from(signupRows(groupIdx));
  const selectedCount = rows.filter((row) => row.classList.contains('row-selected')).length;
  const card = document.querySelector(
    `.signup-character[data-group-idx="${CSS.escape(String(groupIdx))}"]`
  );
  const toggle = document.querySelector(
    `.group-toggle-btn[data-group-idx="${CSS.escape(String(groupIdx))}"]`
  );

  if (card) card.classList.toggle('character-has-selection', selectedCount > 0);
  const firstRow = rows[0];
  if (firstRow) {
    firstRow.querySelectorAll('.group-cell').forEach((cell) => {
      cell.classList.toggle('group-cell-selected', selectedCount > 0);
    });
  }
  if (toggle) {
    const allSelected = rows.length > 0 && selectedCount === rows.length;
    toggle.setAttribute('aria-pressed', allSelected ? 'true' : 'false');
    toggle.textContent = allSelected ? 'Clear all' : 'Select all';
  }
}

function togglePrio(star) {
  const row = star.closest('.signup-row');
  if (!row) return;

  const willBeActive = !star.classList.contains('prio-active');
  star.classList.toggle('prio-active', willBeActive);
  star.setAttribute('aria-pressed', willBeActive ? 'true' : 'false');

  if (willBeActive) setRowSelected(row, true);
  updateGroupState(row.dataset.groupIdx);
  buildHiddenInputs();
}

function selectionSummary(selectedRows) {
  const count = selectedRows.length;
  const characters = new Set(selectedRows.map((row) => row.dataset.charName));
  const countEl = document.getElementById('selectionCount');
  const detailEl = document.getElementById('selectionDetail');

  if (!countEl || !detailEl) return;

  if (count === 0) {
    countEl.textContent = 'No specs selected';
    detailEl.textContent = 'Choose at least one spec to continue.';
    return;
  }

  countEl.textContent = `${count} spec${count === 1 ? '' : 's'} across ${characters.size} character${characters.size === 1 ? '' : 's'}`;
  detailEl.textContent = selectedRows
    .map((row) => `${row.dataset.charName} · ${row.dataset.specName}`)
    .join(', ');
}

function buildHiddenInputs() {
  const container = document.getElementById('hiddenInputs');
  if (!container) return;
  container.innerHTML = '';

  const selectedRows = Array.from(document.querySelectorAll('.signup-row.row-selected'));
  selectedRows.forEach((row) => {
    const charId = row.dataset.charId;
    const characterInput = document.createElement('input');
    characterInput.type = 'hidden';
    characterInput.name = 'character_ids';
    characterInput.value = charId;
    container.appendChild(characterInput);

    const star = row.querySelector('.prio-star');
    if (star && star.classList.contains('prio-active')) {
      const priorityInput = document.createElement('input');
      priorityInput.type = 'hidden';
      priorityInput.name = 'priority_ids';
      priorityInput.value = charId;
      container.appendChild(priorityInput);
    }

    const groupIdx = row.dataset.groupIdx;
    const noteInput = document.querySelector(
      `.signup-note-input[data-group-idx="${CSS.escape(groupIdx)}"]`
    );
    const note = noteInput ? noteInput.value.trim() : '';
    if (note) {
      const noteIdInput = document.createElement('input');
      noteIdInput.type = 'hidden';
      noteIdInput.name = 'note_ids';
      noteIdInput.value = charId;
      container.appendChild(noteIdInput);

      const noteValueInput = document.createElement('input');
      noteValueInput.type = 'hidden';
      noteValueInput.name = 'note_values';
      noteValueInput.value = note;
      container.appendChild(noteValueInput);
    }
  });

  selectionSummary(selectedRows);
  const disabled = selectedRows.length === 0;
  const signupButton = document.getElementById('signupBtn');
  const tentativeButton = document.getElementById('tentativeBtn');
  if (signupButton) signupButton.disabled = disabled;
  if (tentativeButton) tentativeButton.disabled = disabled;
}

function toggleNoteEditor(groupIdx) {
  const editor = document.querySelector(
    `.signup-note-editor[data-group-idx="${CSS.escape(String(groupIdx))}"]`
  );
  const toggle = document.querySelector(
    `.note-toggle-btn[data-group-idx="${CSS.escape(String(groupIdx))}"]`
  );
  if (!editor || !toggle) return;

  const isHidden = editor.classList.toggle('d-none');
  const input = editor.querySelector('.signup-note-input');
  const hasNote = Boolean(input && input.value.trim());
  toggle.classList.toggle('note-toggle-active', !isHidden || hasNote);
  toggle.setAttribute('aria-expanded', (!isHidden).toString());
  toggle.setAttribute(
    'aria-label',
    `${isHidden ? (hasNote ? 'Edit' : 'Add') : 'Hide'} note for ${editor.querySelector('label').textContent.replace('Note for ', '')}`
  );
  if (!isHidden && input) input.focus();
}

function toggleNoteRow(groupIdx) {
  const noteRow = document.querySelector(
    `.signup-note-row[data-group-idx="${CSS.escape(String(groupIdx))}"]`
  );
  const toggle = document.querySelector(
    `.note-toggle-btn[data-group-idx="${CSS.escape(String(groupIdx))}"]`
  );
  if (!noteRow || !toggle) return;

  const isHidden = noteRow.classList.toggle('d-none');
  const input = noteRow.querySelector('.signup-note-input');
  const hasNote = Boolean(input && input.value.trim());
  toggle.classList.toggle('note-toggle-active', !isHidden || hasNote);
  toggle.setAttribute('aria-expanded', (!isHidden).toString());
}

function handleNoteInput(groupIdx) {
  const input = document.querySelector(
    `.signup-note-input[data-group-idx="${CSS.escape(String(groupIdx))}"]`
  );
  const toggle = document.querySelector(
    `.note-toggle-btn[data-group-idx="${CSS.escape(String(groupIdx))}"]`
  );
  if (input && toggle) {
    toggle.classList.toggle('note-toggle-active', Boolean(input.value.trim()));
  }
  buildHiddenInputs();
}

let signupPresets = [];
let savePresetModal = null;

async function loadPresets() {
  try {
    const response = await fetch('/characters/presets');
    const data = await response.json();
    if (!data.ok) return;

    signupPresets = Array.isArray(data.presets) ? data.presets : [];
    const select = document.getElementById('presetSelect');
    if (!select) return;

    select.innerHTML = '<option value="" disabled>— Select preset(s) —</option>';
    signupPresets.forEach((preset) => {
      const option = document.createElement('option');
      option.value = preset.id;
      option.textContent = preset.name;
      select.appendChild(option);
    });
  } catch (error) {
    console.error('Failed to load presets', error);
  }
}

function parsePresetValue(value) {
  try {
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch (_error) {
    return null;
  }
}

function applyPresets(presetIds) {
  const requestedIds = Array.isArray(presetIds) ? presetIds : [presetIds];
  const selectedPresets = requestedIds
    .filter(Boolean)
    .map((id) => signupPresets.find((preset) => preset.id == id))
    .filter(Boolean);
  if (selectedPresets.length === 0) return;

  const characterIds = new Set();
  const priorityIds = new Set();
  const notes = {};
  selectedPresets.forEach((preset) => {
    const presetCharacterIds = parsePresetValue(preset.character_ids);
    const presetPriorityIds = parsePresetValue(preset.priority_ids);
    const presetNotes = parsePresetValue(preset.notes);
    if (Array.isArray(presetCharacterIds)) {
      presetCharacterIds.forEach((id) => characterIds.add(String(id)));
    }
    if (Array.isArray(presetPriorityIds)) {
      presetPriorityIds.forEach((id) => priorityIds.add(String(id)));
    }
    if (presetNotes && typeof presetNotes === 'object' && !Array.isArray(presetNotes)) {
      Object.assign(notes, presetNotes);
    }
  });

  const groupsToUpdate = new Set();
  document.querySelectorAll('.signup-row').forEach((row) => {
    groupsToUpdate.add(row.dataset.groupIdx);
    setRowSelected(row, false);
  });
  document.querySelectorAll('.signup-note-input').forEach((input) => {
    input.value = '';
    handleNoteInput(input.dataset.groupIdx);
  });

  characterIds.forEach((id) => {
    const row = document.querySelector(`.signup-row[data-char-id="${CSS.escape(id)}"]`);
    if (!row) return;
    setRowSelected(row, true);
    groupsToUpdate.add(row.dataset.groupIdx);
  });

  priorityIds.forEach((id) => {
    const row = document.querySelector(`.signup-row[data-char-id="${CSS.escape(id)}"]`);
    const star = row?.querySelector('.prio-star');
    if (!star) return;
    star.classList.add('prio-active');
    star.setAttribute('aria-pressed', 'true');
  });

  Object.entries(notes).forEach(([id, note]) => {
    if (!note) return;
    const row = document.querySelector(`.signup-row[data-char-id="${CSS.escape(id)}"]`);
    if (!row) return;

    const groupIdx = row.dataset.groupIdx;
    const input = document.querySelector(
      `.signup-note-input[data-group-idx="${CSS.escape(groupIdx)}"]`
    );
    if (!input) return;

    input.value = note;
    handleNoteInput(groupIdx);
    const noteRow = document.querySelector(
      `.signup-note-row[data-group-idx="${CSS.escape(groupIdx)}"]`
    );
    const noteEditor = document.querySelector(
      `.signup-note-editor[data-group-idx="${CSS.escape(groupIdx)}"]`
    );
    const noteContainer = noteRow || noteEditor;
    const toggle = document.querySelector(
      `.note-toggle-btn[data-group-idx="${CSS.escape(groupIdx)}"]`
    );
    if (noteContainer) noteContainer.classList.remove('d-none');
    if (toggle) {
      toggle.classList.add('note-toggle-active');
      toggle.setAttribute('aria-expanded', 'true');
    }
  });

  groupsToUpdate.forEach((groupIdx) => updateGroupState(groupIdx));
  buildHiddenInputs();
}

function showSavePresetModal() {
  if (document.querySelectorAll('.signup-row.row-selected').length === 0) {
    alert('Please select at least one character to save as a preset.');
    return;
  }

  const error = document.getElementById('savePresetError');
  if (error) {
    error.textContent = '';
    error.classList.add('d-none');
  }
  const nameInput = document.getElementById('presetNameInput');
  if (nameInput) nameInput.value = '';

  if (!savePresetModal) {
    savePresetModal = new bootstrap.Modal(document.getElementById('savePresetModal'));
  }
  savePresetModal.show();
}

async function submitSavePreset() {
  const nameInput = document.getElementById('presetNameInput');
  const error = document.getElementById('savePresetError');
  const name = nameInput ? nameInput.value.trim() : '';
  if (!name) {
    error.textContent = 'Preset name is required.';
    error.classList.remove('d-none');
    return;
  }

  const characterIds = [];
  const priorityIds = [];
  const notes = {};
  document.querySelectorAll('.signup-row.row-selected').forEach((row) => {
    const id = Number.parseInt(row.dataset.charId, 10);
    characterIds.push(id);
    if (row.querySelector('.prio-star.prio-active')) priorityIds.push(id);

    const noteInput = document.querySelector(
      `.signup-note-input[data-group-idx="${CSS.escape(row.dataset.groupIdx)}"]`
    );
    if (noteInput?.value.trim()) notes[id] = noteInput.value.trim();
  });

  try {
    const response = await fetch('/characters/presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        character_ids: characterIds,
        priority_ids: priorityIds,
        notes,
      }),
    });
    const data = await response.json();
    if (!data.ok) throw new Error(data.error || 'Failed to save preset.');
    savePresetModal?.hide();
    await loadPresets();
  } catch (requestError) {
    error.textContent = requestError.message || 'An error occurred while saving.';
    error.classList.remove('d-none');
  }
}

async function deleteSelectedPresets() {
  const select = document.getElementById('presetSelect');
  const presetIds = select
    ? Array.from(select.selectedOptions, (option) => option.value).filter(Boolean)
    : [];
  if (presetIds.length === 0) {
    alert('Select one or more presets to delete.');
    return;
  }
  if (!confirm(`Delete ${presetIds.length} selected preset${presetIds.length === 1 ? '' : 's'}?`)) {
    return;
  }

  try {
    for (const presetId of presetIds) {
      const response = await fetch(`/characters/presets/${encodeURIComponent(presetId)}`, {
        method: 'DELETE',
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || 'Delete failed');
    }
    await loadPresets();
  } catch (error) {
    console.error('Failed to delete presets', error);
    alert('Could not delete the selected preset(s).');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('#signupForm .spec-toggle').forEach((toggle) => {
    toggle.addEventListener('click', () => toggleRow(toggle.closest('.signup-row')));
  });

  document.querySelectorAll('#signupForm .prio-star').forEach((star) => {
    star.addEventListener('click', (event) => {
      event.stopPropagation();
      togglePrio(star);
    });
  });

  document.querySelectorAll('#signupForm .group-toggle-btn').forEach((toggle) => {
    toggle.addEventListener('click', () => toggleGroupRows(toggle.dataset.groupIdx));
  });

  document.querySelectorAll('#signupForm .note-toggle-btn').forEach((toggle) => {
    toggle.addEventListener('click', () => toggleNoteEditor(toggle.dataset.groupIdx));
  });

  document.querySelectorAll('#signupForm .signup-note-input').forEach((input) => {
    input.addEventListener('input', () => {
      const toggle = document.querySelector(
        `.note-toggle-btn[data-group-idx="${CSS.escape(input.dataset.groupIdx)}"]`
      );
      if (toggle) toggle.classList.toggle('note-toggle-active', Boolean(input.value.trim()));
      buildHiddenInputs();
    });
  });

  const groups = new Set(
    Array.from(document.querySelectorAll('.signup-row[data-group-idx]')).map(
      (row) => row.dataset.groupIdx
    )
  );
  groups.forEach((groupIdx) => updateGroupState(groupIdx));
  buildHiddenInputs();

  const presetSelect = document.getElementById('presetSelect');
  if (presetSelect) {
    loadPresets();
    presetSelect.addEventListener('change', () => {
      applyPresets(Array.from(presetSelect.selectedOptions, (option) => option.value));
    });
  }
});
