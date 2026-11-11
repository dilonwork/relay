require('dotenv').config();
process.env.TZ = process.env.TZ || 'America/Phoenix';
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_ACCOUNT,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'relay',
  port: 5432,
});

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');

// Run the SQL migrations in order. Idempotent: every migration uses
// CREATE TABLE IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS,
// so startup is safe to repeat.
const initDb = async () => {
  try {
    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      await pool.query(sql);
    }
    console.log('Relay database tables initialized.');
  } catch (err) {
    console.error('Error initializing Relay database tables:', err.message);
  }
};

initDb();

// Run fn inside one transaction on a single client, so a status change and
// its audit row commit (or roll back) together (design doc ch. 7).
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
  withTransaction,
  initDb,
};
