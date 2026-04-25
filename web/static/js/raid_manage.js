/**
 * Raid Roster Management Javascript
 */

let CAN_EDIT = false;
let CURRENT_COMP = 1;
let RAID_URL = '';
let COMP_NUMBERS_ALL = [];
let COMP_SUMMARIES = {};
let COMP_LABELS = {};
let CHARS_IN_COMPS = {};
let WOTLK_RAID_BUFFS = [];

const configEl = document.getElementById('rosterConfig');
if (configEl) {
  try {
    const config = JSON.parse(configEl.textContent);
    CAN_EDIT = config.CAN_EDIT;
    CURRENT_COMP = config.CURRENT_COMP;
    RAID_URL = config.RAID_URL;
    COMP_NUMBERS_ALL = config.COMP_NUMBERS_ALL;
    COMP_SUMMARIES = config.COMP_SUMMARIES;
    COMP_LABELS = config.COMP_LABELS;
    CHARS_IN_COMPS = config.CHARS_IN_COMPS;
    WOTLK_RAID_BUFFS = config.WOTLK_RAID_BUFFS;
  } catch (e) {
    console.error('Failed to parse roster configuration', e);
  }
}

let draggedCharId        = null;
let draggedCharName      = null;
let draggedCharClass     = null;
let draggedDiscordUserId = null;
let draggedDisplayLabel  = null;
let draggedSpec          = null;
let draggedRole          = null;   // detected role for auto-slot-assignment
let draggedPlaceholder   = null;
let draggedPlaceholderColor = null;
let draggedIsPlayer      = false;

// Apply colors to any placeholder-colored spans already in the DOM
function applyPlaceholderColors() {
  document.querySelectorAll('.placeholder-colored').forEach(el => {
    const text = el.textContent || '';
    const color = colorForPlaceholder(text);
    if (color) el.style.color = color;
  });
}

function applySlotTint(slotCard, charClass) {
  let rgba = getClassColor(charClass, 0.22);
  if (!rgba) {
    // Fall back to role-based tinting
    const role = slotCard.dataset.slotRole;
    if (role === 'mdps') rgba = 'rgba(163, 53, 238, 0.15)';
    else if (role === 'rdps') rgba = 'rgba(255, 128, 0, 0.15)';
    else if (role === 'tank') rgba = 'rgba(91, 155, 213, 0.15)';
    else if (role === 'healer') rgba = 'rgba(87, 168, 91, 0.15)';
    else if (role === 'dps') rgba = 'rgba(201, 64, 64, 0.15)';
  }

  if (rgba) {
    slotCard.style.backgroundColor = rgba;
  } else {
    slotCard.style.backgroundColor = '';
  }
}

// Apply tints to already-rendered slots on page load
function applyInitialTints() {
  document.querySelectorAll('.slot-card').forEach(slotCard => {
    const assignedDiv = slotCard.querySelector('.assigned-char');
    const charClass = assignedDiv ? assignedDiv.dataset.charClass : null;
    applySlotTint(slotCard, charClass);
  });
}

/* ── In-comp status indicators for the left-panel character cards ────── */
// Returns the set of character IDs currently assigned in the visible roster slots.
function getAssignedCharIdsFromDom() {
  const ids = new Set();
  document.querySelectorAll('.assigned-char[data-char-id]').forEach(el => {
    ids.add(el.dataset.charId);
  });
  return ids;
}

function updateCharInCompStatus() {
  const currentCompIds = getAssignedCharIdsFromDom();

  // Track which user-groups have any assigned character (for player-level indicator).
  const assignedGroupIds = new Set();

  document.querySelectorAll('.char-card').forEach(card => {
    // Collect all character IDs that belong to this card (one per spec).
    const allCharIds = new Set();
    card.querySelectorAll('.spec-btn[data-char-id]').forEach(btn => allCharIds.add(btn.dataset.charId));
    if (card.dataset.charId) allCharIds.add(card.dataset.charId);

    // Which comp numbers is this card's character already assigned to?
    const assignedComps = [];
    for (const cid of allCharIds) {
      // Current comp: check live DOM state (more up-to-date than server data).
      if (currentCompIds.has(cid) && !assignedComps.includes(CURRENT_COMP)) {
        assignedComps.push(CURRENT_COMP);
      }
      // Other comps: use the server-rendered snapshot.
      const serverComps = CHARS_IN_COMPS[cid] || [];
      for (const cn of serverComps) {
        if (cn !== CURRENT_COMP && !assignedComps.includes(cn)) {
          assignedComps.push(cn);
        }
      }
    }
    assignedComps.sort((a, b) => a - b);

    // Remove old badges container and recreate.
    let badgesContainer = card.querySelector('.char-in-comp-badges');
    if (assignedComps.length > 0) {
      card.classList.add('in-comp');
      if (!badgesContainer) {
        badgesContainer = document.createElement('div');
        badgesContainer.className = 'char-in-comp-badges';
        card.appendChild(badgesContainer);
      }
      // Rebuild one badge per assigned comp.
      badgesContainer.innerHTML = '';
      for (const cn of assignedComps) {
        const badge = document.createElement('span');
        badge.className = 'char-in-comp-badge';
        badge.textContent = '✓ ' + compTabLabel(cn);
        badge.title = 'Assigned to: ' + compTabLabel(cn);
        badgesContainer.appendChild(badge);
      }

      // Mark the containing user-group as having an assigned character in the current comp.
      if (assignedComps.includes(CURRENT_COMP)) {
        const ugDiv = card.closest('.user-group-container');
        if (ugDiv) assignedGroupIds.add(ugDiv.id);
      }
    } else {
      card.classList.remove('in-comp');
      if (badgesContainer) badgesContainer.remove();
    }
  });

  // Update player-level (user-group header) assignment indicators.
  document.querySelectorAll('.user-group-container').forEach(ugDiv => {
    const headerId = ugDiv.id + '-header';
    const header = document.getElementById(headerId);
    if (!header) return;
    let playerBadge = header.querySelector('.user-group-assigned-badge');
    if (assignedGroupIds.has(ugDiv.id)) {
      if (!playerBadge) {
        playerBadge = document.createElement('span');
        playerBadge.className = 'user-group-assigned-badge';
        playerBadge.title = 'Player has character(s) assigned to this comp';
        // Insert before the chevron (last child).
        const chevron = header.querySelector('.ug-chevron');
        if (chevron) header.insertBefore(playerBadge, chevron);
        else header.appendChild(playerBadge);
      }
      playerBadge.textContent = '✓';
    } else {
      if (playerBadge) playerBadge.remove();
    }
  });
}

