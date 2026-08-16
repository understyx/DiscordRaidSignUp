'use strict';

function normalizeRaidEditInput(body) {
  const name = String(body.name || '').trim();
  const raidInstance = String(body.raid_instance || '').trim();
  const description = String(body.description || '').trim();
  const dateInput = String(body.date || '').trim();
  const maxSizeInput = String(body.max_size || '').trim();
  const maxSize = Number.parseInt(maxSizeInput, 10);

  if (!name) return { error: 'Raid name is required.' };
  if (name.length > 100) return { error: 'Raid name must be 100 characters or fewer.' };
  if (!raidInstance) return { error: 'Raid instance is required.' };
  if (raidInstance.length > 100) return { error: 'Raid instance must be 100 characters or fewer.' };
  if (description.length > 500) return { error: 'Description must be 500 characters or fewer.' };
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(dateInput)) {
    return { error: 'Enter a valid UTC date and time.' };
  }

  const [datePart, timePart] = dateInput.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute] = timePart.split(':').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day ||
    parsed.getUTCHours() !== hour ||
    parsed.getUTCMinutes() !== minute
  ) {
    return { error: 'Enter a valid UTC date and time.' };
  }
  if (!/^\d+$/.test(maxSizeInput) || maxSize < 1 || maxSize > 100) {
    return { error: 'Raid size must be between 1 and 100.' };
  }

  return {
    values: {
      name,
      raidInstance,
      description,
      dateSql: `${datePart} ${timePart}:00`,
      maxSize,
    },
  };
}

function formatRaidDateInput(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

module.exports = { normalizeRaidEditInput, formatRaidDateInput };
