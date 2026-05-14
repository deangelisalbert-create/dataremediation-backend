// routes/audit.js — Upload fichier + lancement analyse + statut
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const { v4: uuidv4 } = require('uuid');
const { authenticate, checkRole } = require('../middleware/authenticate');
const { handleUpload } = require('../middleware/upload');
const { queryWithTenant, pool } = require('../config/database');
const { safeLog } = require('../middleware/errorHandler');
const { runAuditAnalysis } = require('../services/auditService');

const router = express.Router();

// Toutes les routes nécessitent une authentification
router.use(authenticate);

// ── GET /api/audit/files — Liste des fichiers du tenant ──
router.get('/files', async (req, res, next) => {
  try {
    const result = await queryWithTenant(req.user.tenant_id,
  `SELECT af.id, af.original_name, af.file_size, af.mime_type, af.status,
          af.uploaded_at, af.completed_at, af.expires_at,
          af.error_message, af.row_count, af.conformes, af.bloquants, af.taux_conformite,
          ar.summary
   FROM audit_files af
   LEFT JOIN audit_reports ar ON ar.file_id = af.id
   WHERE af.tenant_id = current_setting('app.tenant_id')::text
   ORDER BY af.uploaded_at DESC
   LIMIT 50`,
);
    

    safeLog('info', 'FILES_LISTED', {
      userId: req.user.id, tenantId: req.user.tenant_id,
      count: result.rows.length
    });

    res.json({ files: result.rows });
  } catch (err) { next(err); }
});

// ── POST /api/audit/upload — Upload + lancement analyse ──
router.post('/upload',
  checkRole(['admin', 'client']),
  handleUpload,
  async (req, res, next) => {
    const file = req.file;

    try {
      const ttlHours = parseInt(process.env.FILE_TTL_HOURS) || 48;
      const fileId   = uuidv4();

      // Enregistrer en base
      await queryWithTenant(req.user.tenant_id,
        `INSERT INTO audit_files
           (id, tenant_id, user_id, original_name, stored_name,
            file_path, file_size, mime_type, status, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'importing', NOW() + INTERVAL '${ttlHours} hours')`,
        [
          fileId, req.user.tenant_id, req.user.id,
          file.originalname, file.filename,
          file.path, file.size, file.mimetype,
        ]
      );

      safeLog('info', 'FILE_UPLOADED', {
        userId: req.user.id, tenantId: req.user.tenant_id,
        fileSize: file.size, fileType: file.mimetype
      });

      // Lancer l'analyse en arrière-plan (ne pas attendre)
      setImmediate(() => {
        runAuditAnalysis(fileId, req.user).catch(err => {
          console.error(`[AUDIT] Erreur analyse ${fileId}:`, err.message);
        });
      });

      // Répondre immédiatement avec le statut "importing"
      res.status(201).json({
        fileId,
        status:     'importing',
        message:    'Fichier reçu. Analyse en cours...',
        expiresAt:  new Date(Date.now() + ttlHours * 3600000).toISOString(),
      });
    } catch (err) {
      // En cas d'erreur, supprimer le fichier physique
      if (file?.path && fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
      }
      next(err);
    }
  }
);

// ── GET /api/audit/status/:fileId — Statut d'un fichier ──
router.get('/status/:fileId', async (req, res, next) => {
  try {
    const { fileId } = req.params;

    const result = await queryWithTenant(req.user.tenant_id,
      `SELECT id, original_name, status, uploaded_at, completed_at,
              expires_at, error_message, row_count,
              conformes, a_corriger, bloquants, taux_conformite
       FROM audit_files
       WHERE id = $1 AND tenant_id = current_setting('app.tenant_id')::text`,
      [fileId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Fichier introuvable' });
    }

    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

// ── DELETE /api/audit/files/:fileId — Suppression manuelle ──
router.delete('/files/:fileId',
  checkRole(['admin', 'client']),
  async (req, res, next) => {
    try {
      const { fileId } = req.params;

      // Récupérer le chemin physique
      const result = await queryWithTenant(req.user.tenant_id,
        `SELECT file_path FROM audit_files
         WHERE id = $1 AND tenant_id = current_setting('app.tenant_id')::text`,
        [fileId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Fichier introuvable' });
      }

      const { file_path } = result.rows[0];

      // Supprimer fichier physique
      if (file_path && fs.existsSync(file_path)) {
        fs.unlinkSync(file_path);
      }

      // Supprimer en base (cascade sur les rapports)
      await queryWithTenant(req.user.tenant_id,
        `DELETE FROM audit_files
         WHERE id = $1 AND tenant_id = current_setting('app.tenant_id')::text`,
        [fileId]
      );

      safeLog('info', 'FILE_DELETED_MANUAL', {
        userId: req.user.id, tenantId: req.user.tenant_id
      });

      res.json({ message: 'Fichier supprimé' });
    } catch (err) { next(err); }
  }
);

module.exports = router;
