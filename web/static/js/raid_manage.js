/**
 * Raid Roster Management Javascript
 */

let CAN_EDIT = false;
let CURRENT_COMP = 1;
let MAX_SIZE = 25;
let RAID_URL = '';
let COMP_NUMBERS_ALL = [];
let COMP_SUMMARIES = {};
let COMP_LABELS = {};
let COMP_META = {};
let currentRevision = 0;
let publishedRevision = null;
let CHARS_IN_COMPS = {};
let CHAR_COLLECTORS = {};
let WOTLK_RAID_BUFFS = [];
let EMOJIS = {};
let RAID_DATA = {};

const configEl = document.getElementById('rosterConfig');
if (configEl) {
  try {
    const config = JSON.parse(configEl.textContent);
    CAN_EDIT = config.CAN_EDIT;
    CURRENT_COMP = config.CURRENT_COMP;
    MAX_SIZE = config.MAX_SIZE || 25;
    RAID_URL = config.RAID_URL;
    COMP_NUMBERS_ALL = config.COMP_NUMBERS_ALL;
    COMP_SUMMARIES = config.COMP_SUMMARIES;
    COMP_LABELS = config.COMP_LABELS;
    COMP_META = config.COMP_META || {};
    currentRevision = Number(config.CURRENT_REVISION) || 0;
    publishedRevision =
      config.PUBLISHED_REVISION === null ? null : Number(config.PUBLISHED_REVISION);
    CHARS_IN_COMPS = config.CHARS_IN_COMPS;
    CHAR_COLLECTORS = config.CHAR_COLLECTORS || {};
    WOTLK_RAID_BUFFS = config.WOTLK_RAID_BUFFS;
    EMOJIS = config.EMOJIS || {};
    RAID_DATA = config.RAID || {};
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
let draggedGearscore     = null;
let draggedRole          = null;   // detected role for auto-slot-assignment
let draggedSfsCount      = null;
let draggedValCount      = null;
let draggedPlaceholder   = null;
let draggedPlaceholderColor = null;
let draggedIsPlayer      = false;
let selectedSourceEl     = null;

function announce(message) {
  const status = document.getElementById('saveStatus');
  if (status) status.textContent = message;
}

function clearSourceSelection() {
  if (selectedSourceEl) selectedSourceEl.classList.remove('assignment-source-selected');
  selectedSourceEl = null;
}

function markSourceSelected(element, label) {
  clearSourceSelection();
  selectedSourceEl = element;
  element.classList.add('assignment-source-selected');
  announce(`Selected ${label}. Choose a roster slot.`);
}

function populateCharacterDragData(card) {
  draggedPlaceholder = null;
  draggedPlaceholderColor = null;
  draggedIsPlayer = false;
  draggedCharId = card.dataset.charId;
  draggedCharName = card.dataset.charName;
  draggedCharClass = card.dataset.charClass || null;
  draggedDiscordUserId = card.dataset.discordUserId || null;
  draggedDisplayLabel = card.dataset.displayLabel || null;
  draggedSpec = card.dataset.spec || null;
  draggedGearscore = card.dataset.gearscore || null;
  draggedSfsCount = card.dataset.sfsCount === '' ? null : Number(card.dataset.sfsCount);
  draggedValCount = card.dataset.valCount === '' ? null : Number(card.dataset.valCount);
  draggedRole = specToRole(normalizeSpec(draggedCharClass, draggedSpec), draggedCharClass);
}

function selectCharacterSource(event, card) {
  if (!CAN_EDIT || card.dataset.unavailable === 'true') return;
  if (event && event.target.closest('button')) return;
  populateCharacterDragData(card);
  markSourceSelected(card, card.dataset.charName || 'character');
}

function selectPlayerSource(event, header) {
  if (event) event.stopPropagation();
  draggedPlaceholder = null;
  draggedPlaceholderColor = null;
  draggedCharId = null;
  draggedCharName = null;
  draggedCharClass = null;
  draggedSpec = null;
  draggedGearscore = null;
  draggedRole = null;
  draggedIsPlayer = true;
  draggedDiscordUserId = header.dataset.discordUserId || null;
  draggedDisplayLabel = header.dataset.displayLabel || null;
  markSourceSelected(header, draggedDisplayLabel || 'player');
}

function selectPlaceholderSource(chip) {
  draggedIsPlayer = false;
  draggedCharId = null;
  draggedCharName = null;
  draggedCharClass = null;
  draggedDiscordUserId = null;
  draggedSpec = null;
  draggedRole = chip.dataset.role || null;
  draggedPlaceholder = chip.dataset.placeholder;
  draggedPlaceholderColor = chip.dataset.color || null;
  markSourceSelected(chip, draggedPlaceholder || 'placeholder');
}

function assignSelectedToSlot(event, slotCard) {
  if (!CAN_EDIT || !selectedSourceEl) return;
  if (event && event.target.closest('button')) return;
  onDrop({ preventDefault() {}, currentTarget: slotCard });
}

function handleSlotKey(event, slotCard) {
  if (event.target !== slotCard) return;
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    assignSelectedToSlot(null, slotCard);
  }
}

function handleGroupHeaderKey(event, id, header) {
  if (event.target !== header) return;
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    toggleUserGroup(id, header);
  }
}

// Apply colors to any placeholder-colored spans already in the DOM
function applyPlaceholderColors() {
  document.querySelectorAll('.placeholder-colored').forEach(el => {
    const text = el.textContent || '';
    const color = colorForPlaceholder(text);
    if (color) el.style.color = color;
  });
}

function applySlotTint(slotCard, charClass) {
  const rgba = getClassColor(charClass, 0.22);
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
    if (assignedDiv && assignedDiv.dataset.charClass) {
      applySlotTint(slotCard, assignedDiv.dataset.charClass);
    }
  });
}

