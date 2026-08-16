document.querySelectorAll('.save-cell').forEach(cell => {
  cell.addEventListener('click', async () => {
    if (cell.classList.contains('loading')) return;
    cell.classList.add('loading');

    const charId = cell.dataset.charId;
    const instanceName = cell.dataset.instance;

    try {
      const resp = await fetch('/characters/saves/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ char_id: parseInt(charId), instance_name: instanceName }),
      });
      const data = await resp.json();
      if (resp.ok) {
        const isSaved = data.is_saved === 1;
        cell.textContent = isSaved ? '🔴' : '🟢';
        cell.classList.toggle('saved', isSaved);
        cell.classList.toggle('unsaved', !isSaved);
      }
    } catch (e) {
      console.error('Toggle failed', e);
    } finally {
      cell.classList.remove('loading');
    }
  });
});

if (new URLSearchParams(window.location.search).get('tab') === 'presets') {
  const presetsTab = document.getElementById('presets-tab');
  if (presetsTab) bootstrap.Tab.getOrCreateInstance(presetsTab).show();
}

document.querySelectorAll('[data-preset-selection]').forEach((button) => {
  button.addEventListener('click', () => {
    const selection = button.dataset.presetSelection;
    const rows = Array.from(document.querySelectorAll('#presets-pane .signup-row'));
    const groups = new Set();

    rows.forEach((row) => {
      const selected = selection === 'all' || (selection !== 'none' && row.dataset.role === selection);
      setRowSelected(row, selected);
      groups.add(row.dataset.groupIdx);
    });
    groups.forEach((groupIdx) => updateGroupState(groupIdx));
    buildHiddenInputs();

    const selectedCount = rows.filter((row) => row.classList.contains('row-selected')).length;
    const label = selection === 'none' ? 'Selection cleared.' : `${selectedCount} specs selected.`;
    setQuickActionFeedback(label);
  });
});

const newCharacterForm = document.getElementById('newCharacterForm');
if (newCharacterForm?.dataset.guided === 'true') {
  const nameInput = document.getElementById('newCharacterName');
  const realmInput = document.getElementById('newCharacterRealm');
  const classSelect = document.getElementById('newCharacterClass');
  const specSelect = document.getElementById('newCharacterSpec');
  const gearscoreInput = document.getElementById('newCharacterGearscore');
  const summary = document.getElementById('characterGuideSummary');
  const progressItems = document.querySelectorAll('[data-guide-progress]');

  const updateGuide = () => {
    const hasCharacter = Boolean(nameInput.value.trim());
    const hasBuild = Boolean(
      classSelect.value && specSelect.value && gearscoreInput.value.trim()
    );

    progressItems.forEach((item) => {
      const step = Number(item.dataset.guideProgress);
      const complete = step === 1 ? hasCharacter : step === 2 ? hasBuild : hasCharacter && hasBuild;
      item.classList.toggle('complete', complete);
    });

    if (hasCharacter && hasBuild) {
      summary.textContent = `${nameInput.value.trim()}-${realmInput.value.trim()} · ${classSelect.value} · ${specSelect.value} · GS ${gearscoreInput.value.trim()}`;
      summary.classList.remove('text-muted');
    } else {
      summary.textContent = 'Complete the fields above.';
      summary.classList.add('text-muted');
    }
  };

  classSelect.addEventListener('change', () => {
    const classData = WOW_DATA.classes[classSelect.value];
    specSelect.replaceChildren();

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = classData ? '— select —' : '— choose class first —';
    specSelect.appendChild(placeholder);

    if (classData) {
      Object.keys(classData.specs).forEach((specName) => {
        const option = document.createElement('option');
        option.value = specName;
        option.textContent = specName;
        specSelect.appendChild(option);
      });
      specSelect.disabled = false;
      specSelect.focus();
    } else {
      specSelect.disabled = true;
    }
    updateGuide();
  });

  [nameInput, realmInput, specSelect, gearscoreInput].forEach((field) => {
    field.addEventListener('input', updateGuide);
    field.addEventListener('change', updateGuide);
  });
  updateGuide();
}
