const fetch = require('node-fetch');
const cheerio = require('cheerio');

const WOW_TWO_WORD_CLASSES = new Set(['Death Knight']);

/**
 * Fetch character class, spec, and gearscore from Warmane armory.
 * Returns { char_class, spec, gearscore } or {} on failure.
 */
async function fetchArmory(charName, realm) {
  try {
    const name = charName.charAt(0).toUpperCase() + charName.slice(1).toLowerCase();
    const realmCap = realm.charAt(0).toUpperCase() + realm.slice(1).toLowerCase();
    const url = `http://armory.warmane.com/character/${name}/${realmCap}/summary`;

    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0' },
    });
    if (!res.ok) return {};

    const html = await res.text();
    const $ = cheerio.load(html);

    const errorMsg = 'The character you are looking for does not exist or does not meet the minimum required level.';
    if ($('body').text().includes(errorMsg)) return {};

    // Extract class from level-race-class text
    const levelRaceClassText = $('.level-race-class').text();
    const matches = levelRaceClassText.match(/(\b[A-Za-z0-9]*[\s,])/g) || [];
    let joined = matches.join('');
    const commaIdx = joined.indexOf(',');
    if (commaIdx !== -1) joined = joined.slice(0, commaIdx);
    const parts = joined.trim().split(/\s+/).filter(Boolean);

    let char_class = parts.length > 0 ? parts[parts.length - 1] : null;
    if (parts.length >= 2) {
      const twoWord = `${parts[parts.length - 2]} ${parts[parts.length - 1]}`;
      if (WOW_TWO_WORD_CLASSES.has(twoWord)) char_class = twoWord;
    }

    // Extract specializations
    const specResults = [];
    $('.specialization .text').each((_, div) => {
      const specName = $(div).contents().first().text().trim();
      const value = $(div).find('.value').text().trim() || '0 / 0 / 0';
      specResults.push(`${specName} (${value})`);
    });

    const spec = cleanData(specResults);

    return { char_class, spec, gearscore: 0.0 };
  } catch (_err) {
    return {};
  }
}

/**
 * Clean spec/profession data lines by removing brackets, quotes,
 * and parenthetical content.
 */
function cleanData(lines) {
  return lines
    .map(line =>
      line
        .replace(/\[/g, '')
        .replace(/\]/g, '')
        .replace(/'/g, '')
        .replace(/\s*\([^)]*\)/g, '')
    )
    .join(', ');
}

module.exports = { fetchArmory, WOW_TWO_WORD_CLASSES };