// Called when a role icon button is clicked — updates data-slot-role, border colour, and slot label
// skipDirty is set internally when the call comes from a drop or remote-state sync
function setSlotRole(btn, role, skipDirty) {
  const slotCard = btn.closest('.slot-card');
  const slot     = slotCard.dataset.slot;      // "slot_N" — never changes
  const oldRole  = slotCard.dataset.slotRole;
  slotCard.dataset.slotRole = role;
  slotCard.classList.remove('slot-tank', 'slot-healer', 'slot-dps', 'slot-mdps', 'slot-rdps');
  slotCard.classList.add('slot-' + role);
  slotCard.querySelectorAll('.role-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.role === role);
  });
  const label = slotCard.querySelector('.slot-label');
  if (label) label.textContent = `${getRoleEmoji(role)}`;

  if (!skipDirty && !applyingRemote && oldRole !== role) {
    // If the slot has content, re-save with the new role immediately
    const assignedDiv = slotCard.querySelector('.assigned-char');
    const charId      = assignedDiv && assignedDiv.dataset.charId;
    const discordUserId = assignedDiv && assignedDiv.dataset.discordUserId && !charId ? assignedDiv.dataset.discordUserId : null;
    const placeholder = assignedDiv && assignedDiv.dataset.placeholder;
    if (charId) {
      addDirtyChange(slot, { slot_role: role, character_id: charId });
      clearTimeout(saveTimer);
      autoSave();
    } else if (discordUserId) {
      addDirtyChange(slot, { slot_role: role, discord_user_id: discordUserId });
      clearTimeout(saveTimer);
      autoSave();
    } else if (placeholder) {
      addDirtyChange(slot, { slot_role: role, placeholder_text: placeholder });
      clearTimeout(saveTimer);
      autoSave();
    }
    // Empty-slot role changes don't touch the DB (empty slots aren't persisted)
  }
}

// Called when a spec button is clicked — updates the card's active char ID and spec
function selectSpec(btn) {
  const card = btn.closest('.char-card');
  card.querySelectorAll('.spec-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  card.dataset.charId = btn.dataset.charId;
  card.dataset.spec   = btn.dataset.spec || '';
  // Update role hint from the spec button's data-role if present
  if (btn.dataset.role) card.dataset.role = btn.dataset.role;
}

/* ── Collapse / expand sign-up user groups ─────────────────────────── */
function toggleUserGroup(id, header) {
  const body    = document.getElementById(id);
  const chevron = header.querySelector('.ug-chevron');
  const collapsed = body.style.display === 'none';
  body.style.display  = collapsed ? '' : 'none';
  chevron.textContent = collapsed ? '▾' : '▸';
}

// ── Sign-ups pool role filter ────────────────────────────────────────────
function filterPool(role) {
  document.querySelectorAll('.pool-filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.role === role);
  });

  document.querySelectorAll('.user-group').forEach(group => {
    let anyVisible = false;
    group.querySelectorAll('.char-card').forEach(card => {
      const charClass = card.dataset.charClass || '';
      const allSpecs = (card.dataset.allSpecs || card.dataset.spec || '').split(',').filter(Boolean);
      const show = role === 'all' || allSpecs.some(s => {
        const r = specToRole(normalizeSpec(charClass, s), charClass);
        if (role === 'dps') return r === 'dps' || r === 'mdps' || r === 'rdps';
        return r === role;
      });
      card.style.display = show ? '' : 'none';
      if (show) anyVisible = true;
    });
    group.style.display = anyVisible ? '' : 'none';
  });
}

/* ── Drag start: character card ────────────────────────────────────── */
function onDragStart(event) {
  draggedPlaceholder      = null;
  draggedPlaceholderColor = null;
  draggedIsPlayer         = false;
  draggedDisplayLabel     = null;
  draggedCharId           = event.currentTarget.dataset.charId;
  draggedCharName         = event.currentTarget.dataset.charName;
  draggedCharClass        = event.currentTarget.dataset.charClass || null;
  draggedDiscordUserId    = event.currentTarget.dataset.discordUserId || null;
  draggedSpec             = event.currentTarget.dataset.spec || null;
  draggedRole             = specToRole(normalizeSpec(draggedCharClass, draggedSpec), draggedCharClass);
  event.dataTransfer.effectAllowed = 'move';
}

function onPlayerDragStart(event) {
  event.stopPropagation();
  draggedPlaceholder      = null;
  draggedPlaceholderColor = null;
  draggedCharId           = null;
  draggedCharName         = null;
  draggedCharClass        = null;
  draggedSpec             = null;
  draggedRole             = null;
  draggedIsPlayer         = true;
  draggedDiscordUserId    = event.currentTarget.dataset.discordUserId || null;
  draggedDisplayLabel     = event.currentTarget.dataset.displayLabel || null;
  event.dataTransfer.effectAllowed = 'move';
}

/* ── Drag start: placeholder chip ─────────────────────────────────── */
function onPlaceholderDragStart(event) {
  draggedIsPlayer         = false;
  draggedDisplayLabel     = null;
  draggedCharId           = null;
  draggedCharName         = null;
  draggedCharClass        = null;
  draggedDiscordUserId    = null;
  draggedSpec             = null;
  draggedRole             = event.currentTarget.dataset.role || null;
  draggedPlaceholder      = event.currentTarget.dataset.placeholder;
  draggedPlaceholderColor = event.currentTarget.dataset.color || null;
  event.dataTransfer.effectAllowed = 'copy';
}

