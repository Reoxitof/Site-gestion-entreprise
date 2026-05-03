require('dotenv').config();
const express = require('express');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

/* ═══ SANITISATION ═══ */
function sanitizeStr(val, maxLen = 500) {
  if (val === null || val === undefined) return '';
  return String(val).trim().slice(0, maxLen);
}
function sanitizeNum(val, min = 0, max = 9999999) {
  const n = parseFloat(val);
  if (isNaN(n)) return null;
  return Math.min(Math.max(n, min), max);
}

/* ═══ CACHE MÉMOIRE 30s ═══ */
const _cache = {};
function getCache(key) {
  const entry = _cache[key];
  if (!entry) return null;
  if (Date.now() - entry.ts > 30000) { delete _cache[key]; return null; }
  return entry.data;
}
function setCache(key, data) { _cache[key] = { data, ts: Date.now() }; }
function clearCache(key) { delete _cache[key]; }

/* ═══ HEALTH CHECK (avant tout middleware) ═══ */
app.get('/health', (req, res) => res.status(200).json({ status: 'ok', time: new Date().toISOString() }));

/* ═══ RATE LIMITING ═══ */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // max 10 tentatives par IP
  message: { error: 'Trop de tentatives. Réessaie dans 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 200, // max 200 requêtes/min par IP
  message: { error: 'Trop de requêtes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

/* ═══ MIDDLEWARE ═══ */
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/api/', apiLimiter);
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'elitecorp2026',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 604800000,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  }
}));

/* ═══ DB ═══ */
let pool = null;
let dbReady = false;

function getPool() {
  if (!pool) {
    pool = new Pool({
      host:     process.env.PG_HOST      || process.env.POSTGRES_HOST     || 'postgres-ghzw.internal',
      port:     parseInt(process.env.PG_PORT || process.env.POSTGRES_PORT || '5432'),
      database: process.env.PG_DB        || process.env.POSTGRES_DB       || 'mydb',
      user:     process.env.PG_USER      || process.env.POSTGRES_USER     || 'postgres',
      password: String(process.env.PG_PASSWORD || process.env.POSTGRES_PASSWORD || ''),
      ssl: false,
      connectionTimeoutMillis: 10000,
      max: 15,
      idleTimeoutMillis: 30000
    });
    console.log('[DB] Pool cree, host:', process.env.PG_HOST || process.env.POSTGRES_HOST || 'postgres-ghzw.internal');
  }
  return pool;
}

