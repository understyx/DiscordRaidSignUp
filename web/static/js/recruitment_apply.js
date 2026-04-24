const BIS_GS = 99999;

// ── Add Spec per-character helpers ────────────────────────────────────────────

function showAddSpec(qid, charKey) {
  document.getElementById('addSpecRow-' + qid + '_' + charKey).classList.remove('d-none');
  document.getElementById('new_spec_spec_' + qid + '_' + charKey).focus();
}

function hideAddSpec(qid, charKey) {
  document.getElementById('addSpecRow-' + qid + '_' + charKey).classList.add('d-none');
}

async function registerSpec(qid, charKey) {
  const nameEl  = document.getElementById('add_spec_name_'  + qid + '_' + charKey);
  const realmEl = document.getElementById('add_spec_realm_' + qid + '_' + charKey);
  const classEl = document.getElementById('add_spec_class_' + qid + '_' + charKey);
  const specEl  = document.getElementById('new_spec_spec_'  + qid + '_' + charKey);
  const gsEl    = document.getElementById('new_spec_gs_'    + qid + '_' + charKey);
  const errEl   = document.getElementById('spec-add-error-' + qid + '_' + charKey);

  errEl.textContent = '';

  try {
    const resp = await fetch('/recruitment/characters/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        char_name:  nameEl.value,
        realm:      realmEl.value,
        char_class: classEl.value,
        spec:       specEl.value.trim(),
        gearscore:  gsEl.value.trim(),
      }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.ok) {
      errEl.textContent = data.error || 'Failed to add spec.';
      return;
    }

    const c = data.character;
    const list = document.getElementById('char-list-' + qid);
    const addSpecRow = document.getElementById('addSpecRow-' + qid + '_' + charKey);

    // Check if the spec already exists in the table
    const existingCb = list.querySelector(`input[value="${c.id}"]`);
    if (existingCb) {
      existingCb.checked = true;
    } else {
      // Increment rowspan of the first spec row's name/realm/class cells
      const specRows = [...list.querySelectorAll(`tr[data-char-key="${charKey}"][data-spec-row]`)];
      if (specRows.length > 0) {
        const firstRow = specRows[0];
        ['name', 'realm', 'class'].forEach(cell => {
          const td = firstRow.querySelector(`td[data-char-cell="${cell}"]`);
          if (td) td.setAttribute('rowspan', parseInt(td.getAttribute('rowspan') || 1) + 1);
        });
      }

      const row = document.createElement('tr');
      row.dataset.charKey = charKey;
      row.dataset.specRow = 'true';
      row.innerHTML = buildSpecCells(c, qid, charKey);
      list.insertBefore(row, addSpecRow);
    }

    specEl.value = '';
    gsEl.value   = '';
    hideAddSpec(qid, charKey);
  } catch (e) {
    errEl.textContent = 'Network error. Please try again.';
  }
}

// ── Register a brand-new character ───────────────────────────────────────────