/* ── Drop onto a roster slot ───────────────────────────────────────── */
function onDrop(event) {
  event.preventDefault();
  event.currentTarget.classList.remove('slot-drag-over');
  const slotCard    = event.currentTarget;
  const assignedDiv = slotCard.querySelector('.assigned-char');

  /* Placeholder drop */
  if (draggedPlaceholder) {
    assignedDiv.innerHTML = '';
    const label = document.createElement('span');
    label.className   = 'slot-placeholder-text placeholder-colored';
    label.textContent = draggedPlaceholder;
    const color = draggedPlaceholderColor || colorForPlaceholder(draggedPlaceholder);
    if (color) label.style.color = color;
    assignedDiv.appendChild(label);
    delete assignedDiv.dataset.charId;
    delete assignedDiv.dataset.discordUserId;
    assignedDiv.dataset.placeholder = draggedPlaceholder;
    delete assignedDiv.dataset.charClass;
    applySlotTint(slotCard, null);

    // Auto-detect role from the placeholder's data-role and set slot role
    if (draggedRole && ['tank', 'healer', 'dps', 'mdps', 'rdps'].includes(draggedRole)) {
      const roleBtn = slotCard.querySelector(`.role-btn[data-role="${draggedRole}"]`);
      if (roleBtn) setSlotRole(roleBtn, draggedRole, true); // skipDirty — we record below
    }

    draggedPlaceholder      = null;
    draggedPlaceholderColor = null;
    draggedRole             = null;
    addDirtyChange(slotCard.dataset.slot, { slot_role: slotCard.dataset.slotRole, placeholder_text: assignedDiv.dataset.placeholder });
    clearTimeout(saveTimer);
    updateBuffPanel();
    autoSave();
    return;
  }

  /* Player (any character) drop */
  if (draggedIsPlayer && draggedDiscordUserId) {
    /* Enforce one character/placeholder per Discord user */
    document.querySelectorAll('.assigned-char[data-discord-user-id]').forEach(el => {
      if (el.dataset.discordUserId === draggedDiscordUserId) {
        clearAssigned(el);
      }
    });

    assignedDiv.innerHTML = '';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'fw-bold';

    let isTentative = false;
    const header = document.getElementById(`ug-${draggedDiscordUserId}-header`) ||
                   Array.from(document.querySelectorAll('.user-group-header')).find(h => h.dataset.discordUserId === draggedDiscordUserId);
    if (header && header.classList.contains('tentative')) {
      isTentative = true;
    }

    nameSpan.textContent = draggedDisplayLabel + (isTentative ? ' [?]' : '');
    const specSmall = document.createElement('small');
    specSmall.className = 'text-muted d-block fst-italic';
    specSmall.textContent = 'Any Character';
    assignedDiv.appendChild(nameSpan);
    assignedDiv.appendChild(specSmall);
    assignedDiv.dataset.discordUserId = draggedDiscordUserId;
    delete assignedDiv.dataset.charId;
    delete assignedDiv.dataset.charClass;
    delete assignedDiv.dataset.placeholder;
    applySlotTint(slotCard, null);

    const finalUserId = draggedDiscordUserId;
    draggedDiscordUserId = null;
    draggedDisplayLabel  = null;
    draggedIsPlayer      = false;

    addDirtyChange(slotCard.dataset.slot, { slot_role: slotCard.dataset.slotRole, discord_user_id: finalUserId });
    updateCharInCompStatus();
    updateBuffPanel();
    clearTimeout(saveTimer);
    autoSave();
    return;
  }

  /* Character drop */
  if (!draggedCharId) return;

  /* Evict this exact spec from any slot it already occupies */
  document.querySelectorAll(`.assigned-char[data-char-id="${draggedCharId}"]`).forEach(el => {
    if (el !== assignedDiv) clearAssigned(el);
  });

  /* Enforce one character per Discord user */
  if (draggedDiscordUserId) {
    document.querySelectorAll('.assigned-char[data-discord-user-id]').forEach(el => {
      if (el.dataset.discordUserId === draggedDiscordUserId &&
          el.dataset.charId !== draggedCharId) {
        clearAssigned(el);
      }
    });
  }

  assignedDiv.innerHTML = '';
  const nameSpan = document.createElement('span');
  nameSpan.className   = `fw-bold${draggedCharClass ? ' cls-' + draggedCharClass : ''}`;

  let isTentative = false;
  if (draggedDiscordUserId) {
    const poolCard = document.querySelector(`.char-card[data-discord-user-id="${draggedDiscordUserId}"]`);
    if (poolCard) {
      const header = poolCard.closest('.user-group').querySelector('.user-group-header');
      if (header && header.classList.contains('tentative')) {
        isTentative = true;
      }
    }
  }

  nameSpan.textContent = draggedCharName + (isTentative ? ' [?]' : '');
  const specSmall = document.createElement('small');
  specSmall.className   = 'text-muted d-block';
  specSmall.textContent = draggedSpec || '?';
  assignedDiv.appendChild(nameSpan);
  assignedDiv.appendChild(specSmall);
  assignedDiv.dataset.charId = draggedCharId;
  if (draggedCharClass) assignedDiv.dataset.charClass = draggedCharClass;
  delete assignedDiv.dataset.placeholder;
  if (draggedDiscordUserId) assignedDiv.dataset.discordUserId = draggedDiscordUserId;
  applySlotTint(slotCard, draggedCharClass);

  // Auto-detect role from the character's data-role and set slot role
  if (draggedRole && ['tank', 'healer', 'dps', 'mdps', 'rdps'].includes(draggedRole)) {
    const roleBtn = slotCard.querySelector(`.role-btn[data-role="${draggedRole}"]`);
    if (roleBtn) setSlotRole(roleBtn, draggedRole, true); // skipDirty — we record below
  }

  const finalCharId = draggedCharId;
  draggedCharId        = null;
  draggedCharName      = null;
  draggedCharClass     = null;
  draggedDiscordUserId = null;
  draggedSpec          = null;
  draggedRole          = null;
  addDirtyChange(slotCard.dataset.slot, { slot_role: slotCard.dataset.slotRole, character_id: finalCharId });
  updateCharInCompStatus();
  updateBuffPanel();
  clearTimeout(saveTimer);
  autoSave();
}

/* ── Clear a single assigned-char div ─────────────────────────────── */
function clearAssigned(el) {
  const slotCard = el.closest('.slot-card');
  const slot     = slotCard ? slotCard.dataset.slot : null;
  el.innerHTML = '';
  const empty = document.createElement('span');
  empty.className   = 'text-muted small';
  empty.textContent = '— empty —';
  el.appendChild(empty);
  delete el.dataset.charId;
  delete el.dataset.discordUserId;
  delete el.dataset.charClass;
  delete el.dataset.placeholder;
  if (slotCard) applySlotTint(slotCard, null);
  if (!applyingRemote && slot) {
    addDirtyChange(slot, { clear: true });
  }
  if (!applyingRemote) updateCharInCompStatus();
  if (!applyingRemote) updateBuffPanel();
}

function clearSlot(btn) {
  clearAssigned(btn.closest('.slot-card').querySelector('.assigned-char'));
  clearTimeout(saveTimer);
  autoSave();
}

/* ── Per-slot dirty tracking ───────────────────────────────────────── */
// Map<slot_key, { slot_role?, character_id? | placeholder_text? | clear: true }>
const dirtyChanges = new Map();
// True while applying remote state — prevents re-marking as dirty
let applyingRemote = false;

