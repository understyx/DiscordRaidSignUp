'use strict';

const pool = require('./db');
const { runMigrations } = require('./migrate');

runMigrations(pool)
  .then(async () => {
    await pool.end();
    console.log('[migrate] Database is up to date.');
  })
  .catch(async (err) => {
    console.error('[migrate] Fatal error:', err);
    await pool.end().catch(() => {});
    process.exitCode = 1;
  });
