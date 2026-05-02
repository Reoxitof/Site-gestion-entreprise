require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

/* ═══ SESSION ═══ */
const session = require('express-session');
app.use(session({
  secret: process.env.SESSION_SECRET || 'elitecorp-secret-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }
}));

/* ═══ HEALTHCHECK — répond 200 immédiatement ═══ */
app.get('/health', (req, res) => res.json({ status: 'ok' }));

/* ═══ DB (lazy — initialisée après le démarrage) ═══ */
let pool = null;
let dbReady = false;

function getPool() {
  if (!pool) {
    const { Pool } = require('pg');
    pool = new Pool({
      host:     process.env.PG_HOST     || 'localhost',
      port:     parseInt(process.env.PG_PORT || '5432'),
      database: process.env.PG_DB       || 'mydb',
      user:     process.env.PG_USER     || 'postgres',
      password: process.env.PG_PASSWORD || '',
      ssl: false,
      connectionTimeoutMillis: 8000,
      idleTimeoutMillis: 30000,
      max: 5
    });
  }
  return pool;
}

async function query(sql, params) {
  return getPool().query(sql, params);
}

async function initDB() {
  console.log('[DB] Connexion à', process.env.PG_HOST || 'localhost');
  await query(`CREATE TABLE IF NOT EXISTS ec_users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    nom TEXT NOT NULL,
    prenom TEXT NOT NULL,
    poste TEXT NOT NULL DEFAULT 'Employe',
    role TEXT NOT NULL DEFAULT 'employe',
    actif BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW()
  )`);
  await query(`CREATE TABLE IF NOT EXISTS ec_presences (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES ec_users(id),
    date DATE NOT NULL,
    heure_arrivee TIME,
    heure_depart TIME,
    statut TEXT DEFAULT 'present',
    note TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT NOW()
  )`);
  await query(`CREATE TABLE IF NOT EXISTS ec_planning (
    id SERIAL PRIMARY KEY,
    titre TEXT NOT NULL,
    description TEXT DEFAULT '',
    date_debut TIMESTAMP NOT NULL,
    date_fin TIMESTAMP NOT NULL,
    type TEXT DEFAULT 'evenement',
    couleur TEXT DEFAULT '#c9a84c',
    created_by INTEGER REFERENCES ec_users(id),
    created_at TIMESTAMP DEFAULT NOW()
  )`);
  await query(`CREATE TABLE IF NOT EXISTS ec_annonces (
    id SERIAL PRIMARY KEY,
    titre TEXT NOT NULL,
    contenu TEXT NOT NULL,
    priorite TEXT DEFAULT 'normale',
    auteur_id INTEGER REFERENCES ec_users(id),
    created_at TIMESTAMP DEFAULT NOW()
  )`);

  const count = await query('SELECT COUNT(*) FROM ec_users');
  if (parseInt(count.rows[0].count) === 0) {
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'elitecorp2026', 12);
    await query(
      `INSERT INTO ec_users (username, password_hash, nom, prenom, poste, role)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      ['admin', hash, 'Admin', 'Elite Corp', 'Directeur', 'admin']
    );
    console.log('[DB] Admin cree — login: admin / mdp: elitecorp2026');
  }
  dbReady = true;
  console.log('[DB] Prete');
}

/* ═══ AUTH MIDDLEWARE ═══ */
function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  return res.status(401).json({ error: 'Non connecte' });
}
function requireAdmin(req, res, next) {
  if (req.session?.user?.role === 'admin') return next();
  return res.status(403).json({ error: 'Acces refuse' });
}

/* ═══ AUTH ROUTES ═══ */
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Champs manquants' });
    const bcrypt = require('bcryptjs');
    const r = await query('SELECT * FROM ec_users WHERE username=$1 AND actif=true', [username.toLowerCase()]);
    const user = r.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash)))
      return res.status(401).json({ error: 'Identifiants invalides' });
    req.session.user = { id: user.id, username: user.username, nom: user.nom, prenom: user.prenom, poste: user.poste, role: user.role };
    res.json({ success: true, user: req.session.user });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/logout', (req, res) => { req.session.destroy(() => res.json({ success: true })); });
app.get('/api/me', requireAuth, (req, res) => res.json({ user: req.session.user }));

/* ═══ EMPLOYES ═══ */
app.get('/api/employes', requireAuth, async (req, res) => {
  try {
    const r = await query('SELECT id,username,nom,prenom,poste,role,actif,created_at FROM ec_users ORDER BY nom');
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/employes', requireAdmin, async (req, res) => {
  try {
    const { username, password, nom, prenom, poste, role } = req.body;
    if (!username || !password || !nom || !prenom) return res.status(400).json({ error: 'Champs manquants' });
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash(password, 12);
    const r = await query(
      `INSERT INTO ec_users (username,password_hash,nom,prenom,poste,role) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,username,nom,prenom,poste,role`,
      [username.toLowerCase(), hash, nom, prenom, poste || 'Employe', role || 'employe']
    );
    res.json(r.rows[0]);
  } catch(e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Identifiant deja pris' });
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/employes/:id', requireAdmin, async (req, res) => {
  try {
    const { nom, prenom, poste, role, actif } = req.body;
    await query('UPDATE ec_users SET nom=$1,prenom=$2,poste=$3,role=$4,actif=$5 WHERE id=$6',
      [nom, prenom, poste, role, actif !== undefined ? actif : true, req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/employes/:id', requireAdmin, async (req, res) => {
  try {
    await query('UPDATE ec_users SET actif=false WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ═══ PRESENCES ═══ */
app.get('/api/presences', requireAuth, async (req, res) => {
  try {
    const { date, user_id } = req.query;
    let q = `SELECT p.*,u.nom,u.prenom,u.poste FROM ec_presences p JOIN ec_users u ON p.user_id=u.id WHERE 1=1`;
    const params = [];
    if (date) { params.push(date); q += ` AND p.date=$${params.length}`; }
    if (user_id) { params.push(user_id); q += ` AND p.user_id=$${params.length}`; }
    q += ' ORDER BY p.date DESC,u.nom';
    const r = await query(q, params);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/presences/pointer', requireAuth, async (req, res) => {
  try {
    const userId = req.session.user.id;
    const today = new Date().toISOString().split('T')[0];
    const now = new Date().toTimeString().slice(0, 8);
    const existing = await query('SELECT * FROM ec_presences WHERE user_id=$1 AND date=$2', [userId, today]);
    if (!existing.rows.length) {
      await query('INSERT INTO ec_presences (user_id,date,heure_arrivee,statut) VALUES ($1,$2,$3,$4)', [userId, today, now, 'present']);
      res.json({ action: 'arrivee', heure: now });
    } else if (!existing.rows[0].heure_depart) {
      await query('UPDATE ec_presences SET heure_depart=$1 WHERE user_id=$2 AND date=$3', [now, userId, today]);
      res.json({ action: 'depart', heure: now });
    } else {
      res.json({ action: 'deja_pointe', presence: existing.rows[0] });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ═══ PLANNING ═══ */
app.get('/api/planning', requireAuth, async (req, res) => {
  try {
    const { mois, annee } = req.query;
    let q = `SELECT p.*,u.nom as createur_nom FROM ec_planning p LEFT JOIN ec_users u ON p.created_by=u.id WHERE 1=1`;
    const params = [];
    if (mois && annee) {
      params.push(annee, mois);
      q += ` AND EXTRACT(YEAR FROM p.date_debut)=$1 AND EXTRACT(MONTH FROM p.date_debut)=$2`;
    }
    q += ' ORDER BY p.date_debut';
    const r = await query(q, params);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/planning', requireAdmin, async (req, res) => {
  try {
    const { titre, description, date_debut, date_fin, type, couleur } = req.body;
    if (!titre || !date_debut || !date_fin) return res.status(400).json({ error: 'Champs manquants' });
    const r = await query(
      `INSERT INTO ec_planning (titre,description,date_debut,date_fin,type,couleur,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [titre, description || '', date_debut, date_fin, type || 'evenement', couleur || '#c9a84c', req.session.user.id]
    );
    res.json({ success: true, id: r.rows[0].id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/planning/:id', requireAdmin, async (req, res) => {
  try { await query('DELETE FROM ec_planning WHERE id=$1', [req.params.id]); res.json({ success: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

/* ═══ ANNONCES ═══ */
app.get('/api/annonces', requireAuth, async (req, res) => {
  try {
    const r = await query(`SELECT a.*,u.nom as auteur_nom FROM ec_annonces a LEFT JOIN ec_users u ON a.auteur_id=u.id ORDER BY a.created_at DESC LIMIT 20`);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/annonces', requireAdmin, async (req, res) => {
  try {
    const { titre, contenu, priorite } = req.body;
    if (!titre || !contenu) return res.status(400).json({ error: 'Champs manquants' });
    await query('INSERT INTO ec_annonces (titre,contenu,priorite,auteur_id) VALUES ($1,$2,$3,$4)',
      [titre, contenu, priorite || 'normale', req.session.user.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/annonces/:id', requireAdmin, async (req, res) => {
  try { await query('DELETE FROM ec_annonces WHERE id=$1', [req.params.id]); res.json({ success: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

/* ═══ STATS ═══ */
app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const [a, b, c, d] = await Promise.all([
      query('SELECT COUNT(*) FROM ec_users WHERE actif=true'),
      query("SELECT COUNT(*) FROM ec_presences WHERE date=$1 AND statut='present'", [today]),
      query('SELECT COUNT(*) FROM ec_planning WHERE date_debut >= NOW()'),
      query('SELECT COUNT(*) FROM ec_annonces')
    ]);
    res.json({ employes: +a.rows[0].count, presents_aujourd_hui: +b.rows[0].count, evenements_a_venir: +c.rows[0].count, annonces: +d.rows[0].count });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ═══ PAGES ═══ */
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', req.session?.user ? 'index.html' : 'login.html')));

/* ═══ START ═══ */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[ELITE CORP] Serveur sur port ${PORT}`);
  setTimeout(() => {
    initDB().catch(e => console.error('[DB] Erreur init:', e.message));
  }, 1000);
});

process.on('unhandledRejection', r => console.error('[UNHANDLED]', r));
process.on('uncaughtException', e => console.error('[UNCAUGHT]', e.message));
