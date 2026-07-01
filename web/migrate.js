const fs = require('fs');
const path = require('path');
const pool = require('./db');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');

// MySQL error codes that mean "this DDL change already exists"
const ALREADY_APPLIED_CODES = new Set([
  1060, // ER_DUP_FIELDNAME    – duplicate column name
  1061, // ER_DUP_KEYNAME      – duplicate key name
  1050, // ER_TABLE_EXISTS_ERR – table already exists
  1068, // ER_MULTIPLE_PRI_KEY – multiple primary key defined
  1091, // ER_CANT_DROP_FIELD_OR_KEY – column/key already dropped
]);

async function runMigrations() {
  const conn = await pool.getConnection();
  try {
    // Serialize concurrent startups (bot + web) with a DB advisory lock
    const [[lockRow]] = await conn.query("SELECT GET_LOCK('schema_migrations', 30) AS ok");
    if (!lockRow || !lockRow.ok) {
      throw new Error('[migrate] Could not acquire advisory lock after 30 s');
    }

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
          try {
            await conn.query(stmt);
          } catch (err) {
            if (ALREADY_APPLIED_CODES.has(err.errno)) {
              // The bot's own migration runner may have already applied this
              // DDL change via inspector checks — treat it as a no-op.
              console.warn(`[migrate] ${file}: skipping already-applied statement (${err.sqlMessage})`);
            } else {
              throw err;
            }
          }
        }

        await conn.query('INSERT INTO schema_migrations (version) VALUES (?)', [file]);
        console.log(`[migrate] Applied ${file}`);
      }
    } finally {
      await conn.query("SELECT RELEASE_LOCK('schema_migrations')");
    }
  } finally {
    conn.release();
  }
}

module.exports = { runMigrations };
