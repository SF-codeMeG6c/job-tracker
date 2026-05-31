const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const { query, initDb } = require('./db');

const app = express();
const PORT = process.env.PORT || 3030;

const PARTY_TYPES = ['Engineer', 'Abatement', 'Adjuster', 'Edison', 'Bld Dept', 'EMS'];

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'job-tracker-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,
    secure: process.env.NODE_ENV === 'production'
  }
}));

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const result = await query('SELECT * FROM users WHERE username = $1', [username]);
    const user = result.rows[0];
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    req.session.userId = user.id;
    req.session.displayName = user.display_name;
    res.json({ id: user.id, username: user.username, displayName: user.display_name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/auth/me', async (req, res) => {
  if (!req.session.userId) return res.json(null);
  try {
    const result = await query('SELECT id, username, display_name FROM users WHERE id = $1', [req.session.userId]);
    res.json(result.rows[0] || null);
  } catch (e) { res.json(null); }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password, display_name, setup_key } = req.body;
    if (setup_key !== (process.env.SETUP_KEY || 'freeman2024')) return res.status(403).json({ error: 'Invalid setup key' });
    const existing = await query('SELECT id FROM users WHERE username = $1', [username]);
    if (existing.rows.length) return res.status(400).json({ error: 'Username already taken' });
    const hash = bcrypt.hashSync(password, 10);
    const result = await query(
      'INSERT INTO users (username, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id',
      [username, hash, display_name || username]
    );
    res.json({ id: result.rows[0].id, username, displayName: display_name || username });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Jobs ─────────────────────────────────────────────────────────────────────

app.get('/api/jobs', requireAuth, async (req, res) => {
  try {
    const result = await query(`
      SELECT j.*,
        COUNT(CASE WHEN c.status = 'pending' AND c.due_date < CURRENT_DATE THEN 1 END) as overdue_count,
        COUNT(CASE WHEN c.status = 'pending' THEN 1 END) as open_commitments
      FROM jobs j
      LEFT JOIN commitments c ON c.job_id = j.id
      GROUP BY j.id
      ORDER BY j.updated_at DESC
    `);
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/jobs', requireAuth, async (req, res) => {
  try {
    const { job_number, customer_name, address, description } = req.body;
    if (!job_number || !customer_name) return res.status(400).json({ error: 'Job number and customer name required' });
    const existing = await query('SELECT id FROM jobs WHERE job_number = $1', [job_number]);
    if (existing.rows.length) return res.status(400).json({ error: 'Job number already exists' });
    const result = await query(
      'INSERT INTO jobs (job_number, customer_name, address, description, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [job_number, customer_name, address || '', description || '', req.session.userId]
    );
    const jobId = result.rows[0].id;
    for (const type of PARTY_TYPES) {
      await query('INSERT INTO parties (job_id, party_type) VALUES ($1, $2)', [jobId, type]);
    }
    res.json({ id: jobId, job_number, customer_name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/jobs/:id', requireAuth, async (req, res) => {
  try {
    const jobResult = await query('SELECT * FROM jobs WHERE id = $1', [req.params.id]);
    if (!jobResult.rows.length) return res.status(404).json({ error: 'Job not found' });
    const job = jobResult.rows[0];
    const parties = await query(`
      SELECT p.*,
        COUNT(CASE WHEN c.status = 'pending' THEN 1 END) as open_commitments,
        COUNT(CASE WHEN c.status = 'pending' AND c.due_date < CURRENT_DATE THEN 1 END) as overdue_count,
        MAX(i.interaction_date) as last_contact
      FROM parties p
      LEFT JOIN commitments c ON c.party_id = p.id
      LEFT JOIN interactions i ON i.party_id = p.id
      WHERE p.job_id = $1
      GROUP BY p.id
      ORDER BY p.party_type
    `, [job.id]);
    res.json({ ...job, parties: parties.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/jobs/:id', requireAuth, async (req, res) => {
  try {
    const { status, customer_name, address, description, job_number } = req.body;
    await query(`
      UPDATE jobs SET
        status = COALESCE($1, status),
        customer_name = COALESCE($2, customer_name),
        address = COALESCE($3, address),
        description = COALESCE($4, description),
        job_number = COALESCE($5, job_number),
        updated_at = NOW()
      WHERE id = $6
    `, [status, customer_name, address, description, job_number, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Parties ──────────────────────────────────────────────────────────────────

app.get('/api/parties/:id', requireAuth, async (req, res) => {
  try {
    const partyResult = await query('SELECT * FROM parties WHERE id = $1', [req.params.id]);
    if (!partyResult.rows.length) return res.status(404).json({ error: 'Not found' });
    const party = partyResult.rows[0];
    const interactions = await query(`
      SELECT i.*, u.display_name as created_by_name
      FROM interactions i
      LEFT JOIN users u ON u.id = i.created_by
      WHERE i.party_id = $1
      ORDER BY i.interaction_date DESC
    `, [party.id]);
    const commitments = await query(`
      SELECT c.*, u.display_name as created_by_name
      FROM commitments c
      LEFT JOIN users u ON u.id = c.created_by
      WHERE c.party_id = $1
      ORDER BY c.status ASC, c.due_date ASC
    `, [party.id]);
    res.json({ ...party, interactions: interactions.rows, commitments: commitments.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/parties/:id', requireAuth, async (req, res) => {
  try {
    const { company_name, contact_name, contact_email, contact_phone, status, notes } = req.body;
    await query(`
      UPDATE parties SET
        company_name = COALESCE($1, company_name),
        contact_name = COALESCE($2, contact_name),
        contact_email = COALESCE($3, contact_email),
        contact_phone = COALESCE($4, contact_phone),
        status = COALESCE($5, status),
        notes = COALESCE($6, notes)
      WHERE id = $7
    `, [company_name, contact_name, contact_email, contact_phone, status, notes, req.params.id]);
    const party = await query('SELECT job_id FROM parties WHERE id = $1', [req.params.id]);
    if (party.rows.length) await query('UPDATE jobs SET updated_at = NOW() WHERE id = $1', [party.rows[0].job_id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Interactions ─────────────────────────────────────────────────────────────

app.post('/api/interactions', requireAuth, async (req, res) => {
  try {
    const { party_id, job_id, interaction_type, summary, interaction_date } = req.body;
    if (!party_id || !job_id || !summary) return res.status(400).json({ error: 'Missing required fields' });
    const result = await query(
      'INSERT INTO interactions (party_id, job_id, interaction_type, summary, interaction_date, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [party_id, job_id, interaction_type || 'note', summary, interaction_date || new Date().toISOString().split('T')[0], req.session.userId]
    );
    await query('UPDATE jobs SET updated_at = NOW() WHERE id = $1', [job_id]);
    res.json({ id: result.rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/interactions/:id', requireAuth, async (req, res) => {
  try {
    await query('DELETE FROM interactions WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Commitments ──────────────────────────────────────────────────────────────

app.post('/api/commitments', requireAuth, async (req, res) => {
  try {
    const { party_id, job_id, interaction_id, description, due_date } = req.body;
    if (!party_id || !job_id || !description) return res.status(400).json({ error: 'Missing required fields' });
    const result = await query(
      'INSERT INTO commitments (party_id, job_id, interaction_id, description, due_date, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [party_id, job_id, interaction_id || null, description, due_date || null, req.session.userId]
    );
    await query('UPDATE jobs SET updated_at = NOW() WHERE id = $1', [job_id]);
    res.json({ id: result.rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/commitments/:id', requireAuth, async (req, res) => {
  try {
    const { status, due_date, description } = req.body;
    await query(`
      UPDATE commitments SET
        status = COALESCE($1, status),
        due_date = COALESCE($2, due_date),
        description = COALESCE($3, description),
        resolved_at = CASE WHEN $1 = 'met' THEN NOW() ELSE resolved_at END
      WHERE id = $4
    `, [status, due_date, description, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/commitments/:id', requireAuth, async (req, res) => {
  try {
    await query('DELETE FROM commitments WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Dashboard ────────────────────────────────────────────────────────────────

app.get('/api/dashboard', requireAuth, async (req, res) => {
  try {
    const stats = await query(`
      SELECT
        COUNT(*) as total_jobs,
        COUNT(CASE WHEN status = 'open' THEN 1 END) as open_jobs,
        COUNT(CASE WHEN status = 'closed' THEN 1 END) as closed_jobs
      FROM jobs
    `);
    const overdue = await query(`
      SELECT c.*, p.party_type, j.job_number, j.customer_name, j.id as job_id
      FROM commitments c
      JOIN parties p ON p.id = c.party_id
      JOIN jobs j ON j.id = c.job_id
      WHERE c.status = 'pending' AND c.due_date < CURRENT_DATE::text
      ORDER BY c.due_date ASC
      LIMIT 20
    `);
    const dueSoon = await query(`
      SELECT c.*, p.party_type, j.job_number, j.customer_name, j.id as job_id
      FROM commitments c
      JOIN parties p ON p.id = c.party_id
      JOIN jobs j ON j.id = c.job_id
      WHERE c.status = 'pending'
        AND c.due_date >= CURRENT_DATE::text
        AND c.due_date <= (CURRENT_DATE + INTERVAL '7 days')::date::text
      ORDER BY c.due_date ASC
      LIMIT 20
    `);
    res.json({ stats: stats.rows[0], overdue: overdue.rows, dueSoon: dueSoon.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Start ────────────────────────────────────────────────────────────────────

initDb().then(() => {
  app.listen(PORT, () => console.log(`Job Tracker running on port ${PORT}`));
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
