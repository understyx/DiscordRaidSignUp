const WOW_DATA = require('../../../shared/wow.json');

const _WOW_CLASSES = Object.entries(WOW_DATA.classes).map(([name, classData]) => ({
  name,
  specs: Object.keys(classData.specs),
}));

const _CLASS_SPEC_ROLES = Object.fromEntries(
  Object.entries(WOW_DATA.classes).flatMap(([className, classData]) =>
    Object.entries(classData.specs).map(([specName, specData]) => [
      `${className}.${specName}`,
      specData.role,
    ])
  )
);

const _REALMS = WOW_DATA.realms;

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
