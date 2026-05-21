// routes/auth.js
const express   = require('express');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { pool }  = require('../config/database');
const { safeLog } = require('../middleware/errorHandler');
// v2
const router = express.Router();

const JWT_SECRET          = process.env.JWT_SECRET          || 'secret';
const JWT_EXPIRES_IN      = process.env.JWT_EXPIRES_IN      || '15m';
const JWT_REFRESH_EXPIRES = process.env.JWT_REFRESH_EXPIRES_IN || '7d';
const FRONTEND_URL        = process.env.FRONTEND_URL        || 'http://localhost:5173';
const RESEND_API_KEY      = process.env.RESEND_API_KEY;

// ── Helpers ───────────────────────────────────────────────
function generateTokens(user) {
  const payload = {
    id:        user.id,
    email:     user.email,
    company:   user.company,
    tenant_id: user.tenant_id,
    role:      user.role,
  };
  const accessToken  = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
  const refreshToken = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: JWT_REFRESH_EXPIRES });
  return { accessToken, refreshToken };
}

async function sendEmail(to, subject, html) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
    from: 'DataRemédiation <noreply@dataremediation.fr>',
      to,
      subject,
      html,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Email error: ${err}`);
  }
  return res.json();
}

// ── POST /api/auth/register ───────────────────────────────
router.post('/register', async (req, res, next) => {
  try {
    const { company, email, password } = req.body;
    if (!company || !email || !password)
      return res.status(400).json({ error: 'Champs requis manquants' });
    if (password.length < 8)
      return res.status(400).json({ error: 'Mot de passe trop court (8 caractères min)' });

    const exists = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (exists.rows.length > 0)
      return res.status(409).json({ error: 'Cet email est déjà utilisé' });

    const hash      = await bcrypt.hash(password, 12);
    const tenantId  = uuidv4();
    const userId    = uuidv4();

    const result = await pool.query(
      `INSERT INTO users (id, email, password_hash, company, tenant_id, role)
       VALUES ($1, $2, $3, $4, $5, 'client') RETURNING id, email, company, tenant_id, role`,
      [userId, email.toLowerCase(), hash, company, tenantId]
    );

    const user = result.rows[0];
    const { accessToken, refreshToken } = generateTokens(user);

    await pool.query(
      `INSERT INTO refresh_tokens (user_id, token, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '7 days')`,
      [user.id, refreshToken]
    );

    safeLog('info', 'USER_REGISTERED', { userId: user.id, tenantId: user.tenant_id });
    res.status(201).json({ user, accessToken, refreshToken });
  } catch (err) { next(err); }
});

// ── POST /api/auth/login ──────────────────────────────────
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Email et mot de passe requis' });

    const result = await pool.query(
      'SELECT * FROM users WHERE email = $1 AND is_active = true',
      [email.toLowerCase()]
    );
    if (result.rows.length === 0)
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid)
      return res.status(401).json({ error: 'Email ou mot de passe incorrect' });

    const { accessToken, refreshToken } = generateTokens(user);

    await pool.query(
      `INSERT INTO refresh_tokens (user_id, token, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '7 days')`,
      [user.id, refreshToken]
    );

    await pool.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

    safeLog('info', 'USER_LOGIN', { userId: user.id, tenantId: user.tenant_id });
    res.json({
      user: { id: user.id, email: user.email, company: user.company, tenant_id: user.tenant_id, role: user.role },
      accessToken, refreshToken,
    });
  } catch (err) { next(err); }
});

// ── POST /api/auth/refresh ────────────────────────────────
router.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken)
      return res.status(401).json({ error: 'Refresh token manquant' });

    const decoded = jwt.verify(refreshToken, JWT_SECRET);
    const tokenResult = await pool.query(
      'SELECT * FROM refresh_tokens WHERE token = $1 AND expires_at > NOW()',
      [refreshToken]
    );
    if (tokenResult.rows.length === 0)
      return res.status(401).json({ error: 'Token invalide ou expiré' });

    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [decoded.id]);
    if (userResult.rows.length === 0)
      return res.status(401).json({ error: 'Utilisateur introuvable' });

    const user = userResult.rows[0];
    const { accessToken, refreshToken: newRefresh } = generateTokens(user);

    await pool.query('DELETE FROM refresh_tokens WHERE token = $1', [refreshToken]);
    await pool.query(
      `INSERT INTO refresh_tokens (user_id, token, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '7 days')`,
      [user.id, newRefresh]
    );

    res.json({ accessToken, refreshToken: newRefresh });
  } catch (err) {
    if (err.name === 'JsonWebTokenError') return res.status(401).json({ error: 'Token invalide' });
    next(err);
  }
});

// ── POST /api/auth/logout ─────────────────────────────────
router.post('/logout', async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) {
      await pool.query('DELETE FROM refresh_tokens WHERE token = $1', [refreshToken]);
    }
    res.json({ message: 'Déconnecté' });
  } catch (err) { next(err); }
});

// ── POST /api/auth/forgot-password ───────────────────────
router.post('/forgot-password', async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email requis' });

    const result = await pool.query(
      'SELECT id, email, company FROM users WHERE email = $1 AND is_active = true',
      [email.toLowerCase()]
    );

    // Toujours répondre OK pour ne pas révéler si l'email existe
    if (result.rows.length === 0) {
      return res.json({ message: 'Si cet email existe, un lien vous a été envoyé.' });
    }

    const user = result.rows[0];
    const resetToken = uuidv4();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 heure

    // Stocker le token de reset
    await pool.query(
      `UPDATE users SET reset_token = $1, reset_token_expires = $2 WHERE id = $3`,
      [resetToken, expiresAt, user.id]
    );

    const resetUrl = `${FRONTEND_URL}/reset-password?token=${resetToken}`;

    await sendEmail(
      user.email,
      'Réinitialisation de votre mot de passe — DataRemédiation',
      `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#06080f;color:#c8d4ee;padding:40px;border-radius:10px;">
        <div style="text-align:center;margin-bottom:32px;">
          <div style="font-size:32px;margin-bottom:8px;">⚡</div>
          <h1 style="color:#00e5a0;font-size:24px;margin:0;">DataRemédiation</h1>
        </div>
        <h2 style="color:#c8d4ee;">Réinitialisation de mot de passe</h2>
        <p>Bonjour <strong>${user.company}</strong>,</p>
        <p>Vous avez demandé la réinitialisation de votre mot de passe. Cliquez sur le bouton ci-dessous :</p>
        <div style="text-align:center;margin:32px 0;">
          <a href="${resetUrl}" style="background:#00e5a0;color:#000;padding:14px 32px;border-radius:6px;text-decoration:none;font-weight:bold;font-size:14px;">
            → Réinitialiser mon mot de passe
          </a>
        </div>
        <p style="color:#4a5878;font-size:12px;">Ce lien expire dans <strong>1 heure</strong>. Si vous n'avez pas fait cette demande, ignorez cet email.</p>
        <p style="color:#4a5878;font-size:12px;">Lien : <a href="${resetUrl}" style="color:#3d8eff;">${resetUrl}</a></p>
      </div>
      `
    );

    safeLog('info', 'PASSWORD_RESET_REQUESTED', { userId: user.id });
    res.json({ message: 'Si cet email existe, un lien vous a été envoyé.' });
  } catch (err) { next(err); }
});

// ── POST /api/auth/reset-password ────────────────────────
router.post('/reset-password', async (req, res, next) => {
  try {
    const { token, password } = req.body;
    if (!token || !password)
      return res.status(400).json({ error: 'Token et mot de passe requis' });
    if (password.length < 8)
      return res.status(400).json({ error: 'Mot de passe trop court (8 caractères min)' });

    const result = await pool.query(
      `SELECT id FROM users
       WHERE reset_token = $1 AND reset_token_expires > NOW() AND is_active = true`,
      [token]
    );

    if (result.rows.length === 0)
      return res.status(400).json({ error: 'Lien invalide ou expiré' });

    const hash = await bcrypt.hash(password, 12);

    await pool.query(
      `UPDATE users SET password_hash = $1, reset_token = NULL, reset_token_expires = NULL
       WHERE id = $2`,
      [hash, result.rows[0].id]
    );

    safeLog('info', 'PASSWORD_RESET_DONE', { userId: result.rows[0].id });
    res.json({ message: 'Mot de passe réinitialisé avec succès' });
  } catch (err) { next(err); }
});

module.exports = router;