function syncCollectorControls(slotCard, entry = null) {
  const existing = slotCard.querySelector('.collector-btns');
  if (existing) existing.remove();
  if (!CAN_EDIT || !entry || !entry.character_id) return;

  const charClass = String(entry.char_class || '').toLowerCase();
  const canCollectSfs =
    ['paladin', 'death-knight', 'warrior'].includes(charClass) &&
    entry.sfs_count !== null &&
    Number(entry.sfs_count) < 50;
  const canCollectVal =
    ['paladin', 'priest', 'druid', 'shaman'].includes(charClass) &&
    entry.val_count !== null &&
    Number(entry.val_count) < 30;
  if (!canCollectSfs && !canCollectVal) return;

  const controls = document.createElement('div');
  controls.className = 'collector-btns';
  const addButton = (type, active, title, emoji) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `collector-btn ${type}-btn${active ? ' active' : ''}`;
    button.title = title;
    button.setAttribute('aria-label', title);
    button.textContent = emoji;
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleCollector(button, type);
    });
    controls.appendChild(button);
  };
  if (canCollectSfs) addButton('sfs', entry.is_sfs_collector, 'Elect as Shard Collector', '❄️');
  if (canCollectVal) addButton('val', entry.is_val_collector, "Elect as Val'anyr Collector", '🔨');
  slotCard.appendChild(controls);
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
    card.dataset.assignedCurrent = assignedComps.includes(CURRENT_COMP) ? 'true' : 'false';
    card.dataset.assignedElsewhere = assignedComps.some((cn) => cn !== CURRENT_COMP)
      ? 'true'
      : 'false';

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

      // Add collector icons if applicable - check all spec IDs for this card
      const collectorData = { sfs: [], val: [] };
      for (const cid of allCharIds) {
        const serverData = CHAR_COLLECTORS[cid] || { sfs: [], val: [] };
        serverData.sfs.forEach(cn => { if (!collectorData.sfs.includes(cn)) collectorData.sfs.push(cn); });
        serverData.val.forEach(cn => { if (!collectorData.val.includes(cn)) collectorData.val.push(cn); });

        // Check current live state for collectors
        document.querySelectorAll(`.slot-card .assigned-char[data-char-id="${cid}"]`).forEach(el => {
          const slotCard = el.closest('.slot-card');
          const sfsBtn = slotCard.querySelector('.collector-btn.sfs-btn');
          const valBtn = slotCard.querySelector('.collector-btn.val-btn');
          if (sfsBtn && sfsBtn.classList.contains('active') && !collectorData.sfs.includes(CURRENT_COMP)) collectorData.sfs.push(CURRENT_COMP);
          if (valBtn && valBtn.classList.contains('active') && !collectorData.val.includes(CURRENT_COMP)) collectorData.val.push(CURRENT_COMP);
        });
      }

      if (collectorData.sfs.length > 0) {
        const sfsBadge = document.createElement('span');
        sfsBadge.className = 'char-in-comp-badge sfs-collector-badge';
        sfsBadge.textContent = '❄️';
        sfsBadge.title = 'Collecting Shards';
        badgesContainer.appendChild(sfsBadge);
      }
      if (collectorData.val.length > 0) {
        const valBadge = document.createElement('span');
        valBadge.className = 'char-in-comp-badge val-collector-badge';
        valBadge.textContent = '🔨';
        valBadge.title = 'Collecting Fragments';
        badgesContainer.appendChild(valBadge);
      }

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
      header.closest('.user-group').dataset.assignedCurrent = 'true';
    } else {
      if (playerBadge) playerBadge.remove();
      header.closest('.user-group').dataset.assignedCurrent = 'false';
    }
  });
  applyPoolFilters();
  updateRosterSummary();
}

// Called when a role icon button is clicked (btnOrSlot is the button) or
// programmatically (btnOrSlot is the slot card).
// Updates data-slot-role, border colour, and slot label.
// skipDirty is set internally when the call comes from a drop or remote-state sync.
function setSlotRole(btnOrSlot, role, skipDirty) {
  const slotCard = btnOrSlot.classList.contains('slot-card') ? btnOrSlot : btnOrSlot.closest('.slot-card');
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
      addDirtyChange(slot, {
        slot_role: role,
        character_id: charId,
        is_sfs_collector: Boolean(slotCard.querySelector('.collector-btn.sfs-btn.active')),
        is_val_collector: Boolean(slotCard.querySelector('.collector-btn.val-btn.active')),
      });
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
  card.dataset.charId    = btn.dataset.charId;
  card.dataset.spec      = btn.dataset.spec || '';
  card.dataset.gearscore = btn.dataset.gs || '';
  // Update role hint from the spec button's data-role if present
  if (btn.dataset.role) card.dataset.role = btn.dataset.role;
}

/* ── Collapse / expand sign-up user groups ─────────────────────────── */
function toggleCollector(btn, type) {
  btn.classList.toggle('active');
  const slotCard = btn.closest('.slot-card');
  const assignedDiv = slotCard.querySelector('.assigned-char');
  const charId = assignedDiv.dataset.charId;
  const role = slotCard.dataset.slotRole || 'dps';

  const sfsBtn = slotCard.querySelector('.collector-btn.sfs-btn');
  const valBtn = slotCard.querySelector('.collector-btn.val-btn');

  addDirtyChange(slotCard.dataset.slot, {
    slot_role: role,
    character_id: charId,
    is_sfs_collector: sfsBtn ? sfsBtn.classList.contains('active') : false,
    is_val_collector: valBtn ? valBtn.classList.contains('active') : false
  });
  updateCharInCompStatus();
}

function toggleUserGroup(id, header) {
  const body    = document.getElementById(id);
  const chevron = header.querySelector('.ug-chevron');
  const collapsed = body.style.display === 'none';
  body.style.display  = collapsed ? '' : 'none';
  chevron.textContent = collapsed ? '▾' : '▸';
  header.setAttribute('aria-expanded', collapsed ? 'true' : 'false');
}

function expandAllPool() {
  document.querySelectorAll('.user-group-container').forEach(body => {
    body.style.display = '';
    const headerId = body.id + '-header';
    const header = document.getElementById(headerId);
    if (header) {
      const chevron = header.querySelector('.ug-chevron');
      if (chevron) chevron.textContent = '▾';
    }
  });
}

function collapseAllPool() {
  document.querySelectorAll('.user-group-container').forEach(body => {
    body.style.display = 'none';
    const headerId = body.id + '-header';
    const header = document.getElementById(headerId);
    if (header) {
      const chevron = header.querySelector('.ug-chevron');
      if (chevron) chevron.textContent = '▸';
    }
  });
}

function collapseInRaidPool() {
  document.querySelectorAll('.user-group-container').forEach(body => {
    const headerId = body.id + '-header';
    const header = document.getElementById(headerId);
    if (header && header.querySelector('.user-group-assigned-badge')) {
      body.style.display = 'none';
      const chevron = header.querySelector('.ug-chevron');
      if (chevron) chevron.textContent = '▸';
    }
  });
}

// ── Sign-ups pool filters ────────────────────────────────────────────────
let poolRoleFilter = 'all';
let poolStatusFilter = 'all';
let poolSearchQuery = '';

function filterPool(role) {
  poolRoleFilter = role;
  document.querySelectorAll('.pool-filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.role === role);
    btn.setAttribute('aria-pressed', btn.dataset.role === role ? 'true' : 'false');
  });
  applyPoolFilters();
}

