require('dotenv').config();
const express = require('express');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

/* ═══ MIDDLEWARE ═══ */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'elitecorp2026',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    maxAge: 604800000,
    httpOnly: true,
    sameSite: 'lax',
    secure: false
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
      max: 5
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
const auth = (req, res, next) => req.session?.user ? next() : res.status(401).json({ error: 'Non connecte' });
const admin = (req, res, next) => req.session?.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Acces refuse' });

/* ═══ ROUTES AUTH ═══ */
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Champs manquants' });
    const r = await getPool().query('SELECT * FROM ec_users WHERE username=$1 AND actif=true', [username.toLowerCase()]);
    const u = r.rows[0];
    if (!u || !(await bcrypt.compare(password, u.password_hash))) return res.status(401).json({ error: 'Identifiants invalides' });
    req.session.user = { id: u.id, username: u.username, nom: u.nom, prenom: u.prenom, poste: u.poste, role: u.role };
    res.json({ success: true, user: req.session.user });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ success: true })));
app.get('/api/me', auth, (req, res) => res.json({ user: req.session.user }));
app.get('/mes-tickets', auth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'mes-tickets.html')));

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
    await getPool().query('UPDATE ec_users SET password_hash=$1 WHERE id=$2', [hash, req.session.user.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ═══ EMPLOYES ═══ */
app.get('/api/employes', auth, async (req, res) => {
  try { res.json((await getPool().query('SELECT id,username,nom,prenom,poste,role,actif,created_at FROM ec_users ORDER BY nom')).rows); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/employes', admin, async (req, res) => {
  try {
    const { username, password, nom, prenom, poste, role } = req.body;
    if (!username || !password || !nom || !prenom) return res.status(400).json({ error: 'Champs manquants' });
    const h = await bcrypt.hash(password, 12);
    const r = await getPool().query(
      `INSERT INTO ec_users (username,password_hash,nom,prenom,poste,role) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,username,nom,prenom,poste,role`,
      [username.toLowerCase(), h, nom, prenom, poste || 'Employe', role || 'employe']
    );
    res.json(r.rows[0]);
  } catch(e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Identifiant deja pris' });
    res.status(500).json({ error: e.message });
  }
});
app.put('/api/employes/:id', admin, async (req, res) => {
  try {
    const { nom, prenom, poste, role, actif } = req.body;
    await getPool().query('UPDATE ec_users SET nom=$1,prenom=$2,poste=$3,role=$4,actif=$5 WHERE id=$6',
      [nom, prenom, poste, role, actif !== undefined ? actif : true, req.params.id]);
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
    res.json((await getPool().query('SELECT * FROM ec_tarifs WHERE actif=true ORDER BY division,label')).rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/tarifs/:id', admin, async (req, res) => {
  try {
    const { prix, label, unite } = req.body;
    await getPool().query(
      'UPDATE ec_tarifs SET prix=$1, label=COALESCE($2,label), unite=COALESCE($3,unite), updated_at=NOW() WHERE id=$4',
      [prix, label || null, unite || null, req.params.id]
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

/* ═══ COMMANDES ÉVÉNEMENTS ═══ */

/* Tickets assignés à l'employé connecté (statut >= confirmé) */
app.get('/api/commandes/mes-tickets', auth, async (req, res) => {
  try {
    const statutsVisibles = ['confirme', 'paye', 'termine'];
    const r = await getPool().query(
      `SELECT c.id, c.client_nom, c.client_contact, c.division, c.type_prestation,
              c.description, c.date_evenement, c.lieu, c.statut, c.priorite,
              c.prestations_ids, c.budget_estime, c.prix_final
       FROM ec_commandes c
       WHERE c.assigned_to = $1 AND c.statut = ANY($2)
       ORDER BY c.date_evenement ASC NULLS LAST`,
      [req.session.user.id, statutsVisibles]
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/commandes', auth, async (req, res) => {
  try {
    const { statut, division } = req.query;
    let q = `SELECT c.*, u.nom as assigned_nom, u.prenom as assigned_prenom,
             cr.nom as createur_nom FROM ec_commandes c
             LEFT JOIN ec_users u ON c.assigned_to = u.id
             LEFT JOIN ec_users cr ON c.created_by = cr.id
             WHERE 1=1`;
    const params = [];
    if (statut) { params.push(statut); q += ` AND c.statut=$${params.length}`; }
    if (division) { params.push(division); q += ` AND c.division=$${params.length}`; }
    q += ' ORDER BY c.created_at DESC';
    res.json((await getPool().query(q, params)).rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/commandes', auth, async (req, res) => {
  try {
    const { client_nom, client_contact, division, type_prestation, prestations_ids, description, date_evenement, lieu, budget, budget_estime, priorite, note_interne } = req.body;
    if (!client_nom || !type_prestation) return res.status(400).json({ error: 'Champs manquants' });
    const r = await getPool().query(
      `INSERT INTO ec_commandes (client_nom,client_contact,division,type_prestation,prestations_ids,description,date_evenement,lieu,budget,budget_estime,priorite,note_interne,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [client_nom, client_contact||'', division||'securite', type_prestation, JSON.stringify(prestations_ids||[]), description||'', date_evenement||null, lieu||'', budget||'', budget_estime||0, priorite||'normale', note_interne||'', req.session.user.id]
    );
    res.json({ success: true, id: r.rows[0].id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/commandes/:id', auth, async (req, res) => {
  try {
    const { statut, note_interne, assigned_to, priorite, budget, budget_estime, lieu, date_evenement } = req.body;
    await getPool().query(
      `UPDATE ec_commandes SET statut=COALESCE($1,statut), note_interne=COALESCE($2,note_interne),
       assigned_to=COALESCE($3,assigned_to), priorite=COALESCE($4,priorite),
       budget=COALESCE($5,budget), budget_estime=COALESCE($6,budget_estime),
       lieu=COALESCE($7,lieu), date_evenement=COALESCE($8,date_evenement), updated_at=NOW() WHERE id=$9`,
      [statut||null, note_interne||null, assigned_to||null, priorite||null, budget||null, budget_estime||null, lieu||null, date_evenement||null, req.params.id]
    );
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/commandes/:id', admin, async (req, res) => {
  try { await getPool().query('DELETE FROM ec_commandes WHERE id=$1', [req.params.id]); res.json({ success: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

/* Passer une commande en "payé" et calculer le partage */
app.post('/api/commandes/:id/payer', admin, async (req, res) => {
  try {
    const { prix_final } = req.body;
    if (!prix_final || isNaN(prix_final) || Number(prix_final) <= 0) {
      return res.status(400).json({ error: 'Prix final invalide' });
    }
    // Récupérer la commande pour avoir la date de l'événement
    const cmdRes = await getPool().query('SELECT * FROM ec_commandes WHERE id=$1', [req.params.id]);
    const cmd = cmdRes.rows[0];
    if (!cmd) return res.status(404).json({ error: 'Commande introuvable' });

    // Trouver les employés présents sur la date de l'événement
    let partage = [];
    if (cmd.date_evenement) {
      const dateStr = new Date(cmd.date_evenement).toISOString().split('T')[0];
      const presRes = await getPool().query(
        `SELECT p.user_id, u.nom, u.prenom, u.poste FROM ec_presences p
         JOIN ec_users u ON p.user_id = u.id
         WHERE p.date = $1 AND p.statut = 'present' AND u.actif = true`,
        [dateStr]
      );
      const presents = presRes.rows;
      if (presents.length > 0) {
        const montantParPersonne = Math.round((Number(prix_final) / presents.length) * 100) / 100;
        partage = presents.map(p => ({
          user_id: p.user_id,
          nom: p.prenom + ' ' + p.nom,
          poste: p.poste,
          montant: montantParPersonne
        }));
      }
    }

    await getPool().query(
      `UPDATE ec_commandes SET statut='paye', prix_final=$1, paiement_partage=$2, updated_at=NOW() WHERE id=$3`,
      [Number(prix_final), JSON.stringify(partage), req.params.id]
    );
    res.json({ success: true, partage, prix_final: Number(prix_final) });
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
    const [a, b, c, d] = await Promise.all([
      getPool().query('SELECT COUNT(*) FROM ec_users WHERE actif=true'),
      getPool().query("SELECT COUNT(*) FROM ec_presences WHERE date=$1 AND statut='present'", [today]),
      getPool().query('SELECT COUNT(*) FROM ec_planning WHERE date_debut >= NOW()'),
      getPool().query('SELECT COUNT(*) FROM ec_annonces')
    ]);
    res.json({ employes: +a.rows[0].count, presents_aujourd_hui: +b.rows[0].count, evenements_a_venir: +c.rows[0].count, annonces: +d.rows[0].count });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

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
