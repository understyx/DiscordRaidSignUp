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