async function initDB() {
  try {
    await getPool().query(`CREATE TABLE IF NOT EXISTS ec_users (
      id SERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      nom TEXT NOT NULL, prenom TEXT NOT NULL, poste TEXT DEFAULT 'Employe',
      role TEXT DEFAULT 'employe', actif BOOLEAN DEFAULT true, created_at TIMESTAMP DEFAULT NOW()
    )`);
    await getPool().query(`CREATE TABLE IF NOT EXISTS ec_presences (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES ec_users(id),
      date DATE NOT NULL, heure_arrivee TIME, heure_depart TIME,
      statut TEXT DEFAULT 'present', note TEXT DEFAULT '', created_at TIMESTAMP DEFAULT NOW()
    )`);
    await getPool().query(`CREATE TABLE IF NOT EXISTS ec_planning (
      id SERIAL PRIMARY KEY, titre TEXT NOT NULL, description TEXT DEFAULT '',
      date_debut TIMESTAMP NOT NULL, date_fin TIMESTAMP NOT NULL,
      type TEXT DEFAULT 'evenement', couleur TEXT DEFAULT '#c9a84c',
      created_by INTEGER REFERENCES ec_users(id), created_at TIMESTAMP DEFAULT NOW()
    )`);
    await getPool().query(`CREATE TABLE IF NOT EXISTS ec_annonces (
      id SERIAL PRIMARY KEY, titre TEXT NOT NULL, contenu TEXT NOT NULL,
      priorite TEXT DEFAULT 'normale', auteur_id INTEGER REFERENCES ec_users(id),
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    await getPool().query(`CREATE TABLE IF NOT EXISTS ec_disponibilites (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES ec_users(id),
      planning_id INTEGER REFERENCES ec_planning(id) ON DELETE CASCADE,
      statut TEXT NOT NULL DEFAULT 'oui',
      note TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, planning_id)
    )`);
    await getPool().query(`CREATE TABLE IF NOT EXISTS ec_commandes (
      id SERIAL PRIMARY KEY,
      client_nom TEXT NOT NULL,
      client_contact TEXT DEFAULT '',
      division TEXT NOT NULL DEFAULT 'securite',
      type_prestation TEXT NOT NULL,
      prestations_ids TEXT DEFAULT '[]',
      description TEXT DEFAULT '',
      date_evenement TIMESTAMP,
      lieu TEXT DEFAULT '',
      budget TEXT DEFAULT '',
      budget_estime NUMERIC DEFAULT 0,
      prix_final NUMERIC DEFAULT 0,
      paiement_partage TEXT DEFAULT '[]',
      statut TEXT NOT NULL DEFAULT 'nouveau',
      priorite TEXT NOT NULL DEFAULT 'normale',
      note_interne TEXT DEFAULT '',
      assigned_to INTEGER REFERENCES ec_users(id),
      created_by INTEGER REFERENCES ec_users(id),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )`);
    // Migration: ajouter les colonnes si elles n'existent pas encore (pour les BDD existantes)
    await getPool().query(`ALTER TABLE ec_commandes ADD COLUMN IF NOT EXISTS prestations_ids TEXT DEFAULT '[]'`);
    await getPool().query(`ALTER TABLE ec_commandes ADD COLUMN IF NOT EXISTS budget_estime NUMERIC DEFAULT 0`);
    await getPool().query(`ALTER TABLE ec_commandes ADD COLUMN IF NOT EXISTS prix_final NUMERIC DEFAULT 0`);
    await getPool().query(`ALTER TABLE ec_commandes ADD COLUMN IF NOT EXISTS paiement_partage TEXT DEFAULT '[]'`);
    await getPool().query(`ALTER TABLE ec_users ADD COLUMN IF NOT EXISTS must_reset_password BOOLEAN DEFAULT false`);
    await getPool().query(`ALTER TABLE ec_users ADD COLUMN IF NOT EXISTS statut_employe TEXT DEFAULT 'disponible'`);
    // Colonne postes_requis : sélection d'employés par poste pour une commande
    await getPool().query(`ALTER TABLE ec_commandes ADD COLUMN IF NOT EXISTS postes_requis TEXT DEFAULT '[]'`);
    // Migration statuts : renommer 'nouveau' → 'devis', 'paye' → 'confirme' si besoin
    await getPool().query(`UPDATE ec_commandes SET statut='devis' WHERE statut='nouveau'`);
    await getPool().query(`UPDATE ec_commandes SET statut='confirme' WHERE statut='paye'`);

    // Table fiches de paye
    await getPool().query(`CREATE TABLE IF NOT EXISTS ec_fiches_paye (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES ec_users(id) ON DELETE CASCADE,
      semaine_debut DATE NOT NULL,
      semaine_fin DATE NOT NULL,
      montant_total NUMERIC DEFAULT 0,
      statut TEXT DEFAULT 'en_attente',
      paye_par INTEGER REFERENCES ec_users(id),
      paye_le TIMESTAMP,
      details TEXT DEFAULT '[]',
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, semaine_debut)
    )`);

    // Table livre de comptes
    await getPool().query(`CREATE TABLE IF NOT EXISTS ec_comptes (
      id SERIAL PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'recette',
      categorie TEXT NOT NULL DEFAULT 'autre',
      description TEXT NOT NULL,
      montant NUMERIC NOT NULL,
      date DATE NOT NULL DEFAULT CURRENT_DATE,
      reference TEXT DEFAULT '',
      commande_id INTEGER REFERENCES ec_commandes(id) ON DELETE SET NULL,
      created_by INTEGER REFERENCES ec_users(id),
      created_at TIMESTAMP DEFAULT NOW()
    )`);

    await getPool().query(`CREATE TABLE IF NOT EXISTS ec_tarifs (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      label TEXT NOT NULL,
      division TEXT NOT NULL,
      emoji TEXT DEFAULT '💼',
      prix NUMERIC NOT NULL DEFAULT 0,
      unite TEXT DEFAULT 'forfait',
      actif BOOLEAN DEFAULT true,
      updated_at TIMESTAMP DEFAULT NOW()
    )`);

    await getPool().query(`CREATE TABLE IF NOT EXISTS ec_commandes_historique (
      id SERIAL PRIMARY KEY,
      commande_id INTEGER REFERENCES ec_commandes(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES ec_users(id),
      action TEXT NOT NULL,
      details TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    )`);

    // Table logs admin
    await getPool().query(`CREATE TABLE IF NOT EXISTS ec_logs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES ec_users(id),
      action TEXT NOT NULL,
      details TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    )`);
    // Insérer les tarifs par défaut si la table est vide
    const tc = await getPool().query('SELECT COUNT(*) FROM ec_tarifs');
    if (parseInt(tc.rows[0].count) === 0) {
      const tarifs = [
        ['securite_evenement',   'Sécurité événement',     'securite', '🛡️', 5000,  'forfait'],
        ['escorte_vip',          'Escorte VIP',             'securite', '🥷', 8000,  'forfait'],
        ['convoi_securise',      'Convoi sécurisé',         'securite', '🚗', 6000,  'forfait'],
        ['protection_rapprochee','Protection rapprochée',   'securite', '🔒', 12000, 'forfait'],
        ['soiree_privee',        'Soirée privée',           'soiree',   '🎉', 15000, 'forfait'],
        ['gala_ceremonie',       'Gala / Cérémonie',        'soiree',   '🏆', 25000, 'forfait'],
        ['animation_show',       'Animation / Show',        'lillys',   '💃', 7000,  'forfait'],
        ['prestation_artistique','Prestation artistique',   'lillys',   '🎭', 5000,  'forfait'],
        ['transfert_vip',        'Transfert VIP',           'tourisme', '✈️', 3000,  'forfait'],
        ['visite_guidee',        'Visite guidée',           'tourisme', '🗺️', 2000,  'forfait'],
        ['concierge',            'Service conciergerie',    'tourisme', '🛎️', 4000,  'forfait'],
        ['road_trip',            'Road Trip / Aventure',    'aventure', '🏔️', 10000, 'forfait'],
        ['expedition',           'Expédition',              'aventure', '🧭', 18000, 'forfait'],
        ['prestation_mesure',    'Prestation sur-mesure',   'multi',    '⭐', 0,     'à définir'],
      ];
      for (const [code, label, division, emoji, prix, unite] of tarifs) {
        await getPool().query(
          `INSERT INTO ec_tarifs (code,label,division,emoji,prix,unite) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (code) DO NOTHING`,
          [code, label, division, emoji, prix, unite]
        );
      }
      console.log('[DB] Tarifs par défaut insérés');
    }

    const c = await getPool().query('SELECT COUNT(*) FROM ec_users');
    if (parseInt(c.rows[0].count) === 0) {
      const h = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'elitecorp2026', 12);
      await getPool().query(
        `INSERT INTO ec_users (username,password_hash,nom,prenom,poste,role) VALUES ($1,$2,$3,$4,$5,$6)`,
        ['admin', h, 'Admin', 'Elite Corp', 'Directeur', 'admin']
      );
      console.log('[DB] Admin cree: admin / elitecorp2026');
    }
    dbReady = true;
    console.log('[DB] OK');
  } catch(e) {
    console.error('[DB] Erreur init:', e.message);
    setTimeout(initDB, 5000);
  }
}

/* ═══ AUTH ═══ */
const DIRECTION_POSTES = ['Directeur Général', 'Directeur de Division', 'Coordinateur'];
const VALID_ROLES = ['admin', 'direction', 'employe', 'interimaire'];
const auth = (req, res, next) => req.session?.user ? next() : res.status(401).json({ error: 'Non connecte' });
const isAdminOrDirection = (user) => user?.role === 'admin' || user?.role === 'direction' || DIRECTION_POSTES.includes(user?.poste);
const admin = (req, res, next) => isAdminOrDirection(req.session?.user) ? next() : res.status(403).json({ error: 'Acces refuse' });
// Bloque les intérimaires sur les actions sensibles
const notInterimaire = (req, res, next) => {
  if (req.session?.user?.role === 'interimaire') return res.status(403).json({ error: 'Accès refusé — rôle intérimaire' });
  next();
};

/* ═══ ROUTES AUTH ═══ */
app.post('/api/login', loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Champs manquants' });
    const r = await getPool().query('SELECT * FROM ec_users WHERE username=$1 AND actif=true', [username.toLowerCase()]);
    const u = r.rows[0];
    if (!u || !(await bcrypt.compare(password, u.password_hash))) return res.status(401).json({ error: 'Identifiants invalides' });
    req.session.user = { id: u.id, username: u.username, nom: u.nom, prenom: u.prenom, poste: u.poste, role: u.role };
    res.json({ success: true, user: req.session.user, must_reset_password: !!u.must_reset_password });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ success: true })));

app.get('/api/me', auth, async (req, res) => {
  try {
    const r = await getPool().query('SELECT id,username,nom,prenom,poste,role,actif,statut_employe FROM ec_users WHERE id=$1', [req.session.user.id]);
    const u = r.rows[0];
    if (u) req.session.user = { ...req.session.user, statut_employe: u.statut_employe || 'disponible' };
    res.json({ user: req.session.user });
  } catch(e) { res.json({ user: req.session.user }); }
});

// Modifier son propre profil (nom, prénom)
app.put('/api/me/profil', auth, async (req, res) => {
  try {
    const nom = sanitizeStr(req.body.nom, 100);
    const prenom = sanitizeStr(req.body.prenom, 100);
    if (!nom || !prenom) return res.status(400).json({ error: 'Nom et prénom requis' });
    await getPool().query('UPDATE ec_users SET nom=$1, prenom=$2 WHERE id=$3', [nom, prenom, req.session.user.id]);
    req.session.user.nom = nom;
    req.session.user.prenom = prenom;
    clearCache('employes');
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Changer son propre statut employé
app.put('/api/me/statut', auth, async (req, res) => {
  try {
    const { statut_employe } = req.body;
    const valides = ['disponible', 'en_mission', 'absent', 'conge', 'indisponible'];
    if (!valides.includes(statut_employe)) return res.status(400).json({ error: 'Statut invalide' });
    await getPool().query('UPDATE ec_users SET statut_employe=$1 WHERE id=$2', [statut_employe, req.session.user.id]);
    req.session.user.statut_employe = statut_employe;
    clearCache('employes');
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/mes-tickets', auth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'mes-tickets.html')));
app.get('/fiches-paye', auth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'fiches-paye.html')));
app.get('/livre-comptes', admin, (req, res) => res.sendFile(path.join(__dirname, 'public', 'livre-comptes.html')));
app.get('/reset-password', auth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'reset-password.html')));

/* Changer son propre mot de passe */
app.put('/api/me/password', auth, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) return res.status(400).json({ error: 'Champs manquants' });
    if (new_password.length < 6) return res.status(400).json({ error: 'Mot de passe trop court (6 caractères min)' });
    const r = await getPool().query('SELECT * FROM ec_users WHERE id=$1', [req.session.user.id]);
    const u = r.rows[0];
    if (!u || !(await bcrypt.compare(current_password, u.password_hash))) {
      return res.status(401).json({ error: 'Mot de passe actuel incorrect' });
    }
    const hash = await bcrypt.hash(new_password, 12);
    await getPool().query(
      'UPDATE ec_users SET password_hash=$1, must_reset_password=false WHERE id=$2',
      [hash, req.session.user.id]
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ═══ EMPLOYES ═══ */
app.get('/api/employes', auth, async (req, res) => {
  try {
    const cached = getCache('employes');
    if (cached) return res.json(cached);
    const rows = (await getPool().query('SELECT id,username,nom,prenom,poste,role,actif,statut_employe,created_at FROM ec_users ORDER BY nom')).rows;
    setCache('employes', rows);
    res.json(rows);
  }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/employes', admin, async (req, res) => {
  try {
    const { username, password, role } = req.body;
    const nom = sanitizeStr(req.body.nom, 100);
    const prenom = sanitizeStr(req.body.prenom, 100);
    const poste = sanitizeStr(req.body.poste, 100);
    if (!username || !password || !nom || !prenom) return res.status(400).json({ error: 'Champs manquants' });
    if (!/^[a-z0-9_]{3,32}$/.test(username)) return res.status(400).json({ error: 'Identifiant invalide (3-32 caractères, lettres minuscules, chiffres, underscore)' });
    const h = await bcrypt.hash(password, 12);
    const r = await getPool().query(
      `INSERT INTO ec_users (username,password_hash,nom,prenom,poste,role) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,username,nom,prenom,poste,role`,
      [username.toLowerCase(), h, nom, prenom, poste || 'Employe', VALID_ROLES.includes(role) ? role : 'employe']
    );
    clearCache('employes');
    res.json(r.rows[0]);
  } catch(e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Identifiant deja pris' });
    res.status(500).json({ error: e.message });
  }
});
app.put('/api/employes/:id', admin, async (req, res) => {
  try {
    const { nom, prenom, poste, role, actif, statut_employe } = req.body;

    // Récupérer l'ancien statut pour le log
    let oldStatut = null;
    if (statut_employe) {
      const old = await getPool().query('SELECT statut_employe, nom, prenom FROM ec_users WHERE id=$1', [req.params.id]);
      if (old.rows[0]) {
        oldStatut = old.rows[0].statut_employe;
        if (oldStatut !== statut_employe) {
          const nom_ = `${old.rows[0].prenom} ${old.rows[0].nom}`;
          await logStatutChange(req.session.user.id, req.params.id, nom_, oldStatut, statut_employe);
          broadcastEvent('employe_statut', { id: parseInt(req.params.id), statut_employe });
        }
      }
    }
    if (actif !== undefined) {
      const old = await getPool().query('SELECT nom, prenom FROM ec_users WHERE id=$1', [req.params.id]);
      if (old.rows[0]) {
        await logAdminAction(req.session.user.id, 'toggle_actif', `${old.rows[0].prenom} ${old.rows[0].nom} → actif=${actif}`);
        broadcastEvent('employe_actif', { id: parseInt(req.params.id), actif });
      }
    }

    await getPool().query(
      `UPDATE ec_users SET
        nom = COALESCE($1, nom),
        prenom = COALESCE($2, prenom),
        poste = COALESCE($3, poste),
        role = COALESCE($4, role),
        actif = COALESCE($5, actif),
        statut_employe = COALESCE($6, statut_employe)
       WHERE id = $7`,
      [nom || null, prenom || null, poste || null, role || null, actif !== undefined ? actif : null, statut_employe || null, req.params.id]
    );
    clearCache('employes');
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/employes/:id', admin, async (req, res) => {
  try {
    const id = req.params.id;
    if (parseInt(id) === req.session.user.id) return res.status(400).json({ error: 'Impossible de supprimer votre propre compte' });
    await getPool().query('DELETE FROM ec_disponibilites WHERE user_id=$1', [id]);
    await getPool().query('DELETE FROM ec_presences WHERE user_id=$1', [id]);
    await getPool().query('DELETE FROM ec_users WHERE id=$1', [id]);
    clearCache('employes');
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Reset mot de passe d'un employé (direction uniquement)
app.post('/api/employes/:id/reset-password', admin, async (req, res) => {
  try {
    const { new_password } = req.body;
    if (!new_password || new_password.length < 6) return res.status(400).json({ error: 'Mot de passe trop court (6 min)' });
    const hash = await bcrypt.hash(new_password, 12);
    await getPool().query(
      'UPDATE ec_users SET password_hash=$1, must_reset_password=true WHERE id=$2',
      [hash, req.params.id]
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ═══ PRESENCES ═══ */
app.get('/api/presences', auth, async (req, res) => {
  try {
    const { date, user_id } = req.query;
    let q = `SELECT p.*,u.nom,u.prenom,u.poste FROM ec_presences p JOIN ec_users u ON p.user_id=u.id WHERE 1=1`;
    const params = [];
    if (date) { params.push(date); q += ` AND p.date=$${params.length}`; }
    if (user_id) { params.push(user_id); q += ` AND p.user_id=$${params.length}`; }
    q += ' ORDER BY p.date DESC,u.nom';
    res.json((await getPool().query(q, params)).rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/presences/pointer', auth, async (req, res) => {
  try {
    const uid = req.session.user.id;
    const today = new Date().toISOString().split('T')[0];
    const now = new Date().toTimeString().slice(0, 8);
    const ex = await getPool().query('SELECT * FROM ec_presences WHERE user_id=$1 AND date=$2', [uid, today]);
    if (!ex.rows.length) {
      await getPool().query('INSERT INTO ec_presences (user_id,date,heure_arrivee,statut) VALUES ($1,$2,$3,$4)', [uid, today, now, 'present']);
      res.json({ action: 'arrivee', heure: now });
    } else if (!ex.rows[0].heure_depart) {
      await getPool().query('UPDATE ec_presences SET heure_depart=$1 WHERE user_id=$2 AND date=$3', [now, uid, today]);
      res.json({ action: 'depart', heure: now });
    } else { res.json({ action: 'deja_pointe' }); }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ═══ PLANNING ═══ */
app.get('/api/planning', auth, async (req, res) => {
  try {
    const { mois, annee } = req.query;
    let q = `SELECT p.*,u.nom as createur_nom FROM ec_planning p LEFT JOIN ec_users u ON p.created_by=u.id WHERE 1=1`;
    const params = [];
    if (mois && annee) { params.push(annee, mois); q += ` AND EXTRACT(YEAR FROM p.date_debut)=$1 AND EXTRACT(MONTH FROM p.date_debut)=$2`; }
    q += ' ORDER BY p.date_debut';
    res.json((await getPool().query(q, params)).rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/planning', admin, async (req, res) => {
  try {
    const { titre, description, date_debut, date_fin, type, couleur } = req.body;
    if (!titre || !date_debut || !date_fin) return res.status(400).json({ error: 'Champs manquants' });
    const r = await getPool().query(
      `INSERT INTO ec_planning (titre,description,date_debut,date_fin,type,couleur,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [titre, description || '', date_debut, date_fin, type || 'evenement', couleur || '#c9a84c', req.session.user.id]
    );
    res.json({ success: true, id: r.rows[0].id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/planning/:id', admin, async (req, res) => {
  try { await getPool().query('DELETE FROM ec_planning WHERE id=$1', [req.params.id]); res.json({ success: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

/* ═══ TARIFS ═══ */
app.get('/api/tarifs', auth, async (req, res) => {
  try {
    const cached = getCache('tarifs');
    if (cached) return res.json(cached);
    const rows = (await getPool().query('SELECT * FROM ec_tarifs WHERE actif=true ORDER BY division,label')).rows;
    setCache('tarifs', rows);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/tarifs/:id', admin, async (req, res) => {
  try {
    const { prix, label, unite } = req.body;
    await getPool().query(
      'UPDATE ec_tarifs SET prix=$1, label=COALESCE($2,label), unite=COALESCE($3,unite), updated_at=NOW() WHERE id=$4',
      [prix, label || null, unite || null, req.params.id]
    );
    clearCache('tarifs');
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ═══ COMMANDES ÉVÉNEMENTS ═══ */

/* Tickets assignés à l'employé connecté (statut >= confirmé) */
app.get('/api/commandes/mes-tickets', auth, async (req, res) => {
  try {
    const statutsVisibles = ['confirme', 'en_cours', 'termine'];
    const r = await getPool().query(
      `SELECT c.id, c.client_nom, c.client_contact, c.division, c.type_prestation,
              c.description, c.date_evenement, c.lieu, c.statut, c.priorite,
              c.prestations_ids, c.budget_estime, c.prix_final, c.postes_requis
       FROM ec_commandes c
       WHERE c.assigned_to = $1 AND c.statut = ANY($2)
       ORDER BY c.date_evenement ASC NULLS LAST`,
      [req.session.user.id, statutsVisibles]
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* Employés actifs par poste (pour sélection dans les commandes) */
app.get('/api/employes/par-poste', auth, async (req, res) => {
  try {
    const rows = (await getPool().query(
      `SELECT poste,
        COUNT(*) FILTER (WHERE statut_employe = 'disponible') as nb_dispo,
        COUNT(*) as nb_total,
        array_agg(json_build_object(
          'id',id,'nom',nom,'prenom',prenom,'poste',poste,
          'statut_employe',statut_employe
        )) as employes
       FROM ec_users WHERE actif=true GROUP BY poste ORDER BY poste`
    )).rows;
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/commandes', auth, async (req, res) => {
  try {
    const { statut, division, search } = req.query;
    let q = `SELECT c.*, u.nom as assigned_nom, u.prenom as assigned_prenom,
             cr.nom as createur_nom FROM ec_commandes c
             LEFT JOIN ec_users u ON c.assigned_to = u.id
             LEFT JOIN ec_users cr ON c.created_by = cr.id
             WHERE 1=1`;
    const params = [];
    if (statut) { params.push(statut); q += ` AND c.statut=$${params.length}`; }
    if (division) { params.push(division); q += ` AND c.division=$${params.length}`; }
    if (search) { params.push(`%${search.toLowerCase()}%`); q += ` AND (LOWER(c.client_nom) LIKE $${params.length} OR LOWER(c.type_prestation) LIKE $${params.length} OR LOWER(c.lieu) LIKE $${params.length})`; }
    q += ' ORDER BY c.created_at DESC LIMIT 200';
    res.json((await getPool().query(q, params)).rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/commandes', auth, notInterimaire, async (req, res) => {
  try {
    const client_nom = sanitizeStr(req.body.client_nom, 200);
    const client_contact = sanitizeStr(req.body.client_contact, 200);
    const division = sanitizeStr(req.body.division, 50);
    const type_prestation = sanitizeStr(req.body.type_prestation, 300);
    const { prestations_ids, postes_requis } = req.body;
    const description = sanitizeStr(req.body.description, 2000);
    const { date_evenement } = req.body;
    const lieu = sanitizeStr(req.body.lieu, 300);
    const { budget } = req.body;
    const budget_estime = sanitizeNum(req.body.budget_estime, 0, 9999999) ?? 0;
    const { priorite } = req.body;
    const note_interne = sanitizeStr(req.body.note_interne, 2000);
    if (!client_nom || !type_prestation) return res.status(400).json({ error: 'Champs manquants' });
    const r = await getPool().query(
      `INSERT INTO ec_commandes (client_nom,client_contact,division,type_prestation,prestations_ids,postes_requis,description,date_evenement,lieu,budget,budget_estime,priorite,note_interne,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [client_nom, client_contact||'', division||'securite', type_prestation, JSON.stringify(prestations_ids||[]), JSON.stringify(postes_requis||[]), description||'', date_evenement||null, lieu||'', budget||'', budget_estime||0, priorite||'normale', note_interne||'', req.session.user.id]
    );
    res.json({ success: true, id: r.rows[0].id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/commandes/:id', auth, notInterimaire, async (req, res) => {
  try {
    const { statut, assigned_to, priorite, budget, date_evenement } = req.body;
    const note_interne = sanitizeStr(req.body.note_interne, 2000) || null;
    const lieu = sanitizeStr(req.body.lieu, 300) || null;
    const client_contact = sanitizeStr(req.body.client_contact, 200) || null;
    const budget_estime = req.body.budget_estime !== undefined ? sanitizeNum(req.body.budget_estime, 0, 9999999) : null;
    const postes_requis = req.body.postes_requis !== undefined ? JSON.stringify(req.body.postes_requis) : null;

    // Valider le statut
    const STATUTS_VALIDES = ['devis', 'confirme', 'en_cours', 'termine'];
    if (statut && !STATUTS_VALIDES.includes(statut)) {
      return res.status(400).json({ error: `Statut invalide. Valeurs acceptées : ${STATUTS_VALIDES.join(', ')}` });
    }

    await getPool().query(
      `UPDATE ec_commandes SET statut=COALESCE($1,statut), note_interne=COALESCE($2,note_interne),
       assigned_to=COALESCE($3,assigned_to), priorite=COALESCE($4,priorite),
       budget=COALESCE($5,budget), budget_estime=COALESCE($6,budget_estime),
       lieu=COALESCE($7,lieu), date_evenement=COALESCE($8,date_evenement),
       client_contact=COALESCE($9,client_contact),
       postes_requis=COALESCE($10,postes_requis),
       updated_at=NOW() WHERE id=$11`,
      [statut||null, note_interne||null, assigned_to||null, priorite||null, budget||null, budget_estime||null, lieu||null, date_evenement||null, client_contact||null, postes_requis||null, req.params.id]
    );

    // Auto-ajout au planning quand statut passe à "confirme"
    if (statut === 'confirme') {
      try {
        const cmdRes = await getPool().query('SELECT * FROM ec_commandes WHERE id=$1', [req.params.id]);
        const cmd = cmdRes.rows[0];
        if (cmd && cmd.date_evenement) {
          const existing = await getPool().query(
            `SELECT id FROM ec_planning WHERE titre LIKE $1`,
            [`[CMD#${cmd.id}]%`]
          );
          if (existing.rows.length === 0) {
            const dateDebut = new Date(cmd.date_evenement);
            const dateFin = new Date(dateDebut.getTime() + 4 * 60 * 60 * 1000);
            await getPool().query(
              `INSERT INTO ec_planning (titre, description, date_debut, date_fin, type, couleur, created_by)
               VALUES ($1, $2, $3, $4, $5, $6, $7)`,
              [
                `[CMD#${cmd.id}] ${cmd.client_nom}`,
                `${cmd.type_prestation}${cmd.lieu ? ' — ' + cmd.lieu : ''}`,
                dateDebut.toISOString(),
                dateFin.toISOString(),
                'evenement',
                '#c9a84c',
                req.session.user.id
              ]
            );
          }
        }
      } catch(planErr) {
        console.error('[PLANNING AUTO] Erreur:', planErr.message);
      }
    }

    // Log historique
    try {
      const changes = [];
      if (statut) changes.push(`statut → ${statut}`);
      if (assigned_to) changes.push(`assigné → employé #${assigned_to}`);
      if (client_contact) changes.push('contact mis à jour');
      if (lieu) changes.push('lieu mis à jour');
      if (date_evenement) changes.push('date mise à jour');
      if (postes_requis) changes.push('postes requis mis à jour');
      if (changes.length > 0) {
        await getPool().query(
          `INSERT INTO ec_commandes_historique (commande_id, user_id, action, details) VALUES ($1,$2,$3,$4)`,
          [req.params.id, req.session.user.id, 'modification', changes.join(', ')]
        );
      }
    } catch(histErr) { console.error('[HISTORIQUE]', histErr.message); }

    // Broadcast SSE
    if (statut) {
      broadcastEvent('commande_update', { id: req.params.id, statut });
    }

    // Fiches de paye auto quand terminé
    if (statut === 'termine') {
      try {
        const cmdFull = await getPool().query('SELECT * FROM ec_commandes WHERE id=$1', [req.params.id]);
        const cmd = cmdFull.rows[0];
        if (cmd && cmd.prix_final > 0) {
          const partage = JSON.parse(cmd.paiement_partage || '[]');
          if (partage.length > 0 && cmd.date_evenement) {
            const d = new Date(cmd.date_evenement);
            const day = d.getDay();
            const diffLundi = day === 0 ? -6 : 1 - day;
            const lundi = new Date(d); lundi.setDate(d.getDate() + diffLundi); lundi.setHours(0,0,0,0);
            const dimanche = new Date(lundi); dimanche.setDate(lundi.getDate() + 6);
            const lundiStr = lundi.toISOString().split('T')[0];
            const dimancheStr = dimanche.toISOString().split('T')[0];
            for (const p of partage) {
              if (!p.user_id) continue;
              await getPool().query(
                `INSERT INTO ec_fiches_paye (user_id, semaine_debut, semaine_fin, montant_total, statut, details)
                 VALUES ($1,$2,$3,$4,'en_attente',$5)
                 ON CONFLICT (user_id, semaine_debut) DO UPDATE
                 SET montant_total = ec_fiches_paye.montant_total + EXCLUDED.montant_total,
                     details = EXCLUDED.details`,
                [p.user_id, lundiStr, dimancheStr, p.montant,
                 JSON.stringify([{ commande_id: cmd.id, client_nom: cmd.client_nom, type_prestation: cmd.type_prestation, montant: p.montant }])]
              );
            }
            console.log(`[FICHES AUTO] Générées pour commande #${cmd.id}`);
          }
        }
      } catch(ficheErr) { console.error('[FICHES AUTO]', ficheErr.message); }
    }

    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/commandes/:id', admin, async (req, res) => {
  try { await getPool().query('DELETE FROM ec_commandes WHERE id=$1', [req.params.id]); res.json({ success: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/commandes/:id/historique', auth, async (req, res) => {
  try {
    const r = await getPool().query(
      `SELECT h.*, u.nom, u.prenom FROM ec_commandes_historique h
       LEFT JOIN ec_users u ON h.user_id = u.id
       WHERE h.commande_id = $1 ORDER BY h.created_at DESC LIMIT 50`,
      [req.params.id]
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* Passer une commande en "terminé" et calculer le partage (paiement sur confirme) */
app.post('/api/commandes/:id/payer', admin, async (req, res) => {
  try {
    const { prix_final } = req.body;
    if (!prix_final || isNaN(prix_final) || Number(prix_final) <= 0) {
      return res.status(400).json({ error: 'Prix final invalide' });
    }
    const cmdRes = await getPool().query('SELECT * FROM ec_commandes WHERE id=$1', [req.params.id]);
    const cmd = cmdRes.rows[0];
    if (!cmd) return res.status(404).json({ error: 'Commande introuvable' });
    if (!['confirme', 'en_cours'].includes(cmd.statut)) {
      return res.status(400).json({ error: 'Le paiement est disponible uniquement sur une commande confirmée ou en cours' });
    }

    // Calculer le partage selon les postes requis ou les présences
    let partage = [];
    let postesRequis = [];
    try { postesRequis = JSON.parse(cmd.postes_requis || '[]'); } catch(e) {}

    if (postesRequis.length > 0) {
      // Partage basé sur les postes requis définis dans la commande
      const montantTotal = Number(prix_final);
      const nbTotal = postesRequis.reduce((sum, p) => sum + (parseInt(p.nb) || 0), 0);
      if (nbTotal > 0) {
        const montantParPersonne = Math.round((montantTotal / nbTotal) * 100) / 100;
        for (const pr of postesRequis) {
          const nb = parseInt(pr.nb) || 0;
          // Récupérer les employés actifs avec ce poste
          const empRes = await getPool().query(
            `SELECT id, nom, prenom, poste FROM ec_users WHERE poste=$1 AND actif=true LIMIT $2`,
            [pr.poste, nb]
          );
          for (const emp of empRes.rows) {
            partage.push({ user_id: emp.id, nom: emp.prenom + ' ' + emp.nom, poste: emp.poste, montant: montantParPersonne });
          }
          // Si pas assez d'employés trouvés, ajouter des entrées sans user_id
          for (let i = empRes.rows.length; i < nb; i++) {
            partage.push({ user_id: null, nom: `${pr.poste} (non assigné)`, poste: pr.poste, montant: montantParPersonne });
          }
        }
      }
    } else if (cmd.date_evenement) {
      // Fallback : partage basé sur les présences du jour
      const dateStr = new Date(cmd.date_evenement).toISOString().split('T')[0];
      const presRes = await getPool().query(
        `SELECT p.user_id, u.nom, u.prenom, u.poste FROM ec_presences p
         JOIN ec_users u ON p.user_id = u.id
         WHERE p.date = $1 AND p.statut = 'present' AND u.actif = true`,
        [dateStr]
      );
      const presents = presRes.rows;
      const montantTotal = Number(prix_final);
      if (presents.length > 0) {
        const montantParPersonne = Math.round((montantTotal / presents.length) * 100) / 100;
        partage = presents.map(p => ({ user_id: p.user_id, nom: p.prenom + ' ' + p.nom, poste: p.poste, montant: montantParPersonne }));
      }
    }

    await getPool().query(
      `UPDATE ec_commandes SET statut='termine', prix_final=$1, paiement_partage=$2, updated_at=NOW() WHERE id=$3`,
      [Number(prix_final), JSON.stringify(partage), req.params.id]
    );

    // Auto-enregistrer la recette dans le livre de comptes
    try {
      await getPool().query(
        `INSERT INTO ec_comptes (type, categorie, description, montant, date, reference, commande_id, created_by)
         VALUES ('recette', 'evenement', $1, $2, $3, $4, $5, $6)`,
        [
          `Paiement — ${cmd.client_nom} (${cmd.type_prestation})`,
          Number(prix_final),
          cmd.date_evenement ? new Date(cmd.date_evenement).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
          `CMD#${cmd.id}`,
          cmd.id,
          req.session.user.id
        ]
      );
    } catch(compteErr) {
      console.error('[COMPTES AUTO] Erreur:', compteErr.message);
    }

    res.json({ success: true, partage, prix_final: Number(prix_final) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ═══ LIVRE DE COMPTES ═══ */

// Lister les entrées (direction uniquement)
app.get('/api/comptes', admin, async (req, res) => {
  try {
    const { type, categorie, date_debut, date_fin } = req.query;
    let q = `SELECT c.*, u.nom as createur_nom, u.prenom as createur_prenom,
             cmd.client_nom as commande_client
             FROM ec_comptes c
             LEFT JOIN ec_users u ON c.created_by = u.id
             LEFT JOIN ec_commandes cmd ON c.commande_id = cmd.id
             WHERE 1=1`;
    const params = [];
    if (type) { params.push(type); q += ` AND c.type = $${params.length}`; }
    if (categorie) { params.push(categorie); q += ` AND c.categorie = $${params.length}`; }
    if (date_debut) { params.push(date_debut); q += ` AND c.date >= $${params.length}`; }
    if (date_fin) { params.push(date_fin); q += ` AND c.date <= $${params.length}`; }
    q += ' ORDER BY c.date DESC, c.created_at DESC';
    res.json((await getPool().query(q, params)).rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Ajouter une entrée manuelle
app.post('/api/comptes', admin, async (req, res) => {
  try {
    const { type, categorie, date, commande_id } = req.body;
    const description = sanitizeStr(req.body.description, 500);
    const reference = sanitizeStr(req.body.reference, 200);
    const montant = sanitizeNum(req.body.montant, 0, 9999999);
    if (!description || montant === null || !type) return res.status(400).json({ error: 'Champs manquants' });
    const r = await getPool().query(
      `INSERT INTO ec_comptes (type, categorie, description, montant, date, reference, commande_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [type, categorie||'autre', description, Math.abs(montant), date||new Date().toISOString().split('T')[0], reference||'', commande_id||null, req.session.user.id]
    );
    res.json({ success: true, entry: r.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Supprimer une entrée
app.delete('/api/comptes/:id', admin, async (req, res) => {
  try {
    await getPool().query('DELETE FROM ec_comptes WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Export CSV livre de comptes
app.get('/api/comptes/export-csv', admin, async (req, res) => {
  try {
    const { date_debut, date_fin } = req.query;
    let q = `SELECT c.type, c.categorie, c.description, c.montant, c.date, c.reference,
             u.nom as createur_nom, cmd.client_nom as commande_client
             FROM ec_comptes c
             LEFT JOIN ec_users u ON c.created_by = u.id
             LEFT JOIN ec_commandes cmd ON c.commande_id = cmd.id
             WHERE 1=1`;
    const params = [];
    if (date_debut) { params.push(date_debut); q += ` AND c.date >= $${params.length}`; }
    if (date_fin) { params.push(date_fin); q += ` AND c.date <= $${params.length}`; }
    q += ' ORDER BY c.date DESC';
    const rows = (await getPool().query(q, params)).rows;
    const header = 'Date,Type,Catégorie,Description,Montant,Référence,Ajouté par,Commande\n';
    const csv = header + rows.map(r =>
      [r.date?.toISOString?.()?.split('T')[0] || r.date, r.type, r.categorie,
       `"${(r.description||'').replace(/"/g,'""')}"`, r.montant,
       `"${(r.reference||'').replace(/"/g,'""')}"`,
       r.createur_nom || '', r.commande_client || ''].join(',')
    ).join('\n');
    const stamp = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="comptes-${stamp}.csv"`);
    res.send('\uFEFF' + csv); // BOM pour Excel
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Résumé financier (solde, totaux)
app.get('/api/comptes/resume', admin, async (req, res) => {
  try {
    const { date_debut, date_fin } = req.query;
    let where = 'WHERE 1=1';
    const params = [];
    if (date_debut) { params.push(date_debut); where += ` AND date >= $${params.length}`; }
    if (date_fin) { params.push(date_fin); where += ` AND date <= $${params.length}`; }
    const r = await getPool().query(
      `SELECT
        COALESCE(SUM(CASE WHEN type='recette' THEN montant ELSE 0 END),0) as total_recettes,
        COALESCE(SUM(CASE WHEN type='depense' THEN montant ELSE 0 END),0) as total_depenses,
        COALESCE(SUM(CASE WHEN type='recette' THEN montant ELSE -montant END),0) as solde
       FROM ec_comptes ${where}`, params
    );
    // Par catégorie
    const cats = await getPool().query(
      `SELECT type, categorie, SUM(montant) as total, COUNT(*) as nb
       FROM ec_comptes ${where}
       GROUP BY type, categorie ORDER BY total DESC`, params
    );
    res.json({ ...r.rows[0], par_categorie: cats.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ═══ FICHES DE PAYE ═══ */

// Helper: obtenir lundi et dimanche d'une semaine donnée
function getSemaineBornes(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date();
  const day = d.getDay(); // 0=dim, 1=lun...
  const diffLundi = (day === 0 ? -6 : 1 - day);
  const lundi = new Date(d);
  lundi.setDate(d.getDate() + diffLundi);
  lundi.setHours(0,0,0,0);
  const dimanche = new Date(lundi);
  dimanche.setDate(lundi.getDate() + 6);
  dimanche.setHours(23,59,59,999);
  return { lundi, dimanche };
}

// Générer les fiches de paye pour une semaine (direction)
app.post('/api/fiches-paye/generer', admin, async (req, res) => {
  try {
    const { semaine } = req.body; // date ISO dans la semaine voulue
    const { lundi, dimanche } = getSemaineBornes(semaine);
    const lundiStr = lundi.toISOString().split('T')[0];
    const dimancheStr = dimanche.toISOString().split('T')[0];

    // Récupérer toutes les commandes terminées cette semaine avec leur partage
    const cmdsRes = await getPool().query(
      `SELECT id, client_nom, type_prestation, division, lieu, date_evenement, prix_final, paiement_partage
       FROM ec_commandes
       WHERE statut = 'termine'
       AND date_evenement >= $1 AND date_evenement <= $2`,
      [lundi.toISOString(), dimanche.toISOString()]
    );

    // Construire un map user_id → gains
    const gainsParUser = {};
    for (const cmd of cmdsRes.rows) {
      let partage = [];
      try { partage = JSON.parse(cmd.paiement_partage || '[]'); } catch(e) {}
      for (const p of partage) {
        if (!p.user_id) continue; // skip part entreprise
        if (!gainsParUser[p.user_id]) gainsParUser[p.user_id] = { total: 0, evenements: [] };
        gainsParUser[p.user_id].total += Number(p.montant);
        gainsParUser[p.user_id].evenements.push({
          commande_id: cmd.id,
          client_nom: cmd.client_nom,
          type_prestation: cmd.type_prestation,
          division: cmd.division,
          lieu: cmd.lieu || '',
          date_evenement: cmd.date_evenement,
          montant: Number(p.montant)
        });
      }
    }

    // Créer ou mettre à jour les fiches
    const fiches = [];
    for (const [userId, data] of Object.entries(gainsParUser)) {
      const r = await getPool().query(
        `INSERT INTO ec_fiches_paye (user_id, semaine_debut, semaine_fin, montant_total, statut, details)
         VALUES ($1, $2, $3, $4, 'en_attente', $5)
         ON CONFLICT (user_id, semaine_debut) DO UPDATE
         SET montant_total = EXCLUDED.montant_total, details = EXCLUDED.details, statut = 'en_attente'
         RETURNING *`,
        [userId, lundiStr, dimancheStr, data.total, JSON.stringify(data.evenements)]
      );
      fiches.push(r.rows[0]);
    }

    res.json({ success: true, semaine_debut: lundiStr, semaine_fin: dimancheStr, fiches_generees: fiches.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Lister les fiches (direction = toutes, employé = les siennes)
app.get('/api/fiches-paye', auth, async (req, res) => {
  try {
    const { semaine } = req.query;
    const isDir = isAdminOrDirection(req.session.user);
    let q = `SELECT f.*, u.nom, u.prenom, u.poste,
             p.nom as paye_par_nom FROM ec_fiches_paye f
             JOIN ec_users u ON f.user_id = u.id
             LEFT JOIN ec_users p ON f.paye_par = p.id
             WHERE 1=1`;
    const params = [];
    if (!isDir) {
      params.push(req.session.user.id);
      q += ` AND f.user_id = $${params.length}`;
    }
    if (semaine) {
      const { lundi } = getSemaineBornes(semaine);
      params.push(lundi.toISOString().split('T')[0]);
      q += ` AND f.semaine_debut = $${params.length}`;
    }
    q += ' ORDER BY f.semaine_debut DESC, u.nom ASC';
    res.json((await getPool().query(q, params)).rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Marquer une fiche comme payée (direction)
app.post('/api/fiches-paye/:id/payer', admin, async (req, res) => {
  try {
    const ficheRes = await getPool().query(
      `SELECT f.*, u.nom, u.prenom FROM ec_fiches_paye f JOIN ec_users u ON f.user_id = u.id WHERE f.id=$1`,
      [req.params.id]
    );
    const fiche = ficheRes.rows[0];
    if (!fiche) return res.status(404).json({ error: 'Fiche introuvable' });

    await getPool().query(
      `UPDATE ec_fiches_paye SET statut='paye', paye_par=$1, paye_le=NOW() WHERE id=$2`,
      [req.session.user.id, req.params.id]
    );

    // Auto-enregistrer la dépense dans le livre de comptes
    try {
      await getPool().query(
        `INSERT INTO ec_comptes (type, categorie, description, montant, date, reference, created_by)
         VALUES ('depense', 'salaires', $1, $2, $3, $4, $5)`,
        [
          `Fiche de paye — ${fiche.prenom} ${fiche.nom} (sem. ${fiche.semaine_debut})`,
          Number(fiche.montant_total),
          new Date().toISOString().split('T')[0],
          `FICHE#${fiche.id}`,
          req.session.user.id
        ]
      );
    } catch(compteErr) {
      console.error('[COMPTES AUTO] Erreur fiche:', compteErr.message);
    }

    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Semaines disponibles
app.get('/api/fiches-paye/semaines', auth, async (req, res) => {
  try {
    const isDir = isAdminOrDirection(req.session.user);
    let q = `SELECT DISTINCT semaine_debut, semaine_fin FROM ec_fiches_paye`;
    const params = [];
    if (!isDir) {
      params.push(req.session.user.id);
      q += ` WHERE user_id = $1`;
    }
    q += ' ORDER BY semaine_debut DESC';
    res.json((await getPool().query(q, params)).rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ═══ DISPONIBILITÉS PLANNING ═══ */
app.get('/api/disponibilites/:planning_id', auth, async (req, res) => {
  try {
    const r = await getPool().query(
      `SELECT d.*,u.nom,u.prenom,u.poste FROM ec_disponibilites d
       JOIN ec_users u ON d.user_id=u.id
       WHERE d.planning_id=$1 ORDER BY u.nom`,
      [req.params.planning_id]
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/disponibilites/moi/:planning_id', auth, async (req, res) => {
  try {
    const r = await getPool().query(
      'SELECT * FROM ec_disponibilites WHERE user_id=$1 AND planning_id=$2',
      [req.session.user.id, req.params.planning_id]
    );
    res.json(r.rows[0] || null);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/disponibilites', auth, async (req, res) => {
  try {
    const { planning_id, statut, note } = req.body;
    const validStatuts = ['oui', 'non', 'peut-etre', 'retard'];
    if (!planning_id || !validStatuts.includes(statut)) return res.status(400).json({ error: 'Données invalides' });
    await getPool().query(
      `INSERT INTO ec_disponibilites (user_id,planning_id,statut,note)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id,planning_id) DO UPDATE SET statut=$3,note=$4`,
      [req.session.user.id, planning_id, statut, note || '']
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ═══ ANNONCES ═══ */
app.get('/api/annonces', auth, async (req, res) => {
  try {
    res.json((await getPool().query(`SELECT a.*,u.nom as auteur_nom FROM ec_annonces a LEFT JOIN ec_users u ON a.auteur_id=u.id ORDER BY a.created_at DESC LIMIT 20`)).rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/annonces', admin, async (req, res) => {
  try {
    const { titre, contenu, priorite } = req.body;
    if (!titre || !contenu) return res.status(400).json({ error: 'Champs manquants' });
    await getPool().query('INSERT INTO ec_annonces (titre,contenu,priorite,auteur_id) VALUES ($1,$2,$3,$4)',
      [titre, contenu, priorite || 'normale', req.session.user.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/annonces/:id', admin, async (req, res) => {
  try { await getPool().query('DELETE FROM ec_annonces WHERE id=$1', [req.params.id]); res.json({ success: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

/* ═══ STATS ═══ */
app.get('/api/stats', auth, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const [a, b, c, d, e] = await Promise.all([
      getPool().query('SELECT COUNT(*) FROM ec_users WHERE actif=true'),
      getPool().query("SELECT COUNT(*) FROM ec_presences WHERE date=$1 AND statut='present'", [today]),
      getPool().query('SELECT COUNT(*) FROM ec_planning WHERE date_debut >= NOW()'),
      getPool().query('SELECT COUNT(*) FROM ec_annonces'),
      getPool().query("SELECT COUNT(*) FILTER (WHERE statut='confirme') as confirme, COUNT(*) FILTER (WHERE statut='en_cours') as en_cours, COUNT(*) FILTER (WHERE statut='devis') as devis FROM ec_commandes")
    ]);
    res.json({
      employes: +a.rows[0].count,
      presents_aujourd_hui: +b.rows[0].count,
      evenements_a_venir: +c.rows[0].count,
      annonces: +d.rows[0].count,
      commandes_confirme: +e.rows[0].confirme,
      commandes_en_cours: +e.rows[0].en_cours,
      commandes_devis: +e.rows[0].devis
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

/* ═══ LOGS ADMIN ═══ */
app.get('/api/logs', admin, async (req, res) => {
  try {
    const rows = (await getPool().query(
      `SELECT l.*, u.nom, u.prenom FROM ec_logs l
       LEFT JOIN ec_users u ON l.user_id = u.id
       ORDER BY l.created_at DESC LIMIT 100`
    )).rows;
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ═══ NOTIFICATIONS SSE (temps réel) ═══ */
const sseClients = new Map(); // sessionId → res

app.get('/api/events', auth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const clientId = req.session.user.id + '_' + Date.now();
  sseClients.set(clientId, res);

  // Ping toutes les 25s pour garder la connexion
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch(e) { clearInterval(ping); }
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(clientId);
  });
});

function broadcastEvent(type, data) {
  const msg = `data: ${JSON.stringify({ type, data, ts: Date.now() })}\n\n`;
  for (const [, res] of sseClients) {
    try { res.write(msg); } catch(e) {}
  }
}

/* ═══ HISTORIQUE STATUTS EMPLOYÉ ═══ */
async function logStatutChange(userId, targetId, targetNom, oldStatut, newStatut) {
  try {
    await getPool().query(
      `INSERT INTO ec_logs (user_id, action, details, created_at) VALUES ($1,$2,$3,NOW())`,
      [userId, 'statut_employe', `${targetNom} : ${oldStatut} → ${newStatut}`]
    );
  } catch(e) {}
}

async function logAdminAction(userId, action, details) {
  try {
    await getPool().query(
      `INSERT INTO ec_logs (user_id, action, details, created_at) VALUES ($1,$2,$3,NOW())`,
      [userId, action, details]
    );
  } catch(e) {}
}

/* ═══ PAGES ═══ */
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

/* ═══ START ═══ */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[ELITE CORP v2] Port ${PORT} OK`);
  initDB();
});

process.on('unhandledRejection', r => console.error('[UNHANDLED]', r));
process.on('uncaughtException', e => console.error('[UNCAUGHT]', e.message));
