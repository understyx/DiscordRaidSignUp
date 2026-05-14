const pool = require('../db');

// ── Warmane weekly-reset scheduler ──────────────────────────────────────────
// Icecrown resets every Wednesday at 09:00 CET (Central European Time).
// CET = UTC+1 in winter; CEST = UTC+2 in summer.
// We derive the UTC equivalent at runtime so DST is handled automatically.
function nextWarmaneReset() {
  const now = new Date();

  // Find the next Wednesday 09:00 in the Europe/Berlin timezone (CET/CEST).
  // Strategy: iterate from today until we land on a Wednesday, then build
  // a Date that represents 09:00 CET/CEST on that date.
  for (let daysAhead = 0; daysAhead <= 7; daysAhead++) {
    const candidate = new Date(now);
    candidate.setUTCHours(0, 0, 0, 0);
    candidate.setUTCDate(candidate.getUTCDate() + daysAhead);

    // Use Intl to get the weekday and UTC-offset for Europe/Berlin on that day
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Berlin',
      weekday: 'short',
      hour: 'numeric',
      hour12: false,
    }).formatToParts(candidate);
    const weekday = parts.find(p => p.type === 'weekday')?.value; // 'Wed', 'Thu', …

    if (weekday !== 'Wed') continue;

    // Build a Date for 09:00:00 in Europe/Berlin on this calendar day.
    // Easiest way: format the date portion in Europe/Berlin, then parse as
    // "YYYY-MM-DDT09:00:00" with the Berlin UTC offset we detect below.
    const dateParts = new Intl.DateTimeFormat('en-CA', {   // en-CA gives YYYY-MM-DD
      timeZone: 'Europe/Berlin',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(candidate);                                    // e.g. "2024-03-06"

    // Detect UTC offset for Europe/Berlin on that date at noon
    const noonBerlin = new Date(`${dateParts}T12:00:00Z`);
    const berlinNoonStr = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Berlin',
      hour: 'numeric', minute: 'numeric', hour12: false,
    }).format(noonBerlin);
    const [bh] = berlinNoonStr.split(':').map(Number);
    const offsetHours = bh - 12;   // +1 for CET, +2 for CEST

    // 09:00 Berlin = (09 - offsetHours):00 UTC
    const resetUTC = new Date(`${dateParts}T${String(9 - offsetHours).padStart(2, '0')}:00:00Z`);

    if (resetUTC > now) return resetUTC;
  }

  // Fallback: 7 days from now (should never hit)
  return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
}

async function clearRaidSaves() {
  try {
    const [result] = await pool.query('DELETE FROM char_raid_saves WHERE is_saved = 1');
    console.log(`[weekly-reset] Cleared ${result.affectedRows} raid save(s) at ${new Date().toISOString()}`);
  } catch (err) {
    console.error('[weekly-reset] Failed to clear raid saves:', err.message);
  }
}

function scheduleWeeklyReset() {
  const next = nextWarmaneReset();
  const delayMs = next.getTime() - Date.now();
  console.log(`[weekly-reset] Next Warmane reset scheduled for ${next.toISOString()} (in ${Math.round(delayMs / 60000)} min)`);
  setTimeout(async () => {
    await clearRaidSaves();
    scheduleWeeklyReset(); // schedule the following week
  }, delayMs);
}

module.exports = { scheduleWeeklyReset };
