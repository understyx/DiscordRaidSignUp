/**
 * Shared utility functions for WoW Raid Sign-Up System
 */

/**
 * Normalize a raw spec string (possibly user slang) to a canonical spec name.
 * Requires SPEC_ALIASES to be defined (usually loaded from /js/spec_aliases.js).
 * charClass: WoW class (case-insensitive, accepts 'death-knight' or 'Death Knight')
 * specText:  raw spec text (e.g. "owl", "boomkin", "Balance, Feral", "ret")
 * Returns the canonical spec name, or the original text (capitalized) as fallback.
 */
function normalizeSpec(charClass, specText) {
  if (!specText) return null;
  // Normalize charClass: 'death-knight' → 'death knight'
  const cls = (charClass || '').toLowerCase().replace(/-/g, ' ').trim();
  // Handle comma-separated specs from Warmane (e.g. "Balance, Feral") — use first
  const firstSpec = specText.split(',')[0].trim();
  const s = firstSpec.toLowerCase();

  // SPEC_ALIASES is expected to be a global constant
  const clsMap = typeof SPEC_ALIASES !== 'undefined' ? SPEC_ALIASES[cls] : null;
  if (clsMap) {
    // Exact alias match
    if (clsMap[s]) return clsMap[s];
    // Spec text contains a known alias (e.g. "Balance Druid" contains "balance")
    for (const [alias, canonical] of Object.entries(clsMap)) {
      if (s.includes(alias)) return canonical;
    }
  }
  // Fallback: capitalise the first word of the first spec
  return firstSpec.charAt(0).toUpperCase() + firstSpec.slice(1);
}

// ── Canonical spec → role lookup table ─────────────────────────────────
// Keys are the canonical spec names produced by normalizeSpec() / SPEC_ALIASES.
// Only healer and tank specs need entries; everything else defaults to 'dps'.
const SPEC_TO_ROLE = {
  // Healers
  'holy':         'healer',
  'discipline':   'healer',
  'restoration':  'healer',
  'mistweaver':   'healer',
  // Tanks
  'protection':   'tank',
  'blood':        'tank',
  'bear':         'tank',
  'guardian':     'tank',
  'brewmaster':   'tank',
  'vengeance':    'tank',
};

// Pre-compiled regexes for canonical specs to avoid re-compiling in specToRole()
const SPEC_ROLE_REGEXES = Object.keys(SPEC_TO_ROLE).map(canonical => ({
  role: SPEC_TO_ROLE[canonical],
  regex: new RegExp(`\\b${canonical}\\b`, 'i')
}));

const ROLE_EMOJIS = {
  tank: '🛡️',
  healer: '💚',
  dps: '⚔️',
  mdps: '🗡️',
  rdps: '🏹'
};

const CLASS_ROLES = {
  'warrior': 'mdps',
  'rogue': 'mdps',
  'death knight': 'mdps',
  'paladin': 'mdps', // Ret is mdps
  'shaman': 'mdps', // Enhancement is mdps, Elemental is rdps
  'hunter': 'rdps',
  'druid': 'mdps', // Feral is mdps, Balance is rdps
  'mage': 'rdps',
  'warlock': 'rdps',
  'priest': 'rdps'
};

const SPEC_ROLES = {
  'elemental': 'rdps',
  'balance': 'rdps',
  'shadow': 'rdps'
};

/**
 * Detect role from spec name.
 * `spec` should already be the canonical name returned by normalizeSpec().
 */
function specToRole(spec, charClass) {
  if (!spec) {
    if (charClass) {
      const cls = charClass.toLowerCase().replace(/-/g, ' ').trim();
      return CLASS_ROLES[cls] || 'dps';
    }
    return 'dps';
  }
  const s = spec.toLowerCase();

  // Honour explicit inline role markers (e.g. "Blood (DPS)", "Feral (Bear) (Tank)")
  if (s.includes('(tank)'))  return 'tank';
  if (s.includes('(heal)') || s.includes('(healer)')) return 'healer';
  if (s.includes('(dps)'))   return 'dps';

  // Exact lookup against canonical spec names
  if (SPEC_TO_ROLE[s]) return SPEC_TO_ROLE[s];

  // Word-boundary lookup for composite names like "Feral (Bear)" or "Holy Paladin".
  // This prevents "Unholy" from matching "holy".
  for (const { role, regex } of SPEC_ROLE_REGEXES) {
    if (regex.test(s)) return role;
  }

  // Check specific specs for rdps vs mdps
  for (const [specName, role] of Object.entries(SPEC_ROLES)) {
    if (s.includes(specName)) return role;
  }

  // Fallback to class-based role detection for DPS
  if (charClass) {
    const cls = charClass.toLowerCase().replace(/-/g, ' ').trim();
    return CLASS_ROLES[cls] || 'dps';
  }

  return 'dps';
}

function getRoleEmoji(role) {
  return ROLE_EMOJIS[role] || '❓';
}

function hexToRgb(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? [parseInt(m[1],16), parseInt(m[2],16), parseInt(m[3],16)] : null;
}

function getClassColor(charClass, alpha = 1.0) {
  const hex = charClass && typeof WOW_CLASS_COLORS !== 'undefined' ? WOW_CLASS_COLORS[charClass] : null;
  if (!hex) return null;
  if (alpha === 1.0) return hex;
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}

/**
 * Common color-by-class-keyword for placeholders.
 */
function colorForPlaceholder(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  for (const [key, hex] of Object.entries(typeof WOW_CLASS_COLORS !== 'undefined' ? WOW_CLASS_COLORS : {})) {
    const kw = key.replace(/-/g, ' ');
    if (t.includes(kw)) return hex;
  }
  // Extra shorthands
  if (/\bdk\b/.test(t)) return typeof WOW_CLASS_COLORS !== 'undefined' ? WOW_CLASS_COLORS['death-knight'] : null;
  return null;
}
