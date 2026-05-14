'use strict';

let devFullAdminEnabled = String(process.env.DEV_FULL_ADMIN || '').toLowerCase() === 'true';
// Initial value is sourced from ENV at startup; routes can override it live via setDevFullAdminEnabled().

function isDevFullAdminEnabled() {
  return devFullAdminEnabled;
}

function setDevFullAdminEnabled(enabled) {
  devFullAdminEnabled = !!enabled;
}

module.exports = {
  isDevFullAdminEnabled,
  setDevFullAdminEnabled,
};
