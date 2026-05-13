// routes/auth.js — Inscription, connexion, refresh token, déconnexion
const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const { pool }  = require('../config/database');
const { safeLog } = require('../middleware/errorHandler');

const router = express.Router();

// ── Helpers JWT ───────────────────────────────────────────
function generateTokens(userId) {
  const accessToken = jwt.sign(
    { userId },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '15m' }
  );
  const refreshToken = jwt.sign(
    { userId, type: 'refresh' },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d' }
  );
  return { accessToken, refreshToken };
}

// ── POST /api/auth/register ───────────────────────────────
router.post('/register',
  [
    body('email').isEmail().normalizeEmail().withMessage('Email invalide'),
    body('password').isLength({ min: 8 }).withMessage('Mot de passe trop court (min. 8 caractères)'),
    body('company').trim().isLength({ min: 2, max: 100 }).withMessage('Nom d\'entreprise requis (2-100 caractères)'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: errors.array()[0].msg });
      }

      const { email, password, company } = req.body;

      // Vérifier si email déjà utilisé
      const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: 'Cet email est déjà utilisé' });
      }

      // Hacher le mot de passe
      const passwordHash = await bcrypt.hash(password, 12);
      const tenantId = uuidv4();

      // Créer l'utilisateur
      const { rows } = await pool.query(
        `INSERT INTO users (email, password_hash, company, tenant_id, role)
         VALUES ($1, $2, $3, $4, 'client')
         RETURNING id, email, company, tenant_id, role`,
        [email, passwordHash, company, tenantId]
      );

      const user = rows[0];
      const tokens = generateTokens(user.id);

      // Stocker le refresh token
      await pool.query(
        `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, NOW() + INTERVAL '7 days')`,
        [user.id, await bcrypt.hash(tokens.refreshToken, 8)]
      );

      safeLog('info', 'USER_REGISTERED', { userId: user.id, tenantId: user.tenant_id });

      res.status(201).json({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        user: {
          id:       user.id,
          email:    user.email,
          company:  user.company,
          tenantId: user.tenant_id,
          role:     user.role,
        }
      });
    } catch (err) { next(err); }
  }
);

// ── POST /api/auth/login ──────────────────────────────────
router.post('/login',
  [
    body('email').isEmail().normalizeEmail(),
    body('password').notEmpty(),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ error: 'Email ou mot de passe invalide' });
      }

      const { email, password } = req.body;

      const { rows } = await pool.query(
        'SELECT id, email, password_hash, company, tenant_id, role, is_active FROM users WHERE email = $1',
        [email]
      );

      if (rows.length === 0) {
        // Délai constant pour éviter le timing attack
        await bcrypt.hash('dummy', 12);
        return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
      }

      const user = rows[0];

      if (!user.is_active) {
        return res.status(403).json({ error: 'Compte désactivé. Contactez le support.' });
      }

      const validPassword = await bcrypt.compare(password, user.password_hash);
      if (!validPassword) {
        return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
      }

      const tokens = generateTokens(user.id);

      // Stocker le refresh token
      await pool.query(
        `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, NOW() + INTERVAL '7 days')`,
        [user.id, await bcrypt.hash(tokens.refreshToken, 8)]
      );

      // Mettre à jour last_login
      await pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

      safeLog('info', 'USER_LOGIN', { userId: user.id, tenantId: user.tenant_id });

      res.json({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        user: {
          id:       user.id,
          email:    user.email,
          company:  user.company,
          tenantId: user.tenant_id,
          role:     user.role,
        }
      });
    } catch (err) { next(err); }
  }
);

// ── POST /api/auth/refresh ────────────────────────────────
router.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(401).json({ error: 'Refresh token manquant' });

    const decoded = jwt.verify(refreshToken, process.env.JWT_SECRET);
    if (decoded.type !== 'refresh') return res.status(401).json({ error: 'Token invalide' });

    // Vérifier que le token est en base (non révoqué)
    const { rows } = await pool.query(
      `SELECT rt.id, u.id as user_id, u.tenant_id, u.role, u.is_active, rt.token_hash
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       WHERE rt.user_id = $1 AND rt.expires_at > NOW() AND rt.revoked = false`,
      [decoded.userId]
    );

    if (rows.length === 0) return res.status(401).json({ error: 'Session expirée' });

    // Vérifier le hash du token
    const valid = await Promise.any(
      rows.map(r => bcrypt.compare(refreshToken, r.token_hash))
    ).catch(() => false);

    if (!valid) return res.status(401).json({ error: 'Token révoqué' });
    if (!rows[0].is_active) return res.status(403).json({ error: 'Compte désactivé' });

    const tokens = generateTokens(decoded.userId);

    res.json({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Session invalide' });
    }
    next(err);
  }
});

// ── POST /api/auth/logout ─────────────────────────────────
router.post('/logout', async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) {
      // Révoquer tous les refresh tokens de cette session
      const decoded = jwt.decode(refreshToken);
      if (decoded?.userId) {
        await pool.query(
          'UPDATE refresh_tokens SET revoked = true WHERE user_id = $1',
          [decoded.userId]
        );
      }
    }
    safeLog('info', 'USER_LOGOUT', {});
    res.json({ message: 'Déconnexion réussie' });
  } catch (err) { next(err); }
});

module.exports = router;
