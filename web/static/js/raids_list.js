'use strict';

document.getElementById('loadMoreRaids')?.addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const status = document.getElementById('loadMoreRaidsStatus');
  const rows = document.getElementById('raidRows');
  const offset = Number.parseInt(button.dataset.offset, 10) || 0;

  button.disabled = true;
  button.textContent = 'Loading…';
  status?.classList.add('d-none');

  try {
    const response = await fetch(`/raids/more?offset=${offset}`, {
      headers: { Accept: 'application/json' },
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'Could not load raids.');

    rows.insertAdjacentHTML('beforeend', data.html);
    refreshRaidRelativeTimes(rows);
    button.dataset.offset = String(offset + data.count);
    if (data.has_more) {
      button.disabled = false;
      button.textContent = 'Show 10 more raids';
    } else {
      button.remove();
      if (status) {
        status.textContent = 'All raids are shown.';
        status.classList.remove('d-none');
      }
    }
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Try loading more raids again';
    if (status) {
      status.textContent = error.message || 'Could not load more raids.';
      status.classList.remove('d-none');
    }
  }
});
