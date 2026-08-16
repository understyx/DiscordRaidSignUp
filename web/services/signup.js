'use strict';

function integerIds(value) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(values.map(Number).filter(Number.isInteger))];
}

function parseSignupSelection(body = {}, maxNoteLength = 500) {
  const characterIds = integerIds(body.character_ids || body.character_id);
  if (characterIds.length === 0) {
    return { error: 'Please select at least one character.' };
  }

  const priorityIds = integerIds(body.priority_ids);
  if (priorityIds.some((id) => !characterIds.includes(id))) {
    return { error: 'Priority characters must be part of the signup.' };
  }

  const noteIds = Array.isArray(body.note_ids)
    ? body.note_ids
    : body.note_ids
      ? [body.note_ids]
      : [];
  const noteValues = Array.isArray(body.note_values)
    ? body.note_values
    : body.note_values
      ? [body.note_values]
      : [];
  const notes = new Map();
  for (let index = 0; index < Math.min(noteIds.length, noteValues.length); index += 1) {
    const characterId = Number(noteIds[index]);
    if (!Number.isInteger(characterId) || !characterIds.includes(characterId)) continue;
    const note = String(noteValues[index] || '').trim();
    if (note.length > maxNoteLength) {
      return { error: `Notes must be ${maxNoteLength} characters or fewer.` };
    }
    if (note) notes.set(characterId, note);
  }

  return {
    characterIds,
    isTentative: body.signup_mode === 'tentative',
    notes,
    priorityIds: new Set(priorityIds),
  };
}

module.exports = { integerIds, parseSignupSelection };
