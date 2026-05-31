const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const bcrypt = require('bcryptjs');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = 3030;

const PARTY_TYPES = ['Engineer', 'Abatement', 'Adjuster', 'Edison', 'Bld Dept', 'EMS'];

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: __dirname }),
  secret: 'job-tracker-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

// ─── Auth ───────────────────────────────────────────────────────────────────

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  req.session.userId = user.id;
  req.session.displayName = user.display_name;
  res.json({ id: user.id, username: user.username, displayName: user.display_name });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.json(null);
  const user = db.prepare('SELECT id, username, display_name FROM users WHERE id = ?').get(req.session.userId);
  res.json(user);
});

app.post('/api/auth/register', (req, res) => {
  const { username, password, display_name, setup_key } = req.body;
  // Simple setup key to prevent open registration
  if (setup_key !== 'freeman2024') return res.status(403).json({ error: 'Invalid setup key' });
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return res.status(400).json({ error: 'Username already taken' });
  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare('INSERT INTO users (username, password_hash, display_name) VALUES (?, ?, ?)').run(username, hash, display_name || username);
  res.json({ id: result.lastInsertRowid, username, displayName: display_name || username });
});

// ─── Jobs ────────────────────────────────────────────────────────────────────

app.get('/api/jobs', requireAuth, (req, res) => {
  const jobs = db.prepare(`
    SELECT j.*,
      (SELECT COUNT(*) FROM commitments c WHERE c.job_id = j.id AND c.status = 'pending' AND c.due_date < date('now')) as overdue_count,
      (SELECT COUNT(*) FROM commitments c WHERE c.job_id = j.id AND c.status = 'pending') as open_commitments
    FROM jobs j
    ORDER BY j.updated_at DESC
  `).all();
  res.json(jobs);
});

app.post('/api/jobs', requireAuth, (req, res) => {
  const { job_number, customer_name, address, description } = req.body;
  if (!job_number || !customer_name) return res.status(400).json({ error: 'Job number and customer name required' });

  const existing = db.prepare('SELECT id FROM jobs WHERE job_number = ?').get(job_number);
  if (existing) return res.status(400).json({ error: 'Job number already exists' });

  const result = db.prepare(
    'INSERT INTO jobs (job_number, customer_name, address, description, created_by) VALUES (?, ?, ?, ?, ?)'
  ).run(job_number, customer_name, address || '', description || '', req.session.userId);

  // Auto-create party slots for all types
  const insertParty = db.prepare('INSERT INTO parties (job_id, party_type) VALUES (?, ?)');
  for (const type of PARTY_TYPES) insertParty.run(result.lastInsertRowid, type);

  res.json({ id: result.lastInsertRowid, job_number, customer_name });
});

app.get('/api/jobs/:id', requireAuth, (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const parties = db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM commitments c WHERE c.party_id = p.id AND c.status = 'pending') as open_commitments,
      (SELECT COUNT(*) FROM commitments c WHERE c.party_id = p.id AND c.status = 'pending' AND c.due_date < date('now')) as overdue_count,
      (SELECT interaction_date FROM interactions i WHERE i.party_id = p.id ORDER BY i.interaction_date DESC LIMIT 1) as last_contact
    FROM parties p WHERE p.job_id = ?
    ORDER BY p.party_type
  `).all(job.id);

  res.json({ ...job, parties });
});

app.patch('/api/jobs/:id', requireAuth, (req, res) => {
  const { status, customer_name, address, description, job_number } = req.body;
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE jobs SET
    status = COALESCE(?, status),
    customer_name = COALESCE(?, customer_name),
    address = COALESCE(?, address),
    description = COALESCE(?, description),
    job_number = COALESCE(?, job_number),
    updated_at = datetime('now')
    WHERE id = ?`).run(status, customer_name, address, description, job_number, req.params.id);
  res.json({ ok: true });
});

// ─── Parties ─────────────────────────────────────────────────────────────────

app.get('/api/parties/:id', requireAuth, (req, res) => {
  const party = db.prepare('SELECT * FROM parties WHERE id = ?').get(req.params.id);
  if (!party) return res.status(404).json({ error: 'Not found' });

  const interactions = db.prepare(`
    SELECT i.*, u.display_name as created_by_name
    FROM interactions i
    LEFT JOIN users u ON u.id = i.created_by
    WHERE i.party_id = ?
    ORDER BY i.interaction_date DESC
  `).all(party.id);

  const commitments = db.prepare(`
    SELECT c.*, u.display_name as created_by_name
    FROM commitments c
    LEFT JOIN users u ON u.id = c.created_by
    WHERE c.party_id = ?
    ORDER BY c.status ASC, c.due_date ASC
  `).all(party.id);

  res.json({ ...party, interactions, commitments });
});

