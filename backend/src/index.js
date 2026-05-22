// ═══════════════════════════════════════════════════════════
//  DataRemédiation — Backend Express
//  Point d'entrée principal
// ═══════════════════════════════════════════════════════════
require('dotenv').config();
const express    = require('express');
const helmet     = require('helmet');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const cron       = require('node-cron');
const path       = require('path');
const fs         = require('fs');

const authRoutes    = require('./routes/auth');
const auditRoutes   = require('./routes/audit');
const reportRoutes  = require('./routes/reports');
const webhookRoutes = require('./routes/webhook');
const { errorHandler } = require('./middleware/errorHandler');
const { cleanupExpiredFiles } = require('./services/cleanup');
const { testConnection } = require('./config/database');

const app  = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3001;

// ── Dossier uploads ──────────────────────────────────────
const uploadDir = process.env.UPLOAD_DIR || './uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// ── Sécurité HTTP ────────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

// ── CORS ─────────────────────────────────────────────────
app.use(cors({
  origin: function(origin, callback) {
    if (!origin || 
        origin.includes('vercel.app') || 
        origin.includes('localhost')) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant-ID']
}));

// ── ⚠️ WEBHOOK STRIPE — DOIT ÊTRE AVANT express.json() ──
// Stripe envoie un body brut (Buffer), pas du JSON
app.use('/webhook', express.raw({ type: 'application/json' }), webhookRoutes);

// ── Body parsers ─────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

// ── Rate limiting global ──────────────────────────────────
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX) || 500,
  message:  { error: 'Trop de requêtes. Réessayez dans 15 minutes.' },
  standardHeaders: true,
  legacyHeaders:   false,
});
app.use('/api/', limiter);

// ── Rate limiting renforcé sur auth ──────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Trop de tentatives de connexion.' }
});
app.use('/api/auth/', authLimiter);

// ── Routes ───────────────────────────────────────────────
app.use('/api/auth',    authRoutes);
app.use('/api/audit',   auditRoutes);
app.use('/api/reports', reportRoutes);

// ── Health check ─────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), env: process.env.NODE_ENV });
});

// ── 404 ──────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Route introuvable' });
});

// ── Error handler ────────────────────────────────────────
app.use(errorHandler);

// ── CRON : nettoyage fichiers expirés ────────────────────
cron.schedule('*/15 * * * *', async () => {
  try {
    const deleted = await cleanupExpiredFiles();
    if (deleted > 0) console.log(`[CRON] ${deleted} fichier(s) expiré(s) supprimé(s)`);
  } catch (e) {
    console.error('[CRON] Erreur nettoyage:', e.message);
  }
});

// ── Démarrage ────────────────────────────────────────────
async function start() {
  await testConnection();
  app.listen(PORT, () => {
    console.log(`\n⚡ DataRemédiation Backend démarré`);
    console.log(`   Port     : ${PORT}`);
    console.log(`   Env      : ${process.env.NODE_ENV}`);
    console.log(`   Frontend : ${process.env.FRONTEND_URL}`);
    console.log(`   CRON     : nettoyage toutes les 15 min\n`);
  });
}

start().catch(err => {
  console.error('Erreur démarrage:', err);
  process.exit(1);
});
