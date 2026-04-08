const mysql = require('mysql2/promise');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306'),
  user: process.env.DB_USER || 'raidbot',
  password: process.env.DB_PASSWORD || 'changeme',
  database: process.env.DB_NAME || 'raidbot',
  waitForConnections: true,
  connectionLimit: 10,
});

module.exports = pool;