app.patch('/api/parties/:id', requireAuth, (req, res) => {
  const { company_name, contact_name, contact_email, contact_phone, status, notes } = req.body;
  db.prepare(`UPDATE parties SET
    company_name = COALESCE(?, company_name),
    contact_name = COALESCE(?, contact_name),
    contact_email = COALESCE(?, contact_email),
    contact_phone = COALESCE(?, contact_phone),
    status = COALESCE(?, status),
    notes = COALESCE(?, notes)
    WHERE id = ?`).run(company_name, contact_name, contact_email, contact_phone, status, notes, req.params.id);

  // Update job's updated_at
  const party = db.prepare('SELECT job_id FROM parties WHERE id = ?').get(req.params.id);
  if (party) db.prepare("UPDATE jobs SET updated_at = datetime('now') WHERE id = ?").run(party.job_id);

  res.json({ ok: true });
});

// ─── Interactions ─────────────────────────────────────────────────────────────

app.post('/api/interactions', requireAuth, (req, res) => {
  const { party_id, job_id, interaction_type, summary, interaction_date } = req.body;
  if (!party_id || !job_id || !summary) return res.status(400).json({ error: 'Missing required fields' });
  const result = db.prepare(
    'INSERT INTO interactions (party_id, job_id, interaction_type, summary, interaction_date, created_by) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(party_id, job_id, interaction_type || 'note', summary, interaction_date || new Date().toISOString().split('T')[0], req.session.userId);
  db.prepare("UPDATE jobs SET updated_at = datetime('now') WHERE id = ?").run(job_id);
  res.json({ id: result.lastInsertRowid });
});

app.delete('/api/interactions/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM interactions WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─── Commitments ──────────────────────────────────────────────────────────────

app.post('/api/commitments', requireAuth, (req, res) => {
  const { party_id, job_id, interaction_id, description, due_date } = req.body;
  if (!party_id || !job_id || !description) return res.status(400).json({ error: 'Missing required fields' });
  const result = db.prepare(
    'INSERT INTO commitments (party_id, job_id, interaction_id, description, due_date, created_by) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(party_id, job_id, interaction_id || null, description, due_date || null, req.session.userId);
  db.prepare("UPDATE jobs SET updated_at = datetime('now') WHERE id = ?").run(job_id);
  res.json({ id: result.lastInsertRowid });
});

app.patch('/api/commitments/:id', requireAuth, (req, res) => {
  const { status, due_date, description } = req.body;
  const resolved_at = status === 'met' ? new Date().toISOString() : null;
  db.prepare(`UPDATE commitments SET
    status = COALESCE(?, status),
    due_date = COALESCE(?, due_date),
    description = COALESCE(?, description),
    resolved_at = CASE WHEN ? = 'met' THEN datetime('now') ELSE resolved_at END
    WHERE id = ?`).run(status, due_date, description, status, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/commitments/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM commitments WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─── Dashboard summary ────────────────────────────────────────────────────────

app.get('/api/dashboard', requireAuth, (req, res) => {
  const stats = db.prepare(`SELECT
    COUNT(*) as total_jobs,
    SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open_jobs,
    SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed_jobs
    FROM jobs`).get();

  const overdue = db.prepare(`
    SELECT c.*, p.party_type, j.job_number, j.customer_name, j.id as job_id
    FROM commitments c
    JOIN parties p ON p.id = c.party_id
    JOIN jobs j ON j.id = c.job_id
    WHERE c.status = 'pending' AND c.due_date < date('now')
    ORDER BY c.due_date ASC
    LIMIT 20
  `).all();

  const dueSoon = db.prepare(`
    SELECT c.*, p.party_type, j.job_number, j.customer_name, j.id as job_id
    FROM commitments c
    JOIN parties p ON p.id = c.party_id
    JOIN jobs j ON j.id = c.job_id
    WHERE c.status = 'pending' AND c.due_date BETWEEN date('now') AND date('now', '+7 days')
    ORDER BY c.due_date ASC
    LIMIT 20
  `).all();

  res.json({ stats, overdue, dueSoon });
});

app.listen(PORT, () => {
  console.log(`Job Tracker running at http://localhost:${PORT}`);
});
