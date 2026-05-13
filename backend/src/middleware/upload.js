// middleware/upload.js — Multer avec validation sécurisée
const multer = require('multer');
const path   = require('path');
const fs     = require('fs');
const { v4: uuidv4 } = require('uuid');

const MAX_SIZE_BYTES = (parseInt(process.env.MAX_FILE_SIZE_MB) || 10) * 1024 * 1024;

const ALLOWED_MIME = new Set([
  'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/pdf',
  'text/plain',
]);

const ALLOWED_EXT = new Set(['.csv', '.xlsx', '.xls', '.pdf']);

// Stockage sur disque — un dossier par tenant
const storage = multer.diskStorage({
  destination(req, file, cb) {
    const tenantDir = path.join(
      process.env.UPLOAD_DIR || './uploads',
      req.user.tenant_id
    );
    // Créer le dossier tenant s'il n'existe pas
    if (!fs.existsSync(tenantDir)) {
      fs.mkdirSync(tenantDir, { recursive: true });
    }
    cb(null, tenantDir);
  },
  filename(req, file, cb) {
    // Nom opaque : uuid + extension originale (pas de nom original conservé)
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuidv4()}${ext}`);
  },
});

function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();

  if (!ALLOWED_EXT.has(ext)) {
    return cb(new Error(`Extension non autorisée : ${ext}. Acceptés : ${[...ALLOWED_EXT].join(', ')}`));
  }
  if (!ALLOWED_MIME.has(file.mimetype) && file.mimetype !== '') {
    return cb(new Error(`Type MIME non autorisé : ${file.mimetype}`));
  }
  cb(null, true);
}

const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: MAX_SIZE_BYTES,
    files:    1,      // Un fichier à la fois
    fields:   2,      // Champs de formulaire max
  },
});

// Wrapper pour gérer les erreurs multer proprement
function handleUpload(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({
          error: `Fichier trop volumineux. Maximum : ${process.env.MAX_FILE_SIZE_MB || 10} Mo`
        });
      }
      return res.status(400).json({ error: `Erreur upload : ${err.message}` });
    }
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'Aucun fichier reçu' });
    }
    next();
  });
}

module.exports = { handleUpload };
