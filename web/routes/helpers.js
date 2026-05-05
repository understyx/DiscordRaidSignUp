/**
 * Shared helper utilities used across multiple route modules.
 *
 * Centralising these prevents copy-paste drift and makes it easy to apply
 * consistent fixes in one place.
 */

'use strict';

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

module.exports = { BIS_GS, parseGS, requireLogin, requireAdmin, popFlash, currentUser };
