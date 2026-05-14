const _WOW_CLASSES = [
  { name: 'Death Knight', specs: ['Blood', 'Frost', 'Unholy'] },
  { name: 'Druid',        specs: ['Balance', 'Feral (Cat)', 'Feral (Bear)', 'Restoration'] },
  { name: 'Hunter',       specs: ['Beast Mastery', 'Marksmanship', 'Survival'] },
  { name: 'Mage',         specs: ['Arcane', 'Fire', 'Frost'] },
  { name: 'Paladin',      specs: ['Holy', 'Protection', 'Retribution'] },
  { name: 'Priest',       specs: ['Discipline', 'Holy', 'Shadow'] },
  { name: 'Rogue',        specs: ['Assassination', 'Combat', 'Subtlety'] },
  { name: 'Shaman',       specs: ['Elemental', 'Enhancement', 'Restoration'] },
  { name: 'Warlock',      specs: ['Affliction', 'Demonology', 'Destruction'] },
  { name: 'Warrior',      specs: ['Arms', 'Fury', 'Protection'] },
];

const _CLASS_SPEC_ROLES = {
  'Death Knight.Blood':       'tank',
  'Death Knight.Frost':       'dps',
  'Death Knight.Unholy':      'dps',
  'Druid.Balance':            'dps',
  'Druid.Feral (Cat)':        'dps',
  'Druid.Feral (Bear)':       'tank',
  'Druid.Restoration':        'healer',
  'Hunter.Beast Mastery':     'dps',
  'Hunter.Marksmanship':      'dps',
  'Hunter.Survival':          'dps',
  'Mage.Arcane':              'dps',
  'Mage.Fire':                'dps',
  'Mage.Frost':               'dps',
  'Paladin.Holy':             'healer',
  'Paladin.Protection':       'tank',
  'Paladin.Retribution':      'dps',
  'Priest.Discipline':        'healer',
  'Priest.Holy':              'healer',
  'Priest.Shadow':            'dps',
  'Rogue.Assassination':      'dps',
  'Rogue.Combat':             'dps',
  'Rogue.Subtlety':           'dps',
  'Shaman.Elemental':         'dps',
  'Shaman.Enhancement':       'dps',
  'Shaman.Restoration':       'healer',
  'Warlock.Affliction':       'dps',
  'Warlock.Demonology':       'dps',
  'Warlock.Destruction':      'dps',
  'Warrior.Arms':             'dps',
  'Warrior.Fury':             'dps',
  'Warrior.Protection':       'tank',
};

const _REALMS = ['Icecrown', 'Lordaeron', 'Frostmourne'];

const _FAKE_USER_ID_MIN = BigInt('10000000000000000');
const _FAKE_USER_ID_MAX = BigInt('999999999999999999');

function _randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function _randomCharName(length) {
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  let name = upper[_randInt(0, upper.length - 1)];
  for (let i = 1; i < length; i++) {
    name += lower[_randInt(0, lower.length - 1)];
  }
  return name;
}

function _randomFakeId(usedIds) {
  const range = _FAKE_USER_ID_MAX - _FAKE_USER_ID_MIN + BigInt(1);
  while (true) {
    const rand = _FAKE_USER_ID_MIN + BigInt(Math.floor(Math.random() * Number(range)));
    const key = rand.toString();
    if (!usedIds.has(key)) {
      usedIds.add(key);
      return key;
    }
  }
}

module.exports = {
  _WOW_CLASSES,
  _CLASS_SPEC_ROLES,
  _REALMS,
  _FAKE_USER_ID_MIN,
  _FAKE_USER_ID_MAX,
  _randInt,
  _randomCharName,
  _randomFakeId,
};
