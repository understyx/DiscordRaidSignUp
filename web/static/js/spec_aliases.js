// ── Spec Normalization ────────────────────────────────────────────────────
// Maps lowercase class name → { lowercase alias → Canonical Spec Name }
const SPEC_ALIASES = {
  'druid': {
    'balance': 'Balance', 'boomkin': 'Balance', 'moonkin': 'Balance', 'owl': 'Balance',
    'boomy': 'Balance', 'boom': 'Balance', 'laser chicken': 'Balance', 'lazer chicken': 'Balance',
    'feral': 'Feral', 'cat': 'Feral', 'kitty': 'Feral', 'feral cat': 'Feral',
    'bear': 'Feral', 'feral bear': 'Feral', 'beardin': 'Feral', 'guardian': 'Feral',
    'restoration': 'Restoration', 'resto': 'Restoration', 'restro': 'Restoration',
    'tree': 'Restoration', 'treant': 'Restoration',
  },
  'death knight': {
    'blood': 'Blood (Tank)',
    'blood tank': 'Blood (Tank)', 'blood dk tank': 'Blood (Tank)',
    'blood dps': 'Blood (DPS)', 'blood dk dps': 'Blood (DPS)',
    'frost tank': 'Frost (Tank)', 'frost dk tank': 'Frost (Tank)',
    'frost dps': 'Frost (DPS)', 'frost dk dps': 'Frost (DPS)',
    'unholy': 'Unholy', 'uh': 'Unholy', 'unholy dk': 'Unholy',
  },
  'hunter': {
    'beast mastery': 'Beast Mastery', 'bm': 'Beast Mastery', 'beastmaster': 'Beast Mastery',
    'beast master': 'Beast Mastery', 'bm hunter': 'Beast Mastery',
    'marksmanship': 'Marksmanship', 'mm': 'Marksmanship', 'marks': 'Marksmanship',
    'marksman': 'Marksmanship', 'mm hunter': 'Marksmanship',
    'survival': 'Survival', 'sv': 'Survival', 'surv': 'Survival',
    'survival hunter': 'Survival', 'surv hunter': 'Survival',
  },
  'mage': {
    'arcane': 'Arcane', 'arcane mage': 'Arcane', 'arc': 'Arcane',
    'fire': 'Fire', 'fire mage': 'Fire',
    'frost': 'Frost', 'frost mage': 'Frost', 'frostfire': 'Frostfire', 'ffb': 'Frostfire',
  },
  'paladin': {
    'holy': 'Holy', 'holy paladin': 'Holy', 'hpala': 'Holy', 'hpal': 'Holy',
    'holy pally': 'Holy',
    'protection': 'Protection', 'prot': 'Protection', 'prot paladin': 'Protection',
    'prot pala': 'Protection', 'tankadin': 'Protection',
    'retribution': 'Retribution', 'ret': 'Retribution', 'retri': 'Retribution',
    'ret paladin': 'Retribution', 'ret pala': 'Retribution', 'ret pally': 'Retribution',
  },
  'priest': {
    'discipline': 'Discipline', 'disc': 'Discipline', 'disc priest': 'Discipline',
    'holy': 'Holy', 'holy priest': 'Holy',
    'shadow': 'Shadow', 'shadow priest': 'Shadow', 'spriest': 'Shadow',
  },
  'rogue': {
    'assassination': 'Assassination', 'mutilate': 'Assassination', 'muti': 'Assassination',
    'mut': 'Assassination', 'assassin': 'Assassination', 'assas': 'Assassination',
    'combat': 'Combat', 'combat rogue': 'Combat',
    'subtlety': 'Subtlety', 'sub': 'Subtlety', 'sub rogue': 'Subtlety',
  },
  'shaman': {
    'elemental': 'Elemental', 'ele': 'Elemental', 'elem': 'Elemental',
    'ele shaman': 'Elemental', 'elem shaman': 'Elemental',
    'enhancement': 'Enhancement', 'enh': 'Enhancement', 'enhance': 'Enhancement',
    'enh shaman': 'Enhancement',
    'restoration': 'Restoration', 'resto': 'Restoration', 'restro': 'Restoration',
    'rsham': 'Restoration', 'resto shaman': 'Restoration',
  },
  'warlock': {
    'affliction': 'Affliction', 'affli': 'Affliction', 'affl': 'Affliction',
    'demonology': 'Demonology', 'demo': 'Demonology', 'demon': 'Demonology',
    'destruction': 'Destruction', 'destro': 'Destruction', 'destruct': 'Destruction',
  },
  'warrior': {
    'arms': 'Arms', 'arms warrior': 'Arms',
    'fury': 'Fury', 'fury warrior': 'Fury',
    'protection': 'Protection', 'prot': 'Protection', 'prot warrior': 'Protection',
    'prot war': 'Protection',
  },
};
