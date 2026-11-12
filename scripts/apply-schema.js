/**
 * Creates the database from .env if missing, applies the baseline schema dump,
 * then applies every db/migrations/*.sql file in filename order.
 *
 * Safe to re-run: the baseline is skipped once `users` exists.
 */
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..');
const BASE_SQL = path.join(ROOT, 'Smart AI Employment Matching System Database.sql');
const MIGRATIONS = path.join(ROOT, 'db', 'migrations');

const conn = (database) => ({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database
});

async function ensureDatabase() {
  const name = process.env.DB_NAME;
  const admin = new Client(conn('postgres'));
  await admin.connect();

  const { rowCount } = await admin.query(
    'SELECT 1 FROM pg_database WHERE datname = $1',
    [name]
  );

  if (!rowCount) {
    await admin.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
    console.log(`created database "${name}"`);
  } else {
    console.log(`database "${name}" already exists`);
  }

  await admin.end();
}

async function applyBaseline(db) {
  const { rowCount } = await db.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'users'`
  );

  if (rowCount) {
    console.log('baseline schema already present, skipping');
    return;
  }

  const sql = fs.readFileSync(BASE_SQL, 'utf8');
  await db.query(sql);
  console.log('baseline schema applied');
}

async function applyMigrations(db) {
  if (!fs.existsSync(MIGRATIONS)) return;

  const files = fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');
    await db.query(sql);
    console.log(`migration applied: ${file}`);
  }
}

(async () => {
  await ensureDatabase();

  const db = new Client(conn(process.env.DB_NAME));
  await db.connect();

  try {
    await applyBaseline(db);
    await applyMigrations(db);
  } finally {
    await db.end();
  }

  console.log('done');
})().catch(err => {
  console.error('schema apply failed:', err.message);
  process.exit(1);
});
