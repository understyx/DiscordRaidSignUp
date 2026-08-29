'use strict';

const DEFAULT_WEEKLY_RESET = Object.freeze({
  weekday: 3,
  time: '09:00',
  timezone: 'Europe/Berlin',
});

const WEEKDAY_NAMES = Object.freeze([
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
]);

function isValidTimezone(timezone) {
  if (!timezone || String(timezone).length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: String(timezone) }).format(new Date());
    return true;
  } catch (_) {
    return false;
  }
}

function normalizeWeeklyResetSettings(input = {}) {
  const weekday = Number(input.weekday ?? DEFAULT_WEEKLY_RESET.weekday);
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
    throw new TypeError('Reset weekday must be between Sunday and Saturday.');
  }

  const rawTime = String(input.time ?? DEFAULT_WEEKLY_RESET.time).trim();
  const timeMatch = rawTime.match(/^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/);
  if (!timeMatch) throw new TypeError('Reset time must use the 24-hour HH:MM format.');

  const timezone = String(input.timezone ?? DEFAULT_WEEKLY_RESET.timezone).trim();
  if (!isValidTimezone(timezone)) {
    throw new TypeError('Reset timezone must be a valid IANA timezone, such as Europe/Berlin.');
  }

  return {
    weekday,
    time: `${timeMatch[1]}:${timeMatch[2]}`,
    timezone,
  };
}

function zonedParts(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

// Convert a wall-clock time in an IANA timezone to its corresponding UTC Date.
// Re-evaluating the offset makes this work on either side of daylight-saving changes.
function zonedDateTimeToUtc(parts, timezone) {
  const target = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second || 0
  );
  let utc = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const rendered = zonedParts(new Date(utc), timezone);
    const renderedAsUtc = Date.UTC(
      rendered.year,
      rendered.month - 1,
      rendered.day,
      rendered.hour,
      rendered.minute,
      rendered.second
    );
    const difference = target - renderedAsUtc;
    utc += difference;
    if (difference === 0) break;
  }
  return new Date(utc);
}

function calendarParts(date) {
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function getWeeklyResetWindow(value, inputSettings = {}) {
  const raidDate = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(raidDate.getTime())) throw new TypeError('Raid date is invalid.');

  const settings = normalizeWeeklyResetSettings(inputSettings);
  const local = zonedParts(raidDate, settings.timezone);
  const [resetHour, resetMinute] = settings.time.split(':').map(Number);
  const localCalendar = new Date(Date.UTC(local.year, local.month - 1, local.day));
  const localWeekday = localCalendar.getUTCDay();
  let daysSinceReset = (localWeekday - settings.weekday + 7) % 7;
  if (
    daysSinceReset === 0 &&
    (local.hour < resetHour || (local.hour === resetHour && local.minute < resetMinute))
  ) {
    daysSinceReset = 7;
  }

  const startCalendar = new Date(Date.UTC(local.year, local.month - 1, local.day - daysSinceReset));
  const endCalendar = new Date(startCalendar.getTime());
  endCalendar.setUTCDate(endCalendar.getUTCDate() + 7);

  const start = zonedDateTimeToUtc(
    { ...calendarParts(startCalendar), hour: resetHour, minute: resetMinute, second: 0 },
    settings.timezone
  );
  const end = zonedDateTimeToUtc(
    { ...calendarParts(endCalendar), hour: resetHour, minute: resetMinute, second: 0 },
    settings.timezone
  );

  return { start, end, settings };
}

module.exports = {
  DEFAULT_WEEKLY_RESET,
  WEEKDAY_NAMES,
  getWeeklyResetWindow,
  isValidTimezone,
  normalizeWeeklyResetSettings,
};
