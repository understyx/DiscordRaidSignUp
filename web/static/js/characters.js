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
