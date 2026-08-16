const mysql = require('mysql2/promise');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306'),
  user: process.env.DB_USER || 'raidbot',
  password: process.env.DB_PASSWORD || 'changeme',
  database: process.env.DB_NAME || 'raidbot',
  // Raid DATETIME values are stored as UTC by the bot. Decode and encode them
  // as UTC regardless of the web server's local timezone.
  timezone: 'Z',
  waitForConnections: true,
  connectionLimit: 10,
  supportBigNumbers: true,
  bigNumberStrings: true,
});

module.exports = pool;