function setPoolStatusFilter(status) {
  poolStatusFilter = status;
  document.querySelectorAll('.pool-status-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.status === status);
    btn.setAttribute('aria-pressed', btn.dataset.status === status ? 'true' : 'false');
  });
  applyPoolFilters();
}

function setPoolSearch(value) {
  poolSearchQuery = String(value || '').trim().toLowerCase();
  applyPoolFilters();
}

function applyPoolFilters() {
  let visibleGroups = 0;
  document.querySelectorAll('.user-group').forEach(group => {
    let anyVisible = false;
    group.querySelectorAll('.char-card').forEach(card => {
      const charClass = card.dataset.charClass || '';
      const allSpecs = (card.dataset.allSpecs || card.dataset.spec || '').split(',').filter(Boolean);
      const roleMatches = poolRoleFilter === 'all' || allSpecs.some(s => {
        const r = specToRole(normalizeSpec(charClass, s), charClass);
        if (poolRoleFilter === 'dps') return r === 'dps' || r === 'mdps' || r === 'rdps';
        return r === poolRoleFilter;
      });
      const unavailable = card.dataset.unavailable === 'true';
      const current = card.dataset.assignedCurrent === 'true';
      const elsewhere = card.dataset.assignedElsewhere === 'true';
      const tentative = group.dataset.tentative === 'true';
      const statusMatches =
        poolStatusFilter === 'all' ||
        (poolStatusFilter === 'unassigned' && !current && !elsewhere && !unavailable) ||
        (poolStatusFilter === 'elsewhere' && elsewhere) ||
        (poolStatusFilter === 'tentative' && tentative) ||
        (poolStatusFilter === 'unavailable' && unavailable);
      const searchText = `${group.dataset.searchText || ''} ${card.dataset.searchText || ''}`;
      const searchMatches = !poolSearchQuery || searchText.includes(poolSearchQuery);
      const show = roleMatches && statusMatches && searchMatches;
      card.style.display = show ? '' : 'none';
      if (show) anyVisible = true;
    });
    group.style.display = anyVisible ? '' : 'none';
    if (anyVisible) visibleGroups += 1;
  });
  const emptyMessage = document.getElementById('poolFilterEmpty');
  if (emptyMessage) emptyMessage.style.display = visibleGroups === 0 ? '' : 'none';
}

/* ── Drag start: character card ────────────────────────────────────── */
function onDragStart(event) {
  populateCharacterDragData(event.currentTarget);
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
  draggedGearscore        = null;
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
    syncCollectorControls(slotCard, null);

    // Auto-detect role from the placeholder's data-role and set slot role
    if (draggedRole && ['tank', 'healer', 'dps', 'mdps', 'rdps'].includes(draggedRole)) {
      setSlotRole(slotCard, draggedRole, true); // skipDirty — we record below
    }

    draggedPlaceholder      = null;
    draggedPlaceholderColor = null;
    draggedRole             = null;
    addDirtyChange(slotCard.dataset.slot, { slot_role: slotCard.dataset.slotRole, placeholder_text: assignedDiv.dataset.placeholder });
    clearTimeout(saveTimer);
    updateBuffPanel();
    autoSave();
    clearSourceSelection();
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
    syncCollectorControls(slotCard, null);

    const finalUserId = draggedDiscordUserId;
    draggedDiscordUserId = null;
    draggedDisplayLabel  = null;
    draggedIsPlayer      = false;

    addDirtyChange(slotCard.dataset.slot, { slot_role: slotCard.dataset.slotRole, discord_user_id: finalUserId });
    updateCharInCompStatus();
    updateBuffPanel();
    clearTimeout(saveTimer);
    autoSave();
    clearSourceSelection();
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

  nameSpan.textContent = draggedCharName + (draggedDisplayLabel ? ` (${draggedDisplayLabel})` : '') + (isTentative ? ' [?]' : '');
  const specSmall = document.createElement('small');
  specSmall.className   = 'text-muted d-block';
  specSmall.textContent = `${draggedSpec || '?'} ${formatGearscore(draggedGearscore)}`;
  assignedDiv.appendChild(nameSpan);
  assignedDiv.appendChild(specSmall);
  assignedDiv.dataset.charId = draggedCharId;
  if (draggedCharClass) assignedDiv.dataset.charClass = draggedCharClass;
  delete assignedDiv.dataset.placeholder;
  if (draggedDiscordUserId) assignedDiv.dataset.discordUserId = draggedDiscordUserId;
  applySlotTint(slotCard, draggedCharClass);
  syncCollectorControls(slotCard, {
    character_id: draggedCharId,
    char_class: draggedCharClass,
    sfs_count: draggedSfsCount,
    val_count: draggedValCount,
    is_sfs_collector: false,
    is_val_collector: false,
  });

  // Auto-detect role from the character's data-role and set slot role
  if (draggedRole && ['tank', 'healer', 'dps', 'mdps', 'rdps'].includes(draggedRole)) {
    setSlotRole(slotCard, draggedRole, true); // skipDirty — we record below
  }

  const finalCharId = draggedCharId;
  draggedCharId        = null;
  draggedCharName      = null;
  draggedCharClass     = null;
  draggedDiscordUserId = null;
  draggedSpec          = null;
  draggedGearscore     = null;
  draggedRole          = null;
  draggedSfsCount      = null;
  draggedValCount      = null;
  addDirtyChange(slotCard.dataset.slot, { slot_role: slotCard.dataset.slotRole, character_id: finalCharId });
  updateCharInCompStatus();
  updateBuffPanel();
  clearTimeout(saveTimer);
  autoSave();
  clearSourceSelection();
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
  if (slotCard) syncCollectorControls(slotCard, null);
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
const serverStateBySlot = new Map();
// True while applying remote state — prevents re-marking as dirty
let applyingRemote = false;

function addDirtyChange(slot, change) {
  dirtyChanges.set(slot, change);
  markDirty();
}

function comparableEntry(entry) {
  if (!entry || entry.clear) return null;
  return {
    slot_role: entry.slot_role || 'dps',
    character_id: entry.character_id ? String(entry.character_id) : null,
    discord_user_id: entry.character_id
      ? null
      : entry.discord_user_id
        ? String(entry.discord_user_id)
        : null,
    placeholder_text: entry.placeholder_text || null,
    is_sfs_collector: Boolean(entry.is_sfs_collector),
    is_val_collector: Boolean(entry.is_val_collector),
  };
}

function updateServerSnapshot(entries, { preserveDirty = false } = {}) {
  const remote = new Map((entries || []).map((entry) => [entry.role_slot, comparableEntry(entry)]));
  document.querySelectorAll('.slot-card').forEach((slotCard) => {
    const slot = slotCard.dataset.slot;
    if (preserveDirty && dirtyChanges.has(slot)) return;
    serverStateBySlot.set(slot, remote.get(slot) || null);
  });
}

function seedServerSnapshotFromDom() {
  const entries = buildPayload();
  updateServerSnapshot(entries);
}

/* ── Global dirty indicator & debounce timer ───────────────────────── */
let isDirty   = false;
let saveTimer = null;

function markDirty() {
  const saveStatus = document.getElementById('saveStatus');
  isDirty = true;
  if (saveStatus) saveStatus.textContent = '● unsaved changes';
  updatePublishState();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => autoSave(), 2000);
}