function addDirtyChange(slot, change) {
  dirtyChanges.set(slot, change);
  markDirty();
}

/* ── Global dirty indicator & debounce timer ───────────────────────── */
let isDirty   = false;
let saveTimer = null;

function markDirty() {
  const saveStatus = document.getElementById('saveStatus');
  isDirty = true;
  if (saveStatus) saveStatus.textContent = '● unsaved';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => autoSave(), 2000);
}

function markClean(msg) {
  const saveStatus = document.getElementById('saveStatus');
  isDirty = dirtyChanges.size > 0;
  clearTimeout(saveTimer);
  if (saveStatus) saveStatus.textContent = isDirty ? '● unsaved' : (msg || '✓ saved');
}

/* ── Build payload from current DOM state (used by manual save only) ── */
function buildPayload() {
  const payload = [];
  document.querySelectorAll('.slot-card').forEach(slot => {
    const assignedDiv = slot.querySelector('.assigned-char');
    if (!assignedDiv) return;
    const charId = assignedDiv.dataset.charId;
    const discordUserId = assignedDiv.dataset.discordUserId && !charId ? assignedDiv.dataset.discordUserId : null;
    const placeholder = assignedDiv.dataset.placeholder;
    if (charId) {
      payload.push({ character_id: parseInt(charId), role_slot: slot.dataset.slot, slot_role: slot.dataset.slotRole });
    } else if (discordUserId) {
      payload.push({ discord_user_id: discordUserId, role_slot: slot.dataset.slot, slot_role: slot.dataset.slotRole });
    } else if (placeholder) {
      payload.push({ placeholder_text: placeholder, role_slot: slot.dataset.slot, slot_role: slot.dataset.slotRole });
    }
  });
  return payload;
}

