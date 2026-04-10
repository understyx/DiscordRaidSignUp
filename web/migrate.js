const fs = require('fs');
const path = require('path');
const pool = require('./db');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');

async function runMigrations() {
  const conn = await pool.getConnection();
  try {
    // Ensure tracking table exists
    await conn.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(255) NOT NULL,
        applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (version)
      )
    `);

    // Collect applied versions
    const [rows] = await conn.query('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map(r => r.version));

    // Read and sort migration files
    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (applied.has(file)) continue;

      console.log(`[migrate] Applying ${file}…`);
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');

      // Split on semicolons, skipping empty/comment-only statements
      const statements = sql
        .split(';')
        .map(s => s.replace(/--[^\n]*/g, '').trim())
        .filter(s => s.length > 0);

      for (const stmt of statements) {
        await conn.query(stmt);
      }

      await conn.query('INSERT INTO schema_migrations (version) VALUES (?)', [file]);
      console.log(`[migrate] Applied ${file}`);
    }
  } finally {
    conn.release();
  }
}

module.exports = { runMigrations };