async function registerChar(qid) {
  const nameEl  = document.getElementById('new_char_name_'  + qid);
  const realmEl = document.getElementById('new_char_realm_' + qid);
  const classEl = document.getElementById('new_char_class_' + qid);
  const specEl  = document.getElementById('new_char_spec_'  + qid);
  const gsEl    = document.getElementById('new_char_gs_'    + qid);
  const errEl   = document.getElementById('char-add-error-' + qid);

  const name = nameEl.value.trim();
  if (!name) { errEl.textContent = 'Character name is required.'; return; }
  errEl.textContent = '';

  try {
    const resp = await fetch('/recruitment/characters/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        char_name:  name,
        realm:      (realmEl.value.trim() || 'Icecrown'),
        char_class: classEl.value,
        spec:       specEl.value.trim(),
        gearscore:  gsEl.value.trim(),
      }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.ok) {
      errEl.textContent = data.error || 'Failed to register character.';
      return;
    }

    const c = data.character;
    const list = document.getElementById('char-list-' + qid);

    // Remove the "no characters" placeholder if present
    const placeholder = document.getElementById('char-no-chars-' + qid);
    if (placeholder) placeholder.closest('tr').remove();

    const charKey = c.char_name.toLowerCase().replace(/ /g, '-');
    const addCharRow     = document.getElementById('addCharRow-'     + qid);
    const addCharTrigger = document.getElementById('addCharTrigger-' + qid);

    // If the character is already listed just ensure it is checked
    const existingCb = list.querySelector(`input[value="${c.id}"]`);
    if (existingCb) {
      existingCb.checked = true;
    } else {
      const clsKey = (c.char_class || '').toLowerCase().replace(/ /g, '-');

      // New character row (first row of group — includes name/realm/class cells with rowspan=1)
      const row = document.createElement('tr');
      row.dataset.charKey = charKey;
      row.dataset.specRow = 'true';
      row.innerHTML =
        `<td class="fw-bold cls-${clsKey}" rowspan="1" data-char-cell="name">` +
        `${escapeHtml(c.char_name)}<button type="button" class="btn btn-sm btn-outline-secondary ms-1 py-0 px-1" ` +
        `onclick="showAddSpec('${qid}', '${charKey}')" title="Add Spec">➕</button></td>` +
        `<td class="text-muted" rowspan="1" data-char-cell="realm">${escapeHtml(c.realm || '—')}</td>` +
        `<td class="cls-${clsKey}" rowspan="1" data-char-cell="class">${escapeHtml(c.char_class || '—')}</td>` +
        buildSpecCells(c, qid, charKey);
      list.insertBefore(row, addCharRow);

      // Inject addSpecRow only if it doesn't exist yet for this charKey
      if (!document.getElementById('addSpecRow-' + qid + '_' + charKey)) {
        const addSpecFormRow = document.createElement('tr');
        addSpecFormRow.id = 'addSpecRow-' + qid + '_' + charKey;
        addSpecFormRow.className = 'd-none';
        addSpecFormRow.innerHTML =
          `<td colspan="6" class="p-2 border-bottom border-secondary">` +
          `<input type="hidden" id="add_spec_name_${qid}_${charKey}" value="${escapeHtml(c.char_name)}" />` +
          `<input type="hidden" id="add_spec_realm_${qid}_${charKey}" value="${escapeHtml(c.realm || 'Icecrown')}" />` +
          `<input type="hidden" id="add_spec_class_${qid}_${charKey}" value="${escapeHtml(c.char_class || '')}" />` +
          `<div class="d-flex gap-2 align-items-center flex-wrap">` +
          `<span class="text-muted small fw-semibold">${escapeHtml(c.char_name)}</span>` +
          `<input type="text" class="form-control form-control-sm bg-dark text-light border-secondary" ` +
          `id="new_spec_spec_${qid}_${charKey}" style="width:110px" placeholder="Spec" maxlength="50" />` +
          `<input type="text" class="form-control form-control-sm bg-dark text-light border-secondary" ` +
          `id="new_spec_gs_${qid}_${charKey}" style="width:80px" placeholder="GS" maxlength="10" />` +
          `<button type="button" class="btn btn-sm btn-wow" ` +
          `onclick="registerSpec('${qid}', '${charKey}')">Add</button>` +
          `<button type="button" class="btn btn-sm btn-outline-secondary" ` +
          `onclick="hideAddSpec('${qid}', '${charKey}')">✕</button>` +
          `</div>` +
          `<div id="spec-add-error-${qid}_${charKey}" class="text-danger small mt-2"></div>` +
          `</td>`;

        list.insertBefore(addSpecFormRow, addCharRow);
      }
    }

    // Clear add-form inputs
    nameEl.value = '';
    specEl.value  = '';
    gsEl.value    = '';
    classEl.selectedIndex = 0;
    hideAddChar(qid);
  } catch (e) {
    errEl.textContent = 'Network error. Please try again.';
  }
}

// ── Row builder helpers ───────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function buildSpecCells(c, qid, charKey) {
  const gs = c.gearscore
    ? (c.gearscore >= BIS_GS ? 'BiS' : Math.floor(c.gearscore).toString())
    : '';
  return (
    `<td><div class="d-flex gap-1 align-items-center flex-nowrap">` +
    `<input class="form-check-input" type="checkbox" name="char_sel_${qid}" ` +
    `value="${c.id}" id="char_${qid}_${c.id}" checked>` +
    `<input type="text" id="char_spec_${c.id}" value="${escapeHtml(c.spec || '')}" ` +
    `class="form-control form-control-sm bg-dark text-light border-secondary" ` +
    `style="width:110px" placeholder="—" maxlength="50" />` +
    `<button type="button" class="btn btn-sm btn-outline-secondary" ` +
    `onclick="saveCharSpec(${c.id}, this)" title="Save Spec">💾</button>` +
    `</div></td>` +
    `<td><div class="d-flex gap-1 align-items-center flex-nowrap">` +
    `<input type="text" id="char_gs_${c.id}" value="${escapeHtml(gs)}" ` +
    `class="form-control form-control-sm bg-dark text-light border-secondary" ` +
    `style="width:80px" placeholder="—" maxlength="10" />` +
    `<button type="button" class="btn btn-sm btn-outline-secondary" ` +
    `onclick="saveCharGS(${c.id}, this)" title="Save GS">💾</button>` +
    `</div></td>` +
    `<td class="text-end"><button type="button" class="btn btn-sm btn-outline-danger" ` +
    `onclick="deleteSpec(${c.id}, '${qid}', '${charKey}', this)" title="Remove">✕</button></td>`
  );
}

// ── Save spec / GS ────────────────────────────────────────────────────────────

async function saveCharSpec(charId, btn) {
  const value = document.getElementById('char_spec_' + charId).value.trim();
  await saveCharFieldGeneric(`/recruitment/characters/${charId}/update-spec`, { spec: value }, btn);
}

async function saveCharGS(charId, btn) {
  const value = document.getElementById('char_gs_' + charId).value.trim();
  await saveCharFieldGeneric(`/recruitment/characters/${charId}/update-gs`, { gearscore: value }, btn);
}

