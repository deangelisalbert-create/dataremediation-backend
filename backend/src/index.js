require('dotenv').config();
const express    = require('express');
const helmet     = require('helmet');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const cron       = require('node-cron');
const fs         = require('fs');

const authRoutes          = require('./routes/auth');
const auditRoutes         = require('./routes/audit');
const reportRoutes        = require('./routes/reports');
const webhookRoutes       = require('./routes/webhook');
const rectificationRoutes = require('./routes/rectification');
const dossiersRoutes      = require('./routes/dossiers');
const abonnementRoutes    = require('./routes/abonnement');
const { errorHandler }    = require('./middleware/errorHandler');
const { cleanupExpiredFiles } = require('./services/cleanup');
const { testConnection, pool } = require('./config/database');

const app  = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3001;

const uploadDir = process.env.UPLOAD_DIR || './uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// ── Securite HTTP ─────────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

// ── CORS ──────────────────────────────────────────────────
app.use(cors({
  origin: function(origin, callback) {
    if (!origin ||
        origin.includes('vercel.app') ||
        origin.includes('dataremediation.fr') ||
        origin.includes('localhost')) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant-ID', 'X-Nb-Fournisseurs']
}));

// ── Webhook Stripe — DOIT ETRE AVANT express.json() ──────
app.use('/webhook', express.raw({ type: 'application/json' }), webhookRoutes);
app.use('/api/abonnement/webhook', express.raw({ type: 'application/json' }), (req, res, next) => {
  req.rawBody = req.body;
  next();
});

// ── Body parsers ──────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

// ── Rate limiting ─────────────────────────────────────────
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max:      parseInt(process.env.RATE_LIMIT_MAX) || 500,
  message:  { error: 'Trop de requetes. Reessayez dans 15 minutes.' },
  standardHeaders: true,
  legacyHeaders:   false,
});
app.use('/api/', limiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Trop de tentatives de connexion.' }
});
app.use('/api/auth/', authLimiter);

// ── Routes ────────────────────────────────────────────────
app.use('/api/auth',          authRoutes);
app.use('/api/audit',         auditRoutes);
app.use('/api/reports',       reportRoutes);
app.use('/api/rectification', rectificationRoutes);
app.use('/api/dossiers',      dossiersRoutes);
app.use('/api/abonnement',    abonnementRoutes);

// ── Health check ──────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), env: process.env.NODE_ENV });
});

app.use((req, res) => res.status(404).json({ error: 'Route introuvable' }));
app.use(errorHandler);

// ── CRON : nettoyage fichiers expires (toutes les 15 min) ─
cron.schedule('*/15 * * * *', async () => {
  try {
    const deleted = await cleanupExpiredFiles();
    if (deleted > 0) console.log(`[CRON] ${deleted} fichier(s) expire(s) supprime(s)`);
  } catch(e) {
    console.error('[CRON] Erreur nettoyage:', e.message);
  }
});

// ── CRON : reset quota abonnement (tous les jours a minuit) 
cron.schedule('0 0 * * *', async () => {
  try {
    await pool.query('SELECT reset_quota_mensuel()');
    console.log('[CRON] Reset quota mensuel execute');
  } catch(e) {
    console.error('[CRON] Erreur reset quota:', e.message);
  }
});

// ── Demarrage ─────────────────────────────────────────────
async function start() {
  await testConnection();
  app.listen(PORT, () => {
    console.log(`\nDataRemediation Backend demarre`);
    console.log(`   Port     : ${PORT}`);
    console.log(`   Env      : ${process.env.NODE_ENV}`);
    console.log(`   Frontend : ${process.env.FRONTEND_URL}`);
    console.log(`   Routes   : auth, audit, reports, rectification, dossiers, abonnement\n`);
  });
}

start().catch(err => {
  console.error('Erreur demarrage:', err);
  process.exit(1);
});
