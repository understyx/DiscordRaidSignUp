(() => {
  const feedback = document.getElementById('demoFeedback');
  const buttons = [...document.querySelectorAll('[data-demo-join]')];
  const initialLabels = buttons.map((button) => button.textContent);

  function setJoined(button, joined) {
    button.classList.toggle('joined', joined);
    button.textContent = joined ? 'Joined ✓' : button.dataset.initialLabel;
    button.closest('.demo-raid').classList.toggle('is-joined', joined);
  }

  buttons.forEach((button, index) => {
    button.dataset.initialLabel = initialLabels[index];
    button.addEventListener('click', () => {
      const joined = !button.classList.contains('joined');
      setJoined(button, joined);
      const raidName = button.closest('.demo-raid').querySelector('h3').textContent;
      feedback.textContent = joined
        ? `You joined ${raidName}. This is only a demo—no real sign-up was created.`
        : `You left ${raidName}. The sample roster is back to its starting state.`;
    });
  });

  document.getElementById('resetDemo').addEventListener('click', () => {
    buttons.forEach((button) => setJoined(button, false));
    feedback.textContent = 'Demo reset. Nothing was saved.';
  });
})();