/* ── Granular auto-save: only send dirty slots via PATCH ───────────── */
function autoSave() {
  if (!CAN_EDIT) return;
  if (dirtyChanges.size === 0) {
    markClean('✓ saved');
    return;
  }

  const payload = [];
  for (const [role_slot, change] of dirtyChanges) {
    payload.push({ role_slot, ...change });
  }

  fetch(`${RAID_URL}/manage?comp=${CURRENT_COMP}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  .then(r => r.json())
  .then(data => {
    const saveStatus = document.getElementById('saveStatus');
    if (!data.ok) {
      if (saveStatus) saveStatus.textContent = '⚠ save error';
      console.warn('Auto-save error:', data.error);
      return;
    }

    // Remove saved slots from the dirty map
    for (const s of (data.saved || [])) {
      dirtyChanges.delete(s.role_slot);
    }

    // Apply the authoritative full state returned by the server so all
    // clients converge — but skip any slots the user is still editing
    if (data.entries) {
      applyRemoteState(data.entries);
    }

    markClean('✓ auto-saved');
    lastKnownVersion = null; // reset so next poll picks up any further changes
  })
  .catch(err => {
    const saveStatus = document.getElementById('saveStatus');
    if (saveStatus) saveStatus.textContent = '⚠ save error';
    console.warn('Auto-save failed:', err);
  });
}

/* ── Manual save button (keeps the reload for tab refresh) ─────────── */
function saveComp() {
  if (!CAN_EDIT) return;
  clearTimeout(saveTimer);
  dirtyChanges.clear();
  const payload = buildPayload();
  fetch(`${RAID_URL}/manage?comp=${CURRENT_COMP}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  .then(r => r.json())
  .then(data => {
    if (data.ok) {
      window.location.reload();
    } else {
      alert('Error: ' + (data.error || 'Unable to save composition. Please try again.'));
    }
  })
  .catch(err => alert('Save failed: ' + err));
}

/* ── Auto-load polling (collaboration) ────────────────────────────── */
let lastKnownVersion = null;

// ── Helper: sync slot role button state to a given role ─────────────
function syncSlotRole(slotCard, slotRole) {
  if (!slotCard.classList.contains('slot-' + slotRole)) {
    const roleBtn = slotCard.querySelector(`.role-btn[data-role="${slotRole}"]`);
    if (roleBtn) setSlotRole(roleBtn, slotRole, true); // skipDirty
  }
}

function applyRemoteState(entries) {
  // Build a map of slot -> entry for quick lookup
  const remoteMap = {};
  for (const e of entries) remoteMap[e.role_slot] = e;

  applyingRemote = true;
  try {
    document.querySelectorAll('.slot-card').forEach(slotCard => {
      const slot = slotCard.dataset.slot;

      // Never clobber a slot the user is currently editing
      if (dirtyChanges.has(slot)) return;

      const assignedDiv = slotCard.querySelector('.assigned-char');
      if (!assignedDiv) return;

      const remote      = remoteMap[slot];
      const localCharId = assignedDiv.dataset.charId || null;
      const localPh     = assignedDiv.dataset.placeholder || null;

      if (!remote) {
        // Slot should be empty
        if (localCharId || localPh) clearAssigned(assignedDiv);
        return;
      }

      if (remote.character_id) {
        if (localCharId !== remote.character_id) {
          assignedDiv.innerHTML = '';
          const nameSpan = document.createElement('span');
          nameSpan.className   = `fw-bold${remote.char_class ? ' cls-' + remote.char_class : ''}`;

          let remoteIsTentative = false;
          const poolCard = document.querySelector(`.char-card[data-discord-user-id="${remote.discord_user_id}"]`);
          if (poolCard) {
            const header = poolCard.closest('.user-group').querySelector('.user-group-header');
            if (header && header.classList.contains('tentative')) {
              remoteIsTentative = true;
            }
          }

          nameSpan.textContent = (remote.char_name || '?') + (remoteIsTentative ? ' [?]' : '');
          const specSmall = document.createElement('small');
          specSmall.className   = 'text-muted d-block';
          specSmall.textContent = remote.spec || '?';
          assignedDiv.appendChild(nameSpan);
          assignedDiv.appendChild(specSmall);
          assignedDiv.dataset.charId = remote.character_id;
          if (remote.char_class) assignedDiv.dataset.charClass = remote.char_class;
          if (remote.discord_user_id) assignedDiv.dataset.discordUserId = remote.discord_user_id;
          delete assignedDiv.dataset.placeholder;
          applySlotTint(slotCard, remote.char_class || null);
          syncSlotRole(slotCard, remote.slot_role || 'dps');
        }
      } else if (remote.discord_user_id) {
        if (localCharId || assignedDiv.dataset.discordUserId !== remote.discord_user_id) {
          assignedDiv.innerHTML = '';
          const nameSpan = document.createElement('span');
          nameSpan.className = 'fw-bold';

          let remoteIsTentative = false;
          const header = Array.from(document.querySelectorAll('.user-group-header')).find(h => h.dataset.discordUserId === remote.discord_user_id);
          if (header && header.classList.contains('tentative')) {
            remoteIsTentative = true;
          }

          nameSpan.textContent = (remote.display_label || remote.char_name || '?') + (remoteIsTentative ? ' [?]' : '');
          const specSmall = document.createElement('small');
          specSmall.className = 'text-muted d-block fst-italic';
          specSmall.textContent = 'Any Character';
          assignedDiv.appendChild(nameSpan);
          assignedDiv.appendChild(specSmall);
          assignedDiv.dataset.discordUserId = remote.discord_user_id;
          delete assignedDiv.dataset.charId;
          delete assignedDiv.dataset.charClass;
          delete assignedDiv.dataset.placeholder;
          applySlotTint(slotCard, null);
          syncSlotRole(slotCard, remote.slot_role || 'dps');
        }
      } else if (remote.placeholder_text) {
        if (localPh !== remote.placeholder_text) {
          assignedDiv.innerHTML = '';
          const label = document.createElement('span');
          label.className   = 'slot-placeholder-text placeholder-colored';
          label.textContent = remote.placeholder_text;
          const color = colorForPlaceholder(remote.placeholder_text);
          if (color) label.style.color = color;
          assignedDiv.appendChild(label);
          delete assignedDiv.dataset.charId;
          delete assignedDiv.dataset.discordUserId;
          delete assignedDiv.dataset.charClass;
          assignedDiv.dataset.placeholder = remote.placeholder_text;
          applySlotTint(slotCard, null);
          syncSlotRole(slotCard, remote.slot_role || 'dps');
        }
      }
    });
  } finally {
    applyingRemote = false;
  }
  updateCharInCompStatus();
  updateBuffPanel();
}

function pollRemoteState() {
  if (document.hidden) return; // Don't poll hidden tabs
  fetch(`${RAID_URL}/manage/json?comp=${CURRENT_COMP}`)
    .then(r => r.json())
    .then(data => {
      if (!data.ok || !data.entries) return;
      if (data.version && data.version !== lastKnownVersion) {
        if (lastKnownVersion !== null) {
          // Remote state changed — apply non-dirty slots
          applyRemoteState(data.entries);
        }
        lastKnownVersion = data.version;
      }
    })
    .catch(() => {}); // Silently ignore poll errors
}

function compTabLabel(cn) {
  return COMP_LABELS[cn] || ('Raid ' + cn);
}

function showPostConfirmModal() {
  if (COMP_NUMBERS_ALL.length > 1) {
    // Multi-comp: show summary table for all comps and offer "post current" vs "post all"
    let html = '<p class="mb-2">Which composition(s) do you want to post to Discord?</p>';
    html += '<table class="table table-sm table-dark mb-2">';
    html += '<thead><tr><th>Comp</th><th>🛡️ Tanks</th><th>💚 Healers</th><th>⚔️ DPS</th><th>Total</th></tr></thead><tbody>';
    for (const cn of COMP_NUMBERS_ALL) {
      const s = COMP_SUMMARIES[cn] || { tank: 0, healer: 0, mdps: 0, rdps: 0, dps: 0 };
      const dpsTotal = (s.mdps || 0) + (s.rdps || 0) + (s.dps || 0);
      const total = (s.tank || 0) + (s.healer || 0) + dpsTotal;
      const isCurrent = cn === CURRENT_COMP;
      html += `<tr${isCurrent ? ' class="table-warning"' : ''}>`;
      html += `<td>${compTabLabel(cn)}${isCurrent ? ' <small class="text-muted">(current)</small>' : ''}</td>`;
      html += `<td>${s.tank || 0}</td><td>${s.healer || 0}</td><td>${dpsTotal}</td><td><strong>${total}</strong></td>`;
      html += '</tr>';
    }
    html += '</tbody></table>';
    html += `<p class="text-muted mb-0" style="font-size:0.85rem;">Each comp will be posted as a separate Discord message.</p>`;
    document.getElementById('postConfirmSummary').innerHTML = html;
    document.getElementById('postConfirmBtn').style.display = 'none';
    document.getElementById('postCurrentBtn').style.display = '';
    document.getElementById('postAllBtn').textContent = `📋 Post All Comps (${COMP_NUMBERS_ALL.length})`;
    document.getElementById('postAllBtn').style.display = '';
  } else {
    // Single comp: existing behaviour
    let tanks = 0, healers = 0, dpsTotal = 0, placeholders = 0;
    document.querySelectorAll('.slot-card').forEach(card => {
      const assignedDiv = card.querySelector('.assigned-char');
      const charId      = assignedDiv && assignedDiv.dataset.charId;
      const placeholder = assignedDiv && assignedDiv.dataset.placeholder;
      if (!charId && !placeholder) return;
      const role = card.dataset.slotRole || 'dps';
      if (role === 'tank') tanks++;
      else if (role === 'healer') healers++;
      else dpsTotal++;
      if (placeholder) placeholders++;
    });
    const total = tanks + healers + dpsTotal;

    document.getElementById('postConfirmSummary').innerHTML =
      `<table class="table table-sm table-dark mb-0">` +
      `<tr><td>🛡️ Tanks</td><td><strong>${tanks}</strong></td></tr>` +
      `<tr><td>💚 Healers</td><td><strong>${healers}</strong></td></tr>` +
      `<tr><td>⚔️ DPS</td><td><strong>${dpsTotal}</strong></td></tr>` +
      `<tr><td><strong>Total</strong></td><td><strong>${total}</strong></td></tr>` +
      `</table>` +
      (placeholders > 0
        ? (() => {
            const pl = placeholders !== 1;
            return `<p class="text-warning mt-2 mb-0"><small>⚠️ ${placeholders} slot${pl ? 's' : ''} still ${pl ? 'have' : 'has'} placeholder assignment${pl ? 's' : ''}.</small></p>`;
          })()
        : '');
    document.getElementById('postConfirmBtn').style.display = '';
    document.getElementById('postCurrentBtn').style.display = 'none';
    document.getElementById('postAllBtn').style.display = 'none';
  }

  new bootstrap.Modal(document.getElementById('postConfirmModal')).show();
}

/* ── Right-panel tab switching ────────────────────────────────────── */
function switchRightTab(tab) {
  const isBuffs = tab === 'buffs';
  document.getElementById('panelPlaceholders').style.display = isBuffs ? 'none' : '';
  document.getElementById('panelBuffs').style.display = isBuffs ? '' : 'none';
  document.getElementById('tabBtnPlaceholders').classList.toggle('active', !isBuffs);
  document.getElementById('tabBtnBuffs').classList.toggle('active', isBuffs);
  if (isBuffs) renderBuffPanel();
}

// Map from predefined placeholder text → { cls: CSS-key, spec: Canonical Spec }
const PLACEHOLDER_CLASS_SPEC = {
  '🛡️ Tank':           { cls: null,            spec: null },
  '🛡️ Prot Paladin':   { cls: 'paladin',       spec: 'Protection' },
  '🛡️ Prot Warrior':   { cls: 'warrior',       spec: 'Protection' },
  '🛡️ Blood DK':       { cls: 'death-knight',  spec: 'Blood' },
  '🛡️ Feral (Bear)':   { cls: 'druid',         spec: 'Feral (Bear)' },
  '💚 Healer':          { cls: null,            spec: null },
  '💚 Holy Paladin':    { cls: 'paladin',       spec: 'Holy' },
  '💚 Holy Priest':     { cls: 'priest',        spec: 'Holy' },
  '💚 Disc Priest':     { cls: 'priest',        spec: 'Discipline' },
  '💚 Resto Druid':     { cls: 'druid',         spec: 'Restoration' },
  '💚 Resto Shaman':    { cls: 'shaman',        spec: 'Restoration' },
  '⚔️ DPS':             { cls: null,            spec: null }, // Legacy fallback
  '🗡️ Melee DPS':       { cls: null,            spec: null },
  '🗡️ Arms Warrior':    { cls: 'warrior',       spec: 'Arms' },
  '🗡️ Fury Warrior':    { cls: 'warrior',       spec: 'Fury' },
  '🗡️ Ret Paladin':     { cls: 'paladin',       spec: 'Retribution' },
  '🗡️ Feral (Cat)':     { cls: 'druid',         spec: 'Feral (Cat)' },
  '🗡️ Combat Rogue':    { cls: 'rogue',         spec: 'Combat' },
  '🗡️ Mutilate Rogue':  { cls: 'rogue',         spec: 'Assassination' },
  '🗡️ Enha Shaman':     { cls: 'shaman',        spec: 'Enhancement' },
  '🗡️ Frost DK':        { cls: 'death-knight',  spec: 'Frost' },
  '🗡️ Unholy DK':       { cls: 'death-knight',  spec: 'Unholy' },
  '🗡️ Blood DK DPS':   { cls: 'death-knight',  spec: 'Blood' },
  '🏹 Ranged DPS':      { cls: null,            spec: null },
  '🏹 Shadow Priest':   { cls: 'priest',        spec: 'Shadow' },
  '🏹 Balance Druid':   { cls: 'druid',         spec: 'Balance' },
  '🏹 MM Hunter':       { cls: 'hunter',        spec: 'Marksmanship' },
  '🏹 BM Hunter':       { cls: 'hunter',        spec: 'Beast Mastery' },
  '🏹 SV Hunter':       { cls: 'hunter',        spec: 'Survival' },
  '🏹 Arcane Mage':     { cls: 'mage',          spec: 'Arcane' },
  '🏹 Fire Mage':       { cls: 'mage',          spec: 'Fire' },
  '🏹 Frost Mage':      { cls: 'mage',          spec: 'Frost' },
  '🏹 Ele Shaman':      { cls: 'shaman',        spec: 'Elemental' },
  '🏹 Affli Warlock':   { cls: 'warlock',       spec: 'Affliction' },
  '🏹 Destro Warlock':  { cls: 'warlock',       spec: 'Destruction' },
  '🏹 Demo Warlock':    { cls: 'warlock',       spec: 'Demonology' },
};

// Returns true if (charClass CSS-key, canonicalSpec) matches a buff provider entry.
function specMatchesProvider(charClassCss, spec, provider) {
  // charClassCss: 'death-knight', 'paladin', etc.
  // provider.cls: 'death knight', 'paladin', etc.
  const cls = (charClassCss || '').replace(/-/g, ' ').toLowerCase();
  const provCls = (provider.cls || '').toLowerCase().replace(/-/g, ' ');
  if (cls !== provCls) return false;
  if (provider.spec === null) return true; // any spec of this class
  // Both sides should be canonical spec names from normalizeSpec() — compare exactly.
  return (spec || '').toLowerCase() === (provider.spec || '').toLowerCase();
}

// Returns { preferred: Set<id>, canBring: Set<id> } for a given charClass (CSS key) + spec text.
function getBuffTiersFromEntry(charClassCss, specText) {
  const spec     = normalizeSpec(charClassCss, specText);
  const preferred = new Set();
  const canBring  = new Set();
  for (const buff of WOTLK_RAID_BUFFS) {
    let matchedPref = false;
    for (const p of (buff.preferred || [])) {
      if (specMatchesProvider(charClassCss, spec, p)) { matchedPref = true; break; }
    }
    if (matchedPref) { preferred.add(buff.id); continue; }
    for (const p of (buff.can_bring || [])) {
      if (specMatchesProvider(charClassCss, spec, p)) { canBring.add(buff.id); break; }
    }
  }
  return { preferred, canBring };
}

// Collect buff tiers from all filled roster slots.
// Returns { preferred: Set, canBring: Set, placeholder: Set }
// preferred/canBring  = covered by a real assigned character
// placeholder         = covered only by a placeholder slot
function collectRosterBuffs() {
  const charPref = new Set();
  const charCb   = new Set();
  const phSet    = new Set();

  document.querySelectorAll('.slot-card').forEach(slotCard => {
    const assignedDiv = slotCard.querySelector('.assigned-char');
    if (!assignedDiv) return;

    const charId      = assignedDiv.dataset.charId || null;
    const charClass   = assignedDiv.dataset.charClass || null; // CSS key
    const placeholder = assignedDiv.dataset.placeholder || null;

    if (charId && charClass) {
      const specEl  = assignedDiv.querySelector('small');
      const rawSpec = specEl ? specEl.textContent.trim() : '';
      const { preferred, canBring } = getBuffTiersFromEntry(charClass, rawSpec);
      preferred.forEach(id => charPref.add(id));
      canBring.forEach(id => charCb.add(id));
    } else if (placeholder) {
      const info = PLACEHOLDER_CLASS_SPEC[placeholder];
      if (info && info.cls) {
        const { preferred, canBring } = getBuffTiersFromEntry(info.cls, info.spec || '');
        preferred.forEach(id => phSet.add(id));
        canBring.forEach(id => phSet.add(id));
      }
    }
  });

  return { preferred: charPref, canBring: charCb, placeholder: phSet };
}

// Render (or re-render) the buff panel HTML from scratch.
function renderBuffPanel() {
  const { preferred: prefIds, canBring: cbIds, placeholder: phIds } = collectRosterBuffs();
  const categories = [];
  const catMap = {};
  for (const buff of WOTLK_RAID_BUFFS) {
    if (!catMap[buff.cat]) { catMap[buff.cat] = []; categories.push(buff.cat); }
    catMap[buff.cat].push(buff);
  }

  // Legend
  let html = '<div class="buff-legend">' +
    '<span class="buff-legend-item buff-legend-active">● Covered</span>' +
    '<span class="buff-legend-item buff-legend-canbring">● Can bring</span>' +
    '<span class="buff-legend-item buff-legend-ph">◌ Placeholder</span>' +
    '<span class="buff-legend-item buff-legend-missing">● Missing</span>' +
    '</div>';

  for (const cat of categories) {
    html += `<div class="buff-category-label">${escapeHtml(cat)}</div>`;
    for (const buff of catMap[cat]) {
      const hasPref = prefIds.has(buff.id);
      const hasCb   = cbIds.has(buff.id);
      const hasPh   = phIds.has(buff.id);
      const cls = hasPref ? 'buff-active' : hasCb ? 'buff-can-bring' : hasPh ? 'buff-placeholder' : 'buff-missing';
      html += `<div class="buff-item ${cls}" data-buff-id="${escapeHtml(buff.id)}" title="${escapeHtml(buff.desc)}">` +
              `<span class="buff-dot"></span>` +
              `<span class="buff-name">${escapeHtml(buff.name)}</span>` +
              `</div>`;
    }
  }

  document.getElementById('buffPanelContent').innerHTML = html;
}

// Lightweight DOM-safe HTML escaper for use in innerHTML construction above.
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Update buff panel if it is currently visible.
function updateBuffPanel() {
  const panel = document.getElementById('panelBuffs');
  if (panel && panel.style.display !== 'none') {
    renderBuffPanel();
  }
}

/* ── Comp tab inline rename ───────────────────────────────────────── */
function buildTabDOM(labelText) {
  // Build the tab's inner DOM safely — no innerHTML with user content
  const span = document.createElement('span');
  span.id = 'activeTabLabel';
  span.textContent = labelText;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'comp-tab-rename-btn';
  btn.title = 'Rename this comp tab';
  btn.textContent = '✏️';
  btn.addEventListener('click', startTabRename);
  return [span, btn];
}

function startTabRename() {
  const tab = document.getElementById('activeCompTab');
  const labelEl = document.getElementById('activeTabLabel');
  const currentLabel = labelEl.textContent.trim();

  // Swap label + button for an input, using DOM API to avoid XSS
  tab.replaceChildren();
  const input = document.createElement('input');
  input.id = 'tabRenameInput';
  input.className = 'comp-tab-rename-input';
  input.type = 'text';
  input.maxLength = 100;
  input.value = currentLabel;
  input.title = 'Enter a name and press Enter, or Escape to cancel';
  tab.appendChild(input);
  input.focus();
  input.select();

  async function commitRename() {
    const newLabel = input.value.trim();
    try {
      const resp = await fetch(`${RAID_URL}/comp_label`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comp_number: CURRENT_COMP, label: newLabel }),
      });
      const data = await resp.json();
      if (data.ok) {
        COMP_LABELS[CURRENT_COMP] = data.label || null;
      }
    } catch (err) {
      console.error('[comp_label] rename failed:', err);
    }
    const finalLabel = COMP_LABELS[CURRENT_COMP] || ('Raid ' + CURRENT_COMP);
    tab.replaceChildren(...buildTabDOM(finalLabel));
  }

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
    if (e.key === 'Escape') { tab.replaceChildren(...buildTabDOM(currentLabel)); }
  });
  input.addEventListener('blur', () => {
    // Only commit if the input is still present (not already replaced by Escape)
    if (document.getElementById('tabRenameInput')) commitRename();
  });
}

