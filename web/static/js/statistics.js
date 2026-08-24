'use strict';

(() => {
  const sortSelect = document.getElementById('statisticsSort');
  if (!sortSelect) return;

  const collator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: 'base',
  });

  function compareNames(a, b) {
    const nameComparison = collator.compare(a.dataset.displayName, b.dataset.displayName);
    if (nameComparison !== 0) return nameComparison;
    return collator.compare(a.dataset.userId, b.dataset.userId);
  }

  function compareDates(a, b, dataKey, direction) {
    const aDate = Date.parse(a.dataset[dataKey]);
    const bDate = Date.parse(b.dataset[dataKey]);
    const aMissing = Number.isNaN(aDate);
    const bMissing = Number.isNaN(bDate);
    if (aMissing && bMissing) return compareNames(a, b);
    if (aMissing) return 1;
    if (bMissing) return -1;
    return direction * (aDate - bDate) || compareNames(a, b);
  }

  function compareMembers(a, b, sorting) {
    const signupDifference = Number(a.dataset.signupCount) - Number(b.dataset.signupCount);
    const placedDifference = Number(a.dataset.placedCount) - Number(b.dataset.placedCount);

    switch (sorting) {
      case 'placed_asc':
        return placedDifference || signupDifference || compareNames(a, b);
      case 'signups_desc':
        return -signupDifference || -placedDifference || compareNames(a, b);
      case 'signups_asc':
        return signupDifference || placedDifference || compareNames(a, b);
      case 'joined_desc':
        return compareDates(a, b, 'joinedAt', -1);
      case 'joined_asc':
        return compareDates(a, b, 'joinedAt', 1);
      case 'last_signup_desc':
        return compareDates(a, b, 'lastSignupAt', -1);
      case 'last_signup_asc':
        return compareDates(a, b, 'lastSignupAt', 1);
      case 'name_asc':
        return compareNames(a, b);
      case 'name_desc':
        return -compareNames(a, b);
      case 'placed_desc':
      default:
        return -placedDifference || -signupDifference || compareNames(a, b);
    }
  }

  function sortMembers() {
    const sorting = sortSelect.value;
    for (const body of document.querySelectorAll('[data-statistics-members]')) {
      const rows = [...body.querySelectorAll('tr')];
      rows.sort((a, b) => compareMembers(a, b, sorting));
      for (const row of rows) body.appendChild(row);
    }
  }

  sortSelect.addEventListener('change', sortMembers);
  sortMembers();
})();
