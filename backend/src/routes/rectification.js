const express = require('express');
const multer = require('multer');
const { runRectificationPipeline } = require('../modules/rectification');

const router = express.Router();

// Multer en mémoire — pas de disque
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max
  fileFilter: (req, file, cb) => {
    const allowed = [
      'text/csv',
      'application/csv',
      'application/json',
      'application/xml',
      'text/xml',
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Format non supporté. Utilisez CSV, JSON ou XML.'));
    }
  },
});

/**
 * POST /api/rectification/analyser
 * Lance le pipeline complet sur un fichier uploadé
 */
router.post('/analyser', upload.single('fichier'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Aucun fichier fourni.' });
    }

    const { buffer, mimetype, originalname } = req.file;

    const result = await runRectificationPipeline(buffer, mimetype, originalname);

    return res.status(200).json({
      success: true,
      rapport: result.rapport,
      donnees_corrigees: result.donnees_corrigees,
    });
  } catch (err) {
    console.error('[Route rectification]', err);
    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

/**
 * GET /api/rectification/ping
 * Vérifie que le module est opérationnel
 */
router.get('/ping', (req, res) => {
  res.json({ status: 'ok', module: 'rectification' });
});

module.exports = router;