/* ── Placeholder Preset Management ─────────────────────────────────── */

let _presetModalInstance = null;
let _presetWarnModalInstance = null;
let _pendingPresetSlots = null; // preset slots waiting for user confirmation

function openPresetModal() {
  if (!_presetModalInstance) {
    _presetModalInstance = new bootstrap.Modal(document.getElementById('presetModal'));
  }
  document.getElementById('presetNameInput').value = '';
  document.getElementById('presetSaveMsg').textContent = '';
  loadPresetList();
  _presetModalInstance.show();
}

function loadPresetList() {
  const listEl = document.getElementById('presetList');
  listEl.innerHTML = '<p class="text-muted text-center" style="font-size:0.85rem;">Loading…</p>';
  fetch('/raids/presets')
    .then(r => r.json())
    .then(data => {
      if (!data.ok) { listEl.innerHTML = '<p class="text-danger">Failed to load presets.</p>'; return; }
      if (data.presets.length === 0) {
        listEl.innerHTML = '<p class="text-muted text-center" style="font-size:0.85rem;">No presets yet. Save the current layout to create one.</p>';
        return;
      }
      listEl.innerHTML = '';
      for (const preset of data.presets) {
        const row = document.createElement('div');
        row.className = 'd-flex align-items-center justify-content-between gap-2 mb-2';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'flex-grow-1';
        nameSpan.style.fontSize = '0.9rem';
        nameSpan.textContent = preset.name;

        const loadBtn = document.createElement('button');
        loadBtn.type = 'button';
        loadBtn.className = 'btn btn-primary btn-sm';
        loadBtn.textContent = '▶ Load';
        loadBtn.onclick = () => initiateLoadPreset(preset.slots);

        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'btn btn-outline-danger btn-sm';
        delBtn.textContent = '✕';
        delBtn.title = 'Delete preset';
        delBtn.onclick = () => deletePreset(preset.id, row);

        row.appendChild(nameSpan);
        row.appendChild(loadBtn);
        row.appendChild(delBtn);
        listEl.appendChild(row);
      }
    })
    .catch(() => { listEl.innerHTML = '<p class="text-danger">Failed to load presets.</p>'; });
}