function markClean(msg) {
  const saveStatus = document.getElementById('saveStatus');
  isDirty = dirtyChanges.size > 0;
  clearTimeout(saveTimer);
  if (saveStatus) saveStatus.textContent = isDirty ? '● unsaved' : (msg || '✓ saved');
  updatePublishState();
}

function updatePublishState() {
  const element = document.getElementById('publishState');
  if (!element) return;
  if (publishedRevision === null) {
    element.textContent = 'Not published';
    element.className = 'publish-state not-published';
  } else if (isDirty || currentRevision !== publishedRevision) {
    element.textContent = 'Changed since publish';
    element.className = 'publish-state changed';
  } else {
    element.textContent = 'Published · up to date';
    element.className = 'publish-state current';
  }
}

function updateRosterSummary() {
  const summary = document.getElementById('rosterSummary');
  if (!summary) return;
  const counts = { tank: 0, healer: 0, mdps: 0, rdps: 0, dps: 0 };
  let filled = 0;
  let placeholders = 0;
  document.querySelectorAll('.slot-card').forEach((slot) => {
    const assigned = slot.querySelector('.assigned-char');
    if (!assigned) return;
    const occupied =
      assigned.dataset.charId || assigned.dataset.discordUserId || assigned.dataset.placeholder;
    if (!occupied) return;
    filled += 1;
    const role = slot.dataset.slotRole || 'dps';
    if (Object.prototype.hasOwnProperty.call(counts, role)) counts[role] += 1;
    if (assigned.dataset.placeholder || (assigned.dataset.discordUserId && !assigned.dataset.charId)) {
      placeholders += 1;
    }
  });
  summary.textContent = `${filled}/${MAX_SIZE} filled · ${counts.tank} tank · ${counts.healer} heal · ${counts.mdps} melee · ${counts.rdps} ranged${placeholders ? ` · ${placeholders} unresolved` : ''}`;
  summary.classList.toggle('incomplete', filled < MAX_SIZE || placeholders > 0);
}

/* ── Build a normalized snapshot from the current roster DOM ───────── */
function buildPayload() {
  const payload = [];
  document.querySelectorAll('.slot-card').forEach(slot => {
    const assignedDiv = slot.querySelector('.assigned-char');
    if (!assignedDiv) return;
    const charId = assignedDiv.dataset.charId;
    const discordUserId = assignedDiv.dataset.discordUserId && !charId ? assignedDiv.dataset.discordUserId : null;
    const placeholder = assignedDiv.dataset.placeholder;
    if (charId) {
      const sfsBtn = slot.querySelector('.collector-btn.sfs-btn');
      const valBtn = slot.querySelector('.collector-btn.val-btn');
      payload.push({
        character_id: parseInt(charId),
        role_slot: slot.dataset.slot,
        slot_role: slot.dataset.slotRole,
        is_sfs_collector: sfsBtn ? sfsBtn.classList.contains('active') : false,
        is_val_collector: valBtn ? valBtn.classList.contains('active') : false
      });
    } else if (discordUserId) {
      payload.push({ discord_user_id: discordUserId, role_slot: slot.dataset.slot, slot_role: slot.dataset.slotRole });
    } else if (placeholder) {
      payload.push({ placeholder_text: placeholder, role_slot: slot.dataset.slot, slot_role: slot.dataset.slotRole });
    }
  });
  return payload;
}

/* ── Serialized, revision-aware granular auto-save ─────────────────── */
let saveInFlight = null;
let retryTimer = null;
let retryDelayMs = 2000;

function changesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function scheduleSaveRetry() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    flushPendingChanges().catch(() => {});
  }, retryDelayMs);
  retryDelayMs = Math.min(retryDelayMs * 2, 30000);
}

