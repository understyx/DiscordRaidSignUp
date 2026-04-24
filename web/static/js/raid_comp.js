document.querySelectorAll('.placeholder-spec-text').forEach(el => {
  const color = colorForPlaceholder(el.dataset.placeholder || el.textContent);
  if (color) el.style.color = color;
});

// Apply class colour tint to character cards
document.querySelectorAll('.comp-char-card').forEach(card => {
  // Find a class colour from any cls-* class on a child element
  const clsEl = card.querySelector('[class*="cls-"]');
  if (!clsEl) return;
  const match = Array.from(clsEl.classList).find(c => c.startsWith('cls-'));
  if (!match) return;
  const charClass = match.replace('cls-', '');
  const rgba = getClassColor(charClass, 0.22);
  if (rgba) card.style.backgroundColor = rgba;
});

// Normalize displayed spec names using the shared normalizeSpec() function.
document.querySelectorAll('.comp-char-card').forEach(card => {
  const clsEl = card.querySelector('[class*="cls-"]');
  const specEl = card.querySelector('small.d-block');
  if (!clsEl || !specEl) return;
  const clsMatch = Array.from(clsEl.classList).find(c => c.startsWith('cls-'));
  if (!clsMatch) return;
  const charClass = clsMatch.replace('cls-', '');
  const rawSpec = specEl.textContent.trim();
  if (rawSpec && rawSpec !== '?') {
    const normalized = normalizeSpec(charClass, rawSpec);
    if (normalized) specEl.textContent = normalized;
  }
});