async function saveCharFieldGeneric(url, body, btn) {
  const origText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳';

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!resp.ok || !data.ok) {
      btn.textContent = '❌';
      setTimeout(() => { btn.textContent = origText; btn.disabled = false; }, 1500);
      return;
    }
    btn.textContent = '✅';
    setTimeout(() => { btn.textContent = origText; btn.disabled = false; }, 1000);
  } catch (e) {
    btn.textContent = '❌';
    setTimeout(() => { btn.textContent = origText; btn.disabled = false; }, 1500);
  }
}

// ── Delete a spec row ─────────────────────────────────────────────────────────

async function deleteSpec(charId, qid, charKey, btn) {
  if (!confirm('Remove this spec?')) return;
  btn.disabled = true;

  try {
    const resp = await fetch(`/recruitment/characters/${charId}/delete`, { method: 'POST' });
    const data = await resp.json();
    if (!resp.ok || !data.ok) { btn.disabled = false; return; }

    const list = document.getElementById('char-list-' + qid);
    const specRows = [...list.querySelectorAll(`tr[data-char-key="${charKey}"][data-spec-row]`)];
    const deletedRow = btn.closest('tr');

    if (specRows.length === 1) {
      // Last spec for this character — remove row and its addSpecRow
      deletedRow.remove();
      const addSpecRow = document.getElementById('addSpecRow-' + qid + '_' + charKey);
      if (addSpecRow) addSpecRow.remove();

      // Show placeholder if no characters remain
      if (!list.querySelector('tr[data-spec-row]')) {
        const placeholder = document.createElement('tr');
        placeholder.id = 'char-no-chars-' + qid;
        placeholder.innerHTML = `<td colspan="6" class="text-muted small">No characters registered yet. Add one below.</td>`;
        list.insertBefore(placeholder, document.getElementById('addCharRow-' + qid));
      }
    } else {
      // Multiple specs exist — manage rowspan
      const newRowspan = specRows.length - 1;
      const isFirstRow = specRows[0] === deletedRow;

      if (isFirstRow) {
        // Move name/realm/class cells to the next spec row (insert in reverse to preserve order)
        const nextRow = specRows[1];
        ['class', 'realm', 'name'].forEach(cell => {
          const td = deletedRow.querySelector(`td[data-char-cell="${cell}"]`);
          if (td) {
            td.setAttribute('rowspan', newRowspan);
            nextRow.insertBefore(td, nextRow.firstChild);
          }
        });
      } else {
        // Decrement rowspan on the first row's group cells
        const firstRow = specRows[0];
        ['name', 'realm', 'class'].forEach(cell => {
          const td = firstRow.querySelector(`td[data-char-cell="${cell}"]`);
          if (td) td.setAttribute('rowspan', newRowspan);
        });
      }

      deletedRow.remove();
    }
  } catch (e) {
    btn.disabled = false;
    console.error('Delete failed', e);
  }
}

function showAddChar(qid) {
  const row = document.getElementById('addCharRow-' + qid);
  const trigger = document.getElementById('addCharTrigger-' + qid);
  if (row) row.classList.remove('d-none');
  if (trigger) trigger.classList.add('d-none');
  const nameInput = document.getElementById('new_char_name_' + qid);
  if (nameInput) nameInput.focus();
}

function hideAddChar(qid) {
  const row = document.getElementById('addCharRow-' + qid);
  const trigger = document.getElementById('addCharTrigger-' + qid);
  if (row) row.classList.add('d-none');
  if (trigger) trigger.classList.remove('d-none');
}

function addGroupInstance(container) {
  const instances = container.querySelectorAll('.group-instance');
  if (!instances.length) return;
  const lastInstance = instances[instances.length - 1];
  const newIdx = parseInt(lastInstance.dataset.instanceIdx, 10) + 1;

  const clone = lastInstance.cloneNode(true);
  clone.dataset.instanceIdx = newIdx;
  clone.classList.add('border-top', 'border-secondary', 'pt-3', 'mt-3');

  // Update field names and clear values
  clone.querySelectorAll('[name]').forEach(el => {
    const m = el.name.match(/^(answer_\d+)_(\d+)$/);
    if (m) el.name = m[1] + '_' + newIdx;
    if (el.tagName === 'TEXTAREA') {
      el.value = '';
    } else if (el.tagName === 'SELECT') {
      el.selectedIndex = 0;
    } else if (el.type === 'radio' || el.type === 'checkbox') {
      el.checked = false;
    } else if (el.tagName === 'INPUT') {
      el.value = '';
    }
  });

  // Ensure remove button exists in the clone
  let removeDiv = clone.querySelector('.d-flex.justify-content-end');
  if (!removeDiv) {
    removeDiv = document.createElement('div');
    removeDiv.className = 'd-flex justify-content-end mb-2';
    removeDiv.innerHTML = '<button type="button" class="btn btn-sm btn-outline-danger" onclick="removeGroupInstance(this)">✕ Remove</button>';
    clone.insertBefore(removeDiv, clone.querySelector('.row'));
  }

  container.appendChild(clone);
}

function removeGroupInstance(btn) {
  const inst = btn.closest('.group-instance');
  if (inst) inst.remove();
}