async function performSaveQueue() {
  while (dirtyChanges.size > 0) {
    const snapshot = new Map(dirtyChanges);
    const changes = [...snapshot].map(([role_slot, change]) => ({ role_slot, ...change }));
    const saveStatus = document.getElementById('saveStatus');
    if (saveStatus) saveStatus.textContent = '↻ saving…';

    const response = await fetch(`${RAID_URL}/manage?comp=${CURRENT_COMP}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_revision: currentRevision, changes }),
    });
    const data = await response.json().catch(() => ({}));

    if (response.status === 409 && data.conflict) {
      const remoteBySlot = new Map(
        (data.entries || []).map((entry) => [entry.role_slot, comparableEntry(entry)])
      );
      const conflictingSlots = [...snapshot.keys()].filter(
        (slot) =>
          !changesEqual(serverStateBySlot.get(slot) || null, remoteBySlot.get(slot) || null)
      );
      if (conflictingSlots.length > 0) {
        const keepLocal = confirm(
          `Another officer changed ${conflictingSlots.join(', ')} while you were editing.\n\nChoose OK to keep your pending version, or Cancel to accept their version.`
        );
        if (!keepLocal) {
          for (const slot of conflictingSlots) dirtyChanges.delete(slot);
        }
      }
      currentRevision = Number(data.revision) || 0;
      if (data.entries) applyRemoteState(data.entries);
      updateServerSnapshot(data.entries, { preserveDirty: false });
      continue;
    }
    if (!response.ok || !data.ok) {
      throw new Error(data.error || `Save failed (${response.status})`);
    }

    currentRevision = Number(data.revision) || currentRevision;
    for (const [slot, savedChange] of snapshot) {
      const latest = dirtyChanges.get(slot);
      if (latest && changesEqual(latest, savedChange)) dirtyChanges.delete(slot);
    }
    if (data.entries) applyRemoteState(data.entries);
    updateServerSnapshot(data.entries);
    retryDelayMs = 2000;
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  markClean('✓ saved');
}

function flushPendingChanges() {
  if (!CAN_EDIT || dirtyChanges.size === 0) {
    if (!saveInFlight) markClean('✓ saved');
    return saveInFlight || Promise.resolve();
  }
  clearTimeout(saveTimer);
  if (saveInFlight) return saveInFlight;

  saveInFlight = performSaveQueue()
    .catch((error) => {
      const saveStatus = document.getElementById('saveStatus');
      if (saveStatus) saveStatus.textContent = '⚠ save failed · retrying';
      scheduleSaveRetry();
      throw error;
    })
    .finally(() => {
      saveInFlight = null;
    });
  return saveInFlight;
}

function autoSave() {
  flushPendingChanges().catch((error) => console.warn('Auto-save failed:', error));
}

async function saveComp() {
  if (!CAN_EDIT) return;
  try {
    await flushPendingChanges();
    announce('✓ all changes saved');
  } catch (error) {
    alert(`Unable to save yet: ${error.message}. The page will keep retrying.`);
  }
}

let allowPageExit = false;

async function runAfterSave(action) {
  try {
    await flushPendingChanges();
    return await action();
  } catch (error) {
    alert(`This action is paused because the roster is not saved yet: ${error.message}`);
  }
}

async function createComposition(action) {
  await runAfterSave(async () => {
    allowPageExit = false;
    try {
      const response = await fetch(`${RAID_URL}/comps`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, source_comp: CURRENT_COMP }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || 'Unable to create composition.');
      allowPageExit = true;
      window.location.href = `${RAID_URL}/manage?comp=${data.comp_number}`;
    } catch (error) {
      alert(error.message);
    }
  });
}

async function deleteCurrentComposition() {
  if (!confirm(`Delete ${compTabLabel(CURRENT_COMP)}? This removes its roster and publish history.`)) {
    return;
  }
  await runAfterSave(async () => {
    allowPageExit = false;
    try {
      const response = await fetch(`${RAID_URL}/comps/${CURRENT_COMP}`, { method: 'DELETE' });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || 'Unable to delete composition.');
      if (data.warning) alert(data.warning);
      allowPageExit = true;
      window.location.href = `${RAID_URL}/manage?comp=${data.next_comp}`;
    } catch (error) {
      alert(error.message);
    }
  });
}

/* ── Auto-load polling (collaboration) ────────────────────────────── */

// ── Helper: sync slot role button state to a given role ─────────────
function syncSlotRole(slotCard, slotRole) {
  if (!slotCard.classList.contains('slot-' + slotRole)) {
    setSlotRole(slotCard, slotRole, true); // skipDirty
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
      const localUserId = assignedDiv.dataset.discordUserId || null;

      if (!remote) {
        // Slot should be empty
        if (localCharId || localPh || localUserId) clearAssigned(assignedDiv);
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

          nameSpan.textContent = (remote.char_name || '?') + (remote.display_label ? ` (${remote.display_label})` : '') + (remoteIsTentative ? ' [?]' : '');
          const specSmall = document.createElement('small');
          specSmall.className   = 'text-muted d-block';
          specSmall.textContent = `${remote.spec || '?'} ${formatGearscore(remote.gearscore)}`;
          assignedDiv.appendChild(nameSpan);
          assignedDiv.appendChild(specSmall);
          assignedDiv.dataset.charId = remote.character_id;
          if (remote.char_class) assignedDiv.dataset.charClass = remote.char_class;
          if (remote.discord_user_id) assignedDiv.dataset.discordUserId = remote.discord_user_id;
          delete assignedDiv.dataset.placeholder;
          applySlotTint(slotCard, remote.char_class || null);
        }
        syncCollectorControls(slotCard, remote);
        syncSlotRole(slotCard, remote.slot_role || 'dps');
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
        }
        syncCollectorControls(slotCard, null);
        syncSlotRole(slotCard, remote.slot_role || 'dps');
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
        }
        syncCollectorControls(slotCard, null);
        syncSlotRole(slotCard, remote.slot_role || 'dps');
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
      const revision = Number(data.revision);
      const remotePublishedRevision =
        data.published_revision === null ? null : Number(data.published_revision);
      if (remotePublishedRevision !== publishedRevision) {
        publishedRevision = remotePublishedRevision;
        updatePublishState();
      }
      if (Number.isFinite(revision) && revision !== currentRevision) {
        currentRevision = revision;
        applyRemoteState(data.entries);
        updateServerSnapshot(data.entries, { preserveDirty: true });
        updatePublishState();
      }
    })
    .catch(() => {}); // Silently ignore poll errors
}

function compTabLabel(cn) {
  return COMP_LABELS[cn] || ('Raid ' + cn);
}

function showPostConfirmModal() {
  const summaryEl = document.getElementById('postConfirmSummary');
  const validationEl = document.getElementById('postValidationSummary');
  const postConfirmBtn  = document.getElementById('postConfirmBtn');
  const postCurrentBtn  = document.getElementById('postCurrentBtn');
  const postAllBtn      = document.getElementById('postAllBtn');

  // Show loading state immediately and open the modal
  summaryEl.innerHTML = '<div class="text-center text-muted py-3"><span class="spinner-border spinner-border-sm me-2"></span>Loading preview…</div>';
  if (validationEl) validationEl.innerHTML = '';
  postConfirmBtn.style.display  = 'none';
  postCurrentBtn.style.display  = 'none';
  postAllBtn.style.display      = 'none';

  new bootstrap.Modal(document.getElementById('postConfirmModal')).show();

  // Fetch full composition data for the preview
  flushPendingChanges()
    .then(() => fetch(`${RAID_URL}/comp_preview`))
    .then(r => r.json())
    .then(data => {
      if (!data.ok) {
        console.error('[postPreview] Error from server:', data.error);
        summaryEl.innerHTML = `<p class="text-danger">Failed to load preview: ${escapeHtml(data.error || 'Unknown error')}</p>`;
        return;
      }

      const allCompNums = data.allCompNumbers || [];
      const isMultiComp = allCompNums.length > 1;

      if (validationEl) {
        const warningItems = [];
        for (const cn of allCompNums) {
          const compData = data.comps[cn];
          for (const warning of compData?.warnings || []) {
            warningItems.push(
              `<li class="text-${warning.level === 'danger' ? 'danger' : warning.level === 'warning' ? 'warning' : 'info'}"><strong>${escapeHtml(compTabLabel(cn))}:</strong> ${escapeHtml(warning.message)}</li>`
            );
          }
        }
        validationEl.innerHTML = warningItems.length
          ? `<div class="publish-validation"><strong>Review before publishing</strong><ul class="mb-0 mt-1">${warningItems.join('')}</ul></div>`
          : '<div class="alert alert-success py-2 mb-0">✓ All roster slots are resolved.</div>';
      }

      // Build Discord embed previews.
      // renderDiscordPreview escapes all user-supplied content via escapeHtml,
      // so assigning the generated HTML to innerHTML is safe.
      let previewHtml = '';
      for (const cn of allCompNums) {
        const compData = data.comps[cn];
        if (!compData) continue;
        previewHtml += renderDiscordPreview(RAID_DATA, compData.groups, cn, allCompNums.length, null, EMOJIS);
      }

      if (isMultiComp) {
        // Safe: fixed literal prefix + previewHtml generated by renderDiscordPreview (escapeHtml throughout)
        summaryEl.innerHTML =  // lgtm[js/xss-through-dom]
          `<p class="mb-2 text-muted" style="font-size:0.85rem;">Which composition(s) do you want to post to Discord? Each comp will be posted as a separate message.</p>` +
          `<div class="discord-preview-scroll-wrap">${previewHtml}</div>`;
        postCurrentBtn.textContent = `📋 Post ${escapeHtml(compTabLabel(CURRENT_COMP))} Only`;
        postCurrentBtn.style.display = '';
        postAllBtn.textContent = `📋 Post All Comps (${allCompNums.length})`;
        postAllBtn.style.display = '';
      } else {
        // Safe: fixed literal wrapper + previewHtml generated by renderDiscordPreview (escapeHtml throughout)
        summaryEl.innerHTML = `<div class="discord-preview-scroll-wrap">${previewHtml}</div>`; // lgtm[js/xss-through-dom]
        postConfirmBtn.style.display = '';
      }
    })
    .catch(err => {
      summaryEl.innerHTML = `<p class="text-danger">The roster could not be saved and previewed: ${escapeHtml(err.message)}. Publishing is paused until saving succeeds.</p>`;
    });
}

/* ── Right-panel tab switching ────────────────────────────────────── */
function switchRightTab(tab) {
  const isBuffs = tab === 'buffs';
  const panelPh = document.getElementById('panelPlaceholders');
  const panelBf = document.getElementById('panelBuffs');
  if (panelPh) panelPh.style.display = isBuffs ? 'none' : '';
  if (panelBf) panelBf.style.display = isBuffs ? '' : 'none';

  const tabPh = document.getElementById('tabBtnPlaceholders');
  const tabBf = document.getElementById('tabBtnBuffs');
  if (tabPh) tabPh.classList.toggle('active', !isBuffs);
  if (tabBf) tabBf.classList.toggle('active', isBuffs);

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
      // Strip trailing gearscore and BiS (e.g. "Protection 6200 BiS" -> "Protection")
      let rawSpec = specEl ? specEl.textContent.trim() : '';
      rawSpec = rawSpec.replace(/\s+\d+\s+BiS$/i, '')
                      .replace(/\s+\d+$/i, '')
                      .replace(/\s+BiS$/i, '');

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



function discordEmojiToHtml(emojiStr) {
  if (!emojiStr) return '';
  const customMatch = emojiStr.match(/<a?:[a-zA-Z0-9_]+:([0-9]+)>/);
  if (customMatch) {
    const id = customMatch[1];
    return `<img src="https://cdn.discordapp.com/emojis/${id}.webp?size=44&quality=lossless" class="discord-emoji" alt="emoji">`;
  }
  return emojiStr;
}

function getRoleBasedSpecFrontend(charClass, role) {
  const cls = (charClass || '').toLowerCase().replace(/-/g, ' ').trim();
  if (role === 'tank') {
    if (cls === 'paladin') return 'Protection';
    if (cls === 'druid') return 'Guardian';
    if (cls === 'warrior') return 'Protection';
    if (cls === 'death knight') return 'Blood';
  } else if (role === 'healer') {
    if (cls === 'paladin') return 'Holy';
    if (cls === 'priest') return 'Holy';
    if (cls === 'shaman') return 'Restoration';
    if (cls === 'druid') return 'Restoration';
  }
  return null;
}

function getCanonicalSpecFrontend(charClass, specText) {
  if (!specText) return null;
  const cls = (charClass || '').toLowerCase().replace(/-/g, ' ').trim();
  const firstSpec = specText.split(',')[0].trim();
  const s = firstSpec.toLowerCase();
  const clsMap = (typeof SPEC_ALIASES !== 'undefined') ? SPEC_ALIASES[cls] : null;
  if (clsMap) {
    if (clsMap[s]) return clsMap[s];
    for (const [alias, canonical] of Object.entries(clsMap)) {
      if (s.includes(alias)) return canonical;
    }
  }
  return firstSpec.charAt(0).toUpperCase() + firstSpec.slice(1);
}

function renderDiscordPreview(raid, groups, compNumber, totalComps, compLabels, emojis) {
  const label = compTabLabel(compNumber);
  const compLabel = totalComps > 1 ? ` – ${label}` : '';
  const dateStr = `<span style="color:#adb1b4;">${new Date(raid.date).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short', timeZone: 'UTC' })} UTC</span>`;

  const sections = [
    { label: '🛡️ Tanks', keys: ['tank'] },
    { label: '💚 Healers', keys: ['healer'] },
    { label: '⚔️ DPS', keys: ['mdps', 'rdps', 'dps'] },
  ];

  let fieldsHtml = '';
  const seenUserIds = new Set();
  const userIdsForPings = [];

  const getEmojiData = (ems, className) => {
    if (!className) return null;
    const normalized = className.toLowerCase().replace(/-/g, ' ');
    for (const key of Object.keys(ems)) {
      if (key.toLowerCase().replace(/-/g, ' ') === normalized) return ems[key];
    }
    return null;
  };

  for (const section of sections) {
    const entries = [];
    for (const key of section.keys) {
      if (groups[key]) entries.push(...groups[key]);
    }
    if (entries.length === 0) continue;

    const lines = entries.map(e => {
      let emoji = getRoleEmoji(e.slot_role);
      const uid = e.discord_user_id || (e.character && e.character.discord_user_id);
      if (uid && !seenUserIds.has(String(uid))) {
        seenUserIds.add(String(uid));
        userIdsForPings.push({ id: String(uid), label: e.display_label || (e.character && e.character.char_name) || 'user' });
      }

      if (!e.is_placeholder && !e.is_player_placeholder && e.character) {
        const c = e.character;
        const classData = getEmojiData(emojis, c.char_class);
        if (classData) {
          let specToLookup = null;
          if (c.spec && classData.specs && classData.specs[c.spec]) {
            specToLookup = c.spec;
          }
          if (!specToLookup) {
            const canonical = getCanonicalSpecFrontend(c.char_class, c.spec);
            if (canonical && classData.specs && classData.specs[canonical]) specToLookup = canonical;
          }
          if (!specToLookup) {
            const roleBased = getRoleBasedSpecFrontend(c.char_class, e.slot_role);
            if (roleBased && classData.specs && classData.specs[roleBased]) specToLookup = roleBased;
          }

          if (specToLookup && classData.specs && classData.specs[specToLookup]) {
            emoji = classData.specs[specToLookup];
          } else if (classData.emoji) {
            emoji = classData.emoji;
          }
        }
      }

      const emojiHtml = discordEmojiToHtml(emoji);
      if (e.is_placeholder) {
        const text = e.placeholder_text || '?';
        const startsWithEmoji = /^\p{Emoji}/u.test(text);
        return `<div>${startsWithEmoji ? '' : emojiHtml + ' '}<em>${escapeHtml(text)}</em></div>`;
      }
      if (e.is_player_placeholder) {
        const mention = e.discord_user_id ? ` <span class="discord-mention">@${escapeHtml(e.display_label || 'User')}</span>` : '';
        return `<div>${emojiHtml} <strong>Any Character</strong>${mention}</div>`;
      }
      const c = e.character;
      const mention = c.discord_user_id ? ` <span class="discord-mention">@${escapeHtml(e.display_label || c.char_name)}</span>` : '';
      const tentative = c.status === 'tentative' ? ' <span style="color:#8a95b0;">[:question:]</span>' : '';
      return `<div>${emojiHtml} <strong>${escapeHtml(c.char_name)}</strong>${mention}${tentative}</div>`;
    });

    fieldsHtml += `
      <div class="discord-embed-field">
        <div class="discord-embed-field-name">${section.label} [${entries.length}]</div>
        <div class="discord-embed-field-value">${lines.join('')}</div>
      </div>`;
  }

  const pingsHtml = userIdsForPings.length > 0
    ? `<div class="discord-content-pings">${userIdsForPings.map(u => `<span class="discord-mention">@${escapeHtml(u.label)}</span>`).join(' ')}</div>`
    : '';

  return `
    <div class="discord-preview-item mb-4">
      ${pingsHtml}
      <div class="discord-embed">
        <div class="discord-embed-title">📋 ${escapeHtml(raid.name)}${escapeHtml(compLabel)}</div>
        <div class="discord-embed-description"><strong>${escapeHtml(raid.raid_instance)}</strong> | ${dateStr}</div>
        ${fieldsHtml}
        <div style="font-size:0.75rem; color:#8a95b0; margin-top:0.5rem;">Raid ID: ${raid.id}</div>
      </div>
    </div>`;
}

function escapeHtml(str) {
  if (!str) return '';
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
        currentRevision = Number(data.revision) || currentRevision;
        updatePublishState();
      } else {
        throw new Error(data.error || 'Rename failed.');
      }
    } catch (err) {
      console.error('[comp_label] rename failed:', err);
      announce(`⚠ rename failed: ${err.message}`);
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

/* ── Officer Player Notes ─────────────────────────────────────────── */

let _officerNoteModalInstance = null;

function openOfficerNoteModal(event, btn) {
  event.stopPropagation();
  if (!_officerNoteModalInstance) {
    _officerNoteModalInstance = new bootstrap.Modal(document.getElementById('officerNoteModal'));
  }
  document.getElementById('officerNoteUserId').value = btn.dataset.discordUserId;
  document.getElementById('officerNotePlayerName').textContent = btn.dataset.displayLabel;
  document.getElementById('officerNoteText').value = btn.dataset.note || '';
  _officerNoteModalInstance.show();
}

function saveOfficerNote() {
  const discord_user_id = document.getElementById('officerNoteUserId').value;
  const note = document.getElementById('officerNoteText').value;

  fetch('/raids/player-note', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ discord_user_id, note }),
  })
  .then(r => r.json())
  .then(data => {
    if (data.ok) {
      if (_officerNoteModalInstance) _officerNoteModalInstance.hide();
      // Update all buttons for this user in the DOM
      document.querySelectorAll(`.officer-note-btn[data-discord-user-id="${discord_user_id}"]`).forEach(btn => {
        btn.dataset.note = data.note || '';
        btn.classList.toggle('has-note', !!data.note);
        btn.title = data.note ? `Officer Note: ${data.note}` : 'Officer Note';
      });
    } else {
      alert('Error saving note: ' + (data.error || 'Unknown error'));
    }
  })
  .catch(err => alert('Failed to save note: ' + err));
}