function saveCurrentAsPreset() {
  const name = document.getElementById('presetNameInput').value.trim();
  const msgEl = document.getElementById('presetSaveMsg');
  if (!name) { msgEl.textContent = '⚠️ Please enter a preset name.'; msgEl.style.color = '#ffc107'; return; }

  // Collect only placeholder-filled slots
  const slots = [];
  document.querySelectorAll('.slot-card').forEach(slotCard => {
    const assignedDiv = slotCard.querySelector('.assigned-char');
    if (!assignedDiv) return;
    const placeholder = assignedDiv.dataset.placeholder;
    if (!placeholder) return;
    slots.push({
      role_slot: slotCard.dataset.slot,
      slot_role: slotCard.dataset.slotRole || 'dps',
      placeholder_text: placeholder,
    });
  });

  if (slots.length === 0) {
    msgEl.textContent = '⚠️ No placeholder slots to save. Drag some placeholders onto the roster first.';
    msgEl.style.color = '#ffc107';
    return;
  }

  fetch('/raids/presets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, slots }),
  })
  .then(r => r.json())
  .then(data => {
    if (data.ok) {
      msgEl.textContent = `✓ Preset "${data.name}" saved (${slots.length} slot(s)).`;
      msgEl.style.color = '#198754';
      document.getElementById('presetNameInput').value = '';
      loadPresetList();
    } else {
      msgEl.textContent = '⚠️ ' + (data.error || 'Failed to save preset.');
      msgEl.style.color = '#dc3545';
    }
  })
  .catch(() => { msgEl.textContent = '⚠️ Failed to save preset.'; msgEl.style.color = '#dc3545'; });
}

