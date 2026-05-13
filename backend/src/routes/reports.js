// routes/reports.js — Téléchargement rapports avec liens temporaires
const express = require('express');
const jwt     = require('jsonwebtoken');
const { authenticate, checkRole } = require('../middleware/authenticate');
const { queryWithTenant, pool } = require('../config/database');
const { safeLog } = require('../middleware/errorHandler');

const router = express.Router();
const DOWNLOAD_TTL_MIN = parseInt(process.env.DOWNLOAD_LINK_TTL_MINUTES) || 15;

// ── POST /api/reports/:fileId/link — Génère un lien temporaire ──
router.post('/:fileId/link',
  authenticate,
  checkRole(['admin', 'client']),
  async (req, res, next) => {
    try {
      const { fileId } = req.params;
      const { type } = req.body; // 'csv' ou 'pdf'

      if (!['csv', 'pdf'].includes(type)) {
        return res.status(400).json({ error: 'Type invalide (csv ou pdf)' });
      }

      // Vérifier que le fichier appartient au tenant et est terminé
      const result = await queryWithTenant(req.user.tenant_id,
        `SELECT id, status FROM audit_files
         WHERE id = $1
           AND tenant_id = current_setting('app.tenant_id')::text
           AND status = 'done'`,
        [fileId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Rapport introuvable ou analyse non terminée' });
      }

      // Générer un token de téléchargement signé (TTL court)
      const downloadToken = jwt.sign(
        {
          fileId,
          tenantId: req.user.tenant_id,
          userId:   req.user.id,
          type,
          purpose:  'download',
        },
        process.env.JWT_SECRET,
        { expiresIn: `${DOWNLOAD_TTL_MIN}m` }
      );

      const downloadUrl = `/api/reports/download/${downloadToken}`;

      safeLog('info', 'DOWNLOAD_LINK_GENERATED', {
        userId: req.user.id, tenantId: req.user.tenant_id, type
      });

      res.json({
        downloadUrl,
        expiresAt: new Date(Date.now() + DOWNLOAD_TTL_MIN * 60000).toISOString(),
        ttlMinutes: DOWNLOAD_TTL_MIN,
      });
    } catch (err) { next(err); }
  }
);

// ── GET /api/reports/download/:token — Téléchargement via token ──
router.get('/download/:token', async (req, res, next) => {
  try {
    const { token } = req.params;

    // Vérifier le token de téléchargement
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'Lien de téléchargement invalide ou expiré' });
    }

    if (decoded.purpose !== 'download') {
      return res.status(401).json({ error: 'Token invalide' });
    }

    // Récupérer le rapport
    const result = await pool.query(
      `SELECT af.original_name, ar.csv_content, ar.pdf_content, ar.summary
       FROM audit_files af
       LEFT JOIN audit_reports ar ON ar.file_id = af.id
       WHERE af.id = $1 AND af.tenant_id = $2`,
      [decoded.fileId, decoded.tenantId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Rapport introuvable' });
    }

    const row = result.rows[0];
    const baseName = row.original_name.replace(/\.[^.]+$/, '');

    if (decoded.type === 'csv') {
      const csvContent = row.csv_content || 'Aucune donnée';
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="rapport_${baseName}.csv"`);
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      return res.send('\uFEFF' + csvContent); // BOM pour Excel FR
    }

    if (decoded.type === 'pdf') {
      // En production : générer un vrai PDF avec pdfkit
      // Ici : envoi du contenu texte comme fallback
      const content = row.pdf_content || row.csv_content || 'Rapport non disponible';
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="rapport_${baseName}.txt"`);
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      return res.send(content);
    }

    safeLog('info', 'FILE_DOWNLOADED', {
      userId: decoded.userId, tenantId: decoded.tenantId, type: decoded.type
    });

    res.status(400).json({ error: 'Type inconnu' });
  } catch (err) { next(err); }
});

module.exports = router;