/* ── Placeholder Preset Management ─────────────────────────────────── */

let _presetModalInstance = null;
let _presetWarnModalInstance = null;
let _pendingPresetSlots = null; // preset slots waiting for user confirmation
let _pendingPresetMode = 'merge';

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
        const count = document.createElement('small');
        count.className = 'text-muted ms-2';
        count.textContent = `${preset.slots.length} slot${preset.slots.length === 1 ? '' : 's'}`;
        nameSpan.appendChild(count);

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
  const mode =
    document.querySelector('input[name="presetLoadMode"]:checked')?.value || 'merge';
  // Count how many slots are currently filled with real players (not placeholders)
  let playerCount = 0;
  document.querySelectorAll('.slot-card').forEach(slotCard => {
    const assignedDiv = slotCard.querySelector('.assigned-char');
    if (
      assignedDiv &&
      (assignedDiv.dataset.charId ||
        (assignedDiv.dataset.discordUserId && !assignedDiv.dataset.charId))
    ) {
      playerCount++;
    }
  });

  if (mode === 'replace' && playerCount > 0) {
    // Show warning modal
    _pendingPresetSlots = slots;
    _pendingPresetMode = mode;
    document.getElementById('warnPlayerCount').textContent = playerCount;
    if (!_presetWarnModalInstance) {
      _presetWarnModalInstance = new bootstrap.Modal(document.getElementById('presetWarnModal'));
    }
    _presetWarnModalInstance.show();
  } else {
    applyPresetSlots(slots, mode);
  }
}

