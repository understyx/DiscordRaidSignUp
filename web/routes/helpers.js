/**
 * Shared helper utilities used across multiple route modules.
 *
 * Centralising these prevents copy-paste drift and makes it easy to apply
 * consistent fixes in one place.
 */

'use strict';

const WOW_DATA = require('../../shared/wow.json');

/** Sentinel GS value stored in the database to represent "Best in Slot". */
const BIS_GS = 99999;

/**
 * Parse a gearscore string into a number (or null).
 * Accepts plain numbers, "k" shorthand, and "bis" (case-insensitive).
 * Returns null when the input is empty or unrecognisable.
 *
 * @param {string} raw
 * @returns {number|null}
 */
function parseGS(raw) {
  const s = (raw || '').trim();
  if (s === '') return null;
  if (s.toLowerCase() === 'bis') return BIS_GS;
  const v = parseFloat(s);
  if (isNaN(v)) return null;
  return v;
}

/**
 * Guard: redirect to login if the user is not authenticated.
 * The original URL is saved so the user is returned here after login.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @returns {boolean} true when the user is logged in, false when redirected
 */
function requireLogin(req, res) {
  if (!req.session.user_id) {
    req.session.next_url = req.originalUrl;
    res.redirect('/auth/login');
    return false;
  }
  return true;
}

/**
 * Guard: redirect unauthenticated users to login, and non-admins to /raids.
 * Uses the cached session value (updated by the raids-router middleware for
 * /raids routes, or at login time for other routes).
 *
 * NOTE: This sync variant is used by admin.js, guildSettings.js, and
 * recruitment.js.  The /raids router uses an async variant that re-calls
 * resolveIsAdmin on each request for stronger guarantees.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @returns {boolean} true when admin access is granted, false when redirected
 */
function requireAdmin(req, res) {
  if (!req.session.user_id) {
    req.session.next_url = req.originalUrl;
    res.redirect('/auth/login');
    return false;
  }
  if (req.session.is_admin === false) {
    req.session.flash = '❌ You do not have permission to perform this action.';
    res.redirect('/raids');
    return false;
  }
  return true;
}

/**
 * Pop and return the current flash message, clearing it from the session.
 *
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function popFlash(req) {
  const msg = req.session.flash || null;
  delete req.session.flash;
  return msg;
}

/**
 * Return a minimal user object for template rendering, or null if not logged in.
 *
 * @param {import('express').Request} req
 * @returns {{ id: string, username: string, is_admin: boolean }|null}
 */
function currentUser(req) {
  if (!req.session.user_id) return null;
  return {
    id: req.session.user_id,
    username: req.session.username,
    is_admin: req.session.is_admin !== false,
  };
}

const CLASS_SPEC_ROLES = Object.fromEntries(
  Object.entries(WOW_DATA.classes).map(([className, classData]) => [
    className,
    Object.fromEntries(
      Object.entries(classData.specs).map(([specName, specData]) => [specName, specData.role])
    ),
  ])
);

const CLASS_ALIASES = Object.fromEntries(
  Object.entries(WOW_DATA.classes).flatMap(([className, classData]) =>
    [className, ...classData.aliases].map((alias) => [alias.toLowerCase(), className])
  )
);

/**
 * Determine role from class and spec names.
 *
 * @param {string} charClass
 * @param {string} spec
 * @returns {string} 'tank', 'healer', or 'dps'
 */
function getRoleFromSpec(charClass, spec) {
  if (!charClass || !spec) return 'dps';

  const rawClass = charClass.trim();
  const c =
    CLASS_ALIASES[rawClass.toLowerCase()] ||
    rawClass
      .split(' ')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ');

  let s = spec.trim();
  s = s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

  // Normalize common aliases
  if (s.includes('Prot')) s = 'Protection';
  if (s.includes('Ret')) s = 'Retribution';
  if (s.includes('Disc')) s = 'Discipline';
  if (s.includes('Resto')) s = 'Restoration';
  if (s.includes('Ele')) s = 'Elemental';
  if (s.includes('Enha')) s = 'Enhancement';

  if (c === 'Death Knight') {
    if (s.includes('Blood')) s = 'Blood';
    if (s.includes('Frost')) s = 'Frost';
    if (s.includes('Unholy')) s = 'Unholy';
  }
  if (c === 'Druid') {
    if (s.includes('Bear')) s = 'Feral (Bear)';
    if (s.includes('Cat')) s = 'Feral (Cat)';
  }

  if (CLASS_SPEC_ROLES[c] && CLASS_SPEC_ROLES[c][s]) {
    return CLASS_SPEC_ROLES[c][s];
  }

  const sLow = s.toLowerCase();
  if (
    sLow.includes('tank') ||
    sLow.includes('protection') ||
    sLow.includes('blood') ||
    sLow.includes('bear')
  )
    return 'tank';
  if (
    sLow.includes('heal') ||
    sLow.includes('holy') ||
    sLow.includes('restoration') ||
    sLow.includes('discipline')
  )
    return 'healer';

  return 'dps';
}

module.exports = {
  BIS_GS,
  parseGS,
  requireLogin,
  requireAdmin,
  popFlash,
  currentUser,
  getRoleFromSpec,
};
