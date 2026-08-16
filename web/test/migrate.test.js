'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { listMigrationFiles, runMigrations, splitSqlStatements } = require('../migrate');

test('migration history is complete and ordered', () => {
  const files = listMigrationFiles();
  assert.equal(files[0], '001_initial_schema.sql');
  assert.equal(files[1], '002_pre_sql_migration_columns.sql');
  assert.equal(files.at(-1), '036_discord_users.sql');
});

test('SQL splitter removes comments and empty statements', () => {
  assert.deepEqual(splitSqlStatements('-- heading\nCREATE TABLE example (id INT);\n; -- tail'), [
    'CREATE TABLE example (id INT)',
  ]);
});

test('runner applies pending migrations and records them', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'raidbot-migrations-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, '001_test.sql'), 'CREATE TABLE example (id INT);');

  const queries = [];
  const connection = {
    async query(sql, params) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      queries.push([normalized, params]);
      if (normalized.startsWith('SELECT GET_LOCK')) return [[{ ok: 1 }]];
      if (normalized === 'SELECT version FROM schema_migrations') return [[]];
      return [[], []];
    },
    release() {},
  };
  const pool = {
    async getConnection() {
      return connection;
    },
  };
  const logger = { log() {}, warn() {} };

  await runMigrations(pool, { logger, migrationsDir: directory });

  assert.ok(queries.some(([sql]) => sql === 'CREATE TABLE example (id INT)'));
  assert.ok(
    queries.some(
      ([sql, params]) =>
        sql.startsWith('INSERT INTO schema_migrations') && params[0] === '001_test.sql'
    )
  );
  assert.ok(queries.some(([sql]) => sql.startsWith('SELECT RELEASE_LOCK')));
});

test('application startup does not mutate the schema implicitly', () => {
  const botDatabase = fs.readFileSync(path.join(__dirname, '..', '..', 'bot', 'db.py'), 'utf8');
  const webStartup = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.doesNotMatch(botDatabase, /create_all|ALTER TABLE|CREATE TABLE/);
  assert.doesNotMatch(webStartup, /runMigrations/);
});