async function updateRaidSize(newSize) {
  const resp = await fetch(`${RAID_URL}/size`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ max_size: newSize }),
  });
  return await resp.json();
}

async function increaseRaidSize() {
  const newSize = MAX_SIZE + 5;
  await runAfterSave(async () => {
    const data = await updateRaidSize(newSize);
    if (!data.ok) {
      allowPageExit = false;
      alert('Error increasing raid size: ' + (data.error || 'Unknown error'));
      return;
    }
    allowPageExit = true;
    window.location.reload();
  });
}

async function decreaseRaidSize() {
  const newSize = Math.max(1, MAX_SIZE - 5);
  await runAfterSave(async () => {
    const data = await updateRaidSize(newSize);
    if (!data.ok) {
      allowPageExit = false;
      alert('Unable to shrink the raid: ' + (data.error || 'Unknown error'));
      return;
    }
    allowPageExit = true;
    window.location.reload();
  });
}

function applyPresetSlots(slots, mode = 'merge') {
  // Close the preset modal first
  if (_presetModalInstance) _presetModalInstance.hide();

  // Find max slot required by the preset
  let requiredSize = 0;
  for (const s of slots) {
    const m = s.role_slot.match(/slot_(\d+)/);
    if (m) {
      const num = parseInt(m[1]);
      if (num > requiredSize) requiredSize = num;
    }
  }

  // If preset needs more slots than current MAX_SIZE, resize and reload
  if (requiredSize > MAX_SIZE) {
    sessionStorage.setItem('shouldApplyPreset', 'true');
    sessionStorage.setItem('pendingPreset', JSON.stringify(slots));
    sessionStorage.setItem('pendingPresetMode', mode);
    flushPendingChanges().then(() => updateRaidSize(requiredSize)).then(data => {
      if (data.ok) {
        window.location.reload();
      } else {
        alert('Error increasing raid size for preset: ' + (data.error || 'Unknown error'));
        sessionStorage.removeItem('shouldApplyPreset');
        sessionStorage.removeItem('pendingPreset');
        sessionStorage.removeItem('pendingPresetMode');
      }
    }).catch((error) => {
      alert('Unable to save before resizing for preset: ' + error.message);
      sessionStorage.removeItem('shouldApplyPreset');
      sessionStorage.removeItem('pendingPreset');
      sessionStorage.removeItem('pendingPresetMode');
    });
    return;
  }

  if (mode === 'replace') {
    document.querySelectorAll('.slot-card').forEach(slotCard => {
      const assignedDiv = slotCard.querySelector('.assigned-char');
      if (!assignedDiv) return;
      if (
        assignedDiv.dataset.charId ||
        assignedDiv.dataset.discordUserId ||
        assignedDiv.dataset.placeholder
      ) {
        clearAssigned(assignedDiv);
      }
    });
  }

  // Build a map of role_slot -> preset entry for quick lookup
  const presetMap = {};
  for (const entry of slots) presetMap[entry.role_slot] = entry;

  // Apply preset placeholders to matching slots
  let skippedPlayers = 0;
  document.querySelectorAll('.slot-card').forEach(slotCard => {
    const slot = slotCard.dataset.slot;
    const entry = presetMap[slot];
    if (!entry || !entry.placeholder_text) return;

    const assignedDiv = slotCard.querySelector('.assigned-char');
    if (!assignedDiv) return;
    if (
      mode === 'merge' &&
      (assignedDiv.dataset.charId ||
        (assignedDiv.dataset.discordUserId && !assignedDiv.dataset.charId))
    ) {
      skippedPlayers += 1;
      return;
    }

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
    setSlotRole(slotCard, slotRole, true);

    addDirtyChange(slot, { slot_role: slotRole, placeholder_text: entry.placeholder_text });
  });

  updateBuffPanel();
  updateCharInCompStatus();
  clearTimeout(saveTimer);
  autoSave();
  if (skippedPlayers) {
    announce(`Preset merged; ${skippedPlayers} occupied slot(s) were kept.`);
  }
}