function deletePreset(id, rowEl) {
  fetch(`/raids/presets/${id}`, { method: 'DELETE' })
    .then(r => r.json())
    .then(data => {
      if (data.ok) {
        rowEl.remove();
        const listEl = document.getElementById('presetList');
        if (!listEl.querySelector('.d-flex')) {
          listEl.innerHTML = '<p class="text-muted text-center" style="font-size:0.85rem;">No presets yet. Save the current layout to create one.</p>';
        }
      } else {
        alert('Failed to delete preset: ' + (data.error || 'Unknown error'));
      }
    })
    .catch(() => { alert('Failed to delete preset. Please try again.'); });
}

function initiateLoadPreset(slots) {
  // Count how many slots are currently filled with real players (not placeholders)
  let playerCount = 0;
  document.querySelectorAll('.slot-card').forEach(slotCard => {
    const assignedDiv = slotCard.querySelector('.assigned-char');
    if (assignedDiv && assignedDiv.dataset.charId) playerCount++;
  });

  if (playerCount > 0) {
    // Show warning modal
    _pendingPresetSlots = slots;
    document.getElementById('warnPlayerCount').textContent = playerCount;
    if (!_presetWarnModalInstance) {
      _presetWarnModalInstance = new bootstrap.Modal(document.getElementById('presetWarnModal'));
    }
    _presetWarnModalInstance.show();
  } else {
    applyPresetSlots(slots);
  }
}

function applyPresetSlots(slots) {
  // Close the preset modal first
  if (_presetModalInstance) _presetModalInstance.hide();

  // Clear all slots
  document.querySelectorAll('.slot-card').forEach(slotCard => {
    const assignedDiv = slotCard.querySelector('.assigned-char');
    if (!assignedDiv) return;
    if (assignedDiv.dataset.charId || assignedDiv.dataset.placeholder) {
      clearAssigned(assignedDiv);
    }
  });

  // Build a map of role_slot -> preset entry for quick lookup
  const presetMap = {};
  for (const entry of slots) presetMap[entry.role_slot] = entry;

  // Apply preset placeholders to matching slots
  document.querySelectorAll('.slot-card').forEach(slotCard => {
    const slot = slotCard.dataset.slot;
    const entry = presetMap[slot];
    if (!entry || !entry.placeholder_text) return;

    const assignedDiv = slotCard.querySelector('.assigned-char');
    if (!assignedDiv) return;

    assignedDiv.innerHTML = '';
    const label = document.createElement('span');
    label.className = 'slot-placeholder-text placeholder-colored';
    label.textContent = entry.placeholder_text;
    const color = colorForPlaceholder(entry.placeholder_text);
    if (color) label.style.color = color;
    assignedDiv.appendChild(label);
    assignedDiv.dataset.placeholder = entry.placeholder_text;
    delete assignedDiv.dataset.charId;
    delete assignedDiv.dataset.discordUserId;
    delete assignedDiv.dataset.charClass;
    applySlotTint(slotCard, null);

    // Set slot role from preset
    const slotRole = entry.slot_role || 'dps';
    const roleBtn = slotCard.querySelector(`.role-btn[data-role="${slotRole}"]`);
    if (roleBtn) setSlotRole(roleBtn, slotRole, true);

    addDirtyChange(slot, { slot_role: slotRole, placeholder_text: entry.placeholder_text });
  });

  updateBuffPanel();
  updateCharInCompStatus();
  clearTimeout(saveTimer);
  autoSave();
}

// Initialise everything once DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  applyPlaceholderColors();
  applyInitialTints();
  updateCharInCompStatus();

  // Start polling every 1 second; resume immediately when tab becomes visible
  setInterval(pollRemoteState, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollRemoteState(); });
  // Seed the initial version immediately
  pollRemoteState();

  // Initialise Bootstrap tooltips for sign-up note icons.
  document.querySelectorAll('[data-bs-toggle="tooltip"]').forEach(el => {
    new bootstrap.Tooltip(el);
  });

  document.getElementById('postConfirmBtn')?.addEventListener('click', () => {
    document.getElementById('postForm').submit();
  });

  document.getElementById('postCurrentBtn')?.addEventListener('click', () => {
    document.getElementById('postForm').submit();
  });

  document.getElementById('postAllBtn')?.addEventListener('click', () => {
    const form = document.getElementById('postForm');
    form.action = `${RAID_URL}/post_comp`;
    form.submit();
  });

  document.getElementById('presetWarnConfirmBtn')?.addEventListener('click', () => {
    if (_presetWarnModalInstance) _presetWarnModalInstance.hide();
    if (_pendingPresetSlots) {
      applyPresetSlots(_pendingPresetSlots);
      _pendingPresetSlots = null;
    }
  });

  // Render buff panel on initial load (needed for non-editors where the buffs
  // tab is already active but renderBuffPanel() has not been called yet).
  updateBuffPanel();
});
