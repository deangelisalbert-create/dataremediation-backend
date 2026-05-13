// middleware/errorHandler.js — Gestion globale des erreurs + logs sans PII

// Patterns à masquer dans les logs (SIRET, TVA, emails, etc.)
const SENSITIVE_PATTERNS = [
  { pattern: /\b\d{14}\b/g,              replacement: '[SIRET]'   }, // SIRET 14 chiffres
  { pattern: /\bFR[A-Z0-9]{2}\d{9}\b/g, replacement: '[TVA]'     }, // TVA intracommunautaire FR
  { pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, replacement: '[EMAIL]' },
  { pattern: /\b\d{9}\b/g,              replacement: '[SIREN]'   }, // SIREN 9 chiffres
];

function sanitizeForLog(data) {
  if (typeof data !== 'string') data = JSON.stringify(data);
  let sanitized = data;
  for (const { pattern, replacement } of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement);
  }
  return sanitized;
}

function safeLog(level, action, meta = {}) {
  // Ne logger QUE des métadonnées non-sensibles
  const entry = {
    ts:     new Date().toISOString(),
    level,
    action,
    userId:   meta.userId   || undefined,
    tenantId: meta.tenantId || undefined,
    role:     meta.role     || undefined,
    // Métriques autorisées
    rowCount:  meta.rowCount  || undefined,
    fileSize:  meta.fileSize  || undefined,
    fileType:  meta.fileType  || undefined,
    statusCode: meta.statusCode || undefined,
    durationMs: meta.durationMs || undefined,
    // JAMAIS : noms, SIRET, TVA, emails, contenus de fichiers
  };
  // Supprimer les clés undefined
  Object.keys(entry).forEach(k => entry[k] === undefined && delete entry[k]);
  console.log(JSON.stringify(entry));
}

function errorHandler(err, req, res, next) {
  const statusCode = err.statusCode || err.status || 500;
  const isDev = process.env.NODE_ENV === 'development';

  safeLog('error', 'REQUEST_ERROR', {
    userId:     req.user?.id,
    tenantId:   req.user?.tenant_id,
    statusCode,
    // Sanitiser le message d'erreur avant de logguer
  });

  // En prod : message générique. En dev : message complet.
  const message = isDev
    ? err.message || 'Erreur interne'
    : statusCode >= 500
      ? 'Erreur interne du serveur'
      : err.message || 'Erreur';

  res.status(statusCode).json({ error: message });
}

module.exports = { errorHandler, sanitizeForLog, safeLog };
