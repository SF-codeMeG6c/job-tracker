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
  console.log('Database initialized');
}

module.exports = { query, initDb };
