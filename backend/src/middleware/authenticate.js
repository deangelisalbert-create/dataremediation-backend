// middleware/authenticate.js — Vérification JWT sur chaque requête protégée
const jwt = require('jsonwebtoken');
const { pool } = require('../config/database');

async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Token manquant ou mal formaté' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Vérifie que l'utilisateur existe encore en base
    const { rows } = await pool.query(
      'SELECT id, email, company, tenant_id, role, plan FROM users WHERE id = $1 AND is_active = true',
     [decoded.id]
    );

    if (rows.length === 0) {
      return res.status(401).json({ error: 'Utilisateur introuvable ou désactivé' });
    }

    req.user = rows[0];
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expiré', code: 'TOKEN_EXPIRED' });
    }
    if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Token invalide' });
    }
    next(err);
  }
}

// Vérification de rôle — usage : checkRole(['admin', 'client'])
function checkRole(allowedRoles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Non authentifié' });
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: `Accès refusé. Rôle requis : ${allowedRoles.join(' ou ')}`
      });
    }
    next();
  };
}

module.exports = { authenticate, checkRole };
