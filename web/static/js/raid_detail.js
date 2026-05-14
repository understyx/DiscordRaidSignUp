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
  toggleBtn.classList.toggle('note-toggle-active', !isHidden || !!(noteRow.querySelector('.signup-note-input')?.value.trim()));
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
});
