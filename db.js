const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function query(text, params) {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS jobs (
      id SERIAL PRIMARY KEY,
      job_number TEXT UNIQUE NOT NULL,
      customer_name TEXT NOT NULL,
      address TEXT,
      description TEXT,
      status TEXT DEFAULT 'open',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      created_by INTEGER REFERENCES users(id)
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS parties (
      id SERIAL PRIMARY KEY,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      party_type TEXT NOT NULL,
      company_name TEXT,
      contact_name TEXT,
      contact_email TEXT,
      contact_phone TEXT,
      status TEXT DEFAULT 'pending',
      notes TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS interactions (
      id SERIAL PRIMARY KEY,
      party_id INTEGER NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      interaction_type TEXT NOT NULL,
      summary TEXT NOT NULL,
      interaction_date TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS commitments (
      id SERIAL PRIMARY KEY,
      party_id INTEGER NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      interaction_id INTEGER REFERENCES interactions(id) ON DELETE SET NULL,
      description TEXT NOT NULL,
      due_date TEXT,
      status TEXT DEFAULT 'pending',
      resolved_at TIMESTAMP,
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // ── Mileage Tracker Tables ──────────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS mileage_settings (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      rate NUMERIC DEFAULT 0.70,
      home_address TEXT DEFAULT '',
      company TEXT DEFAULT '',
      dept TEXT DEFAULT '',
      maps_key TEXT DEFAULT ''
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS mileage_trips (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      from_addr TEXT NOT NULL,
      to_addr TEXT NOT NULL,
      job_name TEXT DEFAULT '',
      purpose TEXT DEFAULT '',
      description TEXT DEFAULT '',
      lead_number TEXT DEFAULT '',
      miles NUMERIC NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await query(`ALTER TABLE mileage_trips ADD COLUMN IF NOT EXISTS job_name TEXT DEFAULT ''`);
  await query(`ALTER TABLE mileage_trips ADD COLUMN IF NOT EXISTS description TEXT DEFAULT ''`);
  await query(`
    CREATE TABLE IF NOT EXISTS mileage_expenses (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      description TEXT NOT NULL,
      amount NUMERIC NOT NULL,
      receipt_data TEXT,
      receipt_name TEXT,
      receipt_type TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS mileage_sites (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      address TEXT NOT NULL,
      purpose TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await query(`ALTER TABLE mileage_sites ADD COLUMN IF NOT EXISTS purpose TEXT DEFAULT ''`);
  await query(`ALTER TABLE mileage_sites ADD COLUMN IF NOT EXISTS job_name TEXT DEFAULT ''`);
  await query(`
    CREATE TABLE IF NOT EXISTS mileage_purposes (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      purpose_text TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS mileage_job_names (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      job_name_text TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('Database initialized');
}

module.exports = { query, initDb, pool };
