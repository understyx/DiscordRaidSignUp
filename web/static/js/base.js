'use strict';

// Shared WoW class colour map — keyed by CSS class suffix (e.g. 'paladin', 'death-knight')
const WOW_CLASS_COLORS = {
  'paladin':      '#F48CBA',
  'warrior':      '#C69B3A',
  'death-knight': '#e05060',
  'druid':        '#FF7C0A',
  'priest':       '#c8ccd4',
  'shaman':       '#2e9fe0',
  'hunter':       '#AAD372',
  'mage':         '#3FC7EB',
  'rogue':        '#e8d850',
  'warlock':      '#9d9eec',
};

function roundedSigned(value) {
  return Math.sign(value) * Math.max(1, Math.round(Math.abs(value)));
}

function formatRaidRelativeTime(targetValue, nowValue = Date.now(), locale) {
  const target = new Date(targetValue);
  const now = new Date(nowValue);
  if (Number.isNaN(target.getTime()) || Number.isNaN(now.getTime())) return 'Time unavailable';

  const seconds = (target.getTime() - now.getTime()) / 1000;
  const absoluteSeconds = Math.abs(seconds);
  let value;
  let unit;

  if (absoluteSeconds < 60) {
    value = roundedSigned(seconds);
    unit = 'second';
  } else if (absoluteSeconds < 60 * 60) {
    value = roundedSigned(seconds / 60);
    unit = 'minute';
  } else if (absoluteSeconds < 24 * 60 * 60) {
    value = roundedSigned(seconds / (60 * 60));
    unit = 'hour';
  } else if (absoluteSeconds < 7 * 24 * 60 * 60) {
    value = roundedSigned(seconds / (24 * 60 * 60));
    unit = 'day';
  } else if (absoluteSeconds < 30 * 24 * 60 * 60) {
    value = roundedSigned(seconds / (7 * 24 * 60 * 60));
    unit = 'week';
  } else if (absoluteSeconds < 365 * 24 * 60 * 60) {
    value = roundedSigned(seconds / (30 * 24 * 60 * 60));
    unit = 'month';
  } else {
    value = roundedSigned(seconds / (365 * 24 * 60 * 60));
    unit = 'year';
  }

  return new Intl.RelativeTimeFormat(locale, { numeric: 'always' }).format(value, unit);
}

function refreshRaidRelativeTimes(root = document, nowValue = Date.now()) {
  root.querySelectorAll('[data-raid-relative-time]').forEach((element) => {
    const targetValue = element.getAttribute('datetime');
    element.textContent = formatRaidRelativeTime(targetValue, nowValue);

    const target = new Date(targetValue);
    if (!Number.isNaN(target.getTime())) {
      element.title = target.toLocaleString(undefined, {
        dateStyle: 'full',
        timeStyle: 'short',
      });
    }
  });
}

if (typeof document !== 'undefined') {
  refreshRaidRelativeTimes();
  setInterval(refreshRaidRelativeTimes, 30_000);
}

if (typeof module !== 'undefined') {
  module.exports = { formatRaidRelativeTime, refreshRaidRelativeTimes };
}
