'use strict';

const memberSearch = document.getElementById('guildMemberSearch');
const memberLinks = Array.from(document.querySelectorAll('#guildMemberList .guild-member-link'));

memberSearch?.addEventListener('input', () => {
  const query = memberSearch.value.trim().toLocaleLowerCase();
  let visible = 0;

  memberLinks.forEach((link) => {
    const matches = !query || link.dataset.memberSearch.includes(query);
    link.classList.toggle('d-none', !matches);
    if (matches) visible += 1;
  });

  const count = document.getElementById('guildMemberCount');
  if (count) count.textContent = `${visible} member${visible === 1 ? '' : 's'}`;
  document.getElementById('guildMemberEmpty')?.classList.toggle('d-none', visible !== 0);
});

const bulkMessageForm = document.getElementById('bulkMessageForm');
const characterFilter = document.getElementById('bulkCharacterFilter');
const rankFilter = document.getElementById('bulkRankFilter');
const rankFilterWrap = document.getElementById('bulkRankFilterWrap');
const rankCheckboxes = Array.from(document.querySelectorAll('.bulk-rank-checkbox'));
const specificPersonWrap = document.getElementById('bulkSpecificPersonWrap');
const specificPerson = document.getElementById('bulkSpecificPerson');
const messageAction = document.getElementById('bulkMessageAction');
const customMessageWrap = document.getElementById('bulkCustomMessageWrap');
const customMessage = document.getElementById('bulkCustomMessage');
const recipientCount = document.getElementById('bulkRecipientCount');
const bulkSubmit = document.getElementById('bulkMessageSubmit');

function matchingMemberCount() {
  const characterCriterion = characterFilter?.value || 'zero';
  if (characterCriterion === 'specific') {
    const selectedUserId = specificPerson?.value || '';
    return selectedUserId &&
      memberLinks.some((link) => link.dataset.userId === selectedUserId)
      ? 1
      : 0;
  }

  const rankIds = rankCheckboxes
    .filter((checkbox) => checkbox.checked)
    .map((checkbox) => checkbox.value);

  return memberLinks.filter((link) => {
    const count = Number(link.dataset.characterCount) || 0;
    if (characterCriterion === 'zero' && count !== 0) return false;
    if (characterCriterion === 'one_or_more' && count < 1) return false;
    return !rankIds.length || rankIds.includes(link.dataset.topRankId || '');
  }).length;
}

function refreshBulkMessageForm() {
  const count = matchingMemberCount();
  const maximum = Number(bulkMessageForm?.dataset.maxRecipients) || 0;
  const isCustom = messageAction?.value === 'custom';
  const isSpecific = characterFilter?.value === 'specific';
  const selectedRanks = rankCheckboxes.filter((checkbox) => checkbox.checked);

  recipientCount.textContent = `${count} recipient${count === 1 ? '' : 's'}`;
  recipientCount.classList.toggle('bg-danger', count > maximum);
  recipientCount.classList.toggle('bg-secondary', count <= maximum);
  customMessageWrap?.classList.toggle('d-none', !isCustom);
  if (customMessage) customMessage.required = isCustom;
  rankFilterWrap?.classList.toggle('d-none', isSpecific);
  specificPersonWrap?.classList.toggle('d-none', !isSpecific);
  if (specificPerson) specificPerson.required = isSpecific;
  if (bulkSubmit) bulkSubmit.disabled = count === 0 || count > maximum;
  const rankSummary = rankFilter?.querySelector('summary');
  if (rankSummary) {
    if (!selectedRanks.length) rankSummary.textContent = 'Any rank';
    else if (selectedRanks.length === 1) rankSummary.textContent = selectedRanks[0].dataset.rankName;
    else rankSummary.textContent = `${selectedRanks.length} ranks selected`;
  }
}

[characterFilter, specificPerson, messageAction, ...rankCheckboxes].forEach((control) => {
  control?.addEventListener('change', refreshBulkMessageForm);
});

bulkMessageForm?.addEventListener('submit', (event) => {
  const count = matchingMemberCount();
  const actionLabel = messageAction?.selectedOptions[0]?.textContent.trim() || 'message';
  if (!window.confirm(`Queue ${actionLabel} for ${count} Discord member${count === 1 ? '' : 's'}?`)) {
    event.preventDefault();
  }
});

if (bulkMessageForm) refreshBulkMessageForm();