// Initialise everything once DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  applyPlaceholderColors();
  applyInitialTints();
  updateCharInCompStatus();
  updatePublishState();
  seedServerSnapshotFromDom();
  filterPool(poolRoleFilter);
  setPoolStatusFilter(poolStatusFilter);

  document.querySelectorAll('.placeholder-chip').forEach((chip) => {
    chip.setAttribute('role', 'button');
    chip.setAttribute('tabindex', '0');
    chip.setAttribute('aria-label', `Select placeholder ${chip.dataset.placeholder || chip.textContent}`);
    chip.addEventListener('click', () => selectPlaceholderSource(chip));
    chip.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectPlaceholderSource(chip);
      }
    });
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && selectedSourceEl) {
      clearSourceSelection();
      announce('Assignment selection cleared.');
    }
  });

  document.querySelectorAll('.save-aware-nav').forEach((link) => {
    link.addEventListener('click', (event) => {
      if (allowPageExit) return;
      event.preventDefault();
      runAfterSave(() => {
        allowPageExit = true;
        window.location.href = link.href;
      });
    });
  });

  document.querySelectorAll('.save-aware-form').forEach((form) => {
    form.addEventListener('submit', (event) => {
      if (allowPageExit) return;
      event.preventDefault();
      runAfterSave(() => {
        allowPageExit = true;
        form.submit();
      });
    });
  });

  window.addEventListener('beforeunload', (event) => {
    if (allowPageExit || (!isDirty && !saveInFlight)) return;
    event.preventDefault();
    event.returnValue = '';
  });

  // Auto-apply preset after reload if requested
  if (sessionStorage.getItem('shouldApplyPreset') === 'true') {
    const slots = JSON.parse(sessionStorage.getItem('pendingPreset'));
    const mode = sessionStorage.getItem('pendingPresetMode') || 'merge';
    sessionStorage.removeItem('shouldApplyPreset');
    sessionStorage.removeItem('pendingPreset');
    sessionStorage.removeItem('pendingPresetMode');
    if (slots) {
      // Small delay to ensure everything is ready
      setTimeout(() => applyPresetSlots(slots, mode), 100);
    }
  }

  // Start polling every 1 second; resume immediately when tab becomes visible
  setInterval(pollRemoteState, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollRemoteState(); });
  // Seed the initial version immediately
  pollRemoteState();

  // Initialise Bootstrap tooltips for sign-up note icons.
  document.querySelectorAll('[data-bs-toggle="tooltip"]').forEach(el => {
    new bootstrap.Tooltip(el);
  });

  const submitPublishForm = (allComps) => {
    const lockCheckbox = document.getElementById('lockAfterPost');
    document.getElementById('lockAfterPostValue').value = lockCheckbox?.checked ? '1' : '0';
    runAfterSave(() => {
      const form = document.getElementById('postForm');
      if (allComps) form.action = `${RAID_URL}/post_comp`;
      allowPageExit = true;
      form.submit();
    });
  };

  document.getElementById('postConfirmBtn')?.addEventListener('click', () => {
    submitPublishForm(false);
  });

  document.getElementById('postCurrentBtn')?.addEventListener('click', () => {
    submitPublishForm(false);
  });

  document.getElementById('postAllBtn')?.addEventListener('click', () => {
    submitPublishForm(true);
  });

  document.getElementById('presetWarnConfirmBtn')?.addEventListener('click', () => {
    if (_presetWarnModalInstance) _presetWarnModalInstance.hide();
    if (_pendingPresetSlots) {
      applyPresetSlots(_pendingPresetSlots, _pendingPresetMode);
      _pendingPresetSlots = null;
      _pendingPresetMode = 'merge';
    }
  });

  // Render buff panel on initial load (needed for non-editors where the buffs
  // tab is already active but renderBuffPanel() has not been called yet).
  updateBuffPanel();
});
