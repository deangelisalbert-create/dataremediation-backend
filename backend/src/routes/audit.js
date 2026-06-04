// routes/audit.js — Upload fichier + lancement analyse + statut
const express = require('express');
const fs      = require('fs');
const { v4: uuidv4 } = require('uuid');
const { authenticate, checkRole } = require('../middleware/authenticate');
const { handleUpload } = require('../middleware/upload');
const { queryWithTenant, pool } = require('../config/database');
const { safeLog } = require('../middleware/errorHandler');
const { runAuditAnalysis } = require('../services/auditService');

const router = express.Router();
router.use(authenticate);

const ADMIN_EMAILS = ['deangelis.albert@gmail.com'];

// Quota fournisseurs par plan (audits illimites)
const PLAN_QUOTAS = {
  'essentiel': { fournisseurs: 50,  label: 'Essentiel' },
  'pro':       { fournisseurs: 200, label: 'Pro' },
  'cabinet':   { fournisseurs: 500, label: 'Cabinet' },
};

// ── GET /api/audit/files ──────────────────────────────────
router.get('/files', async (req, res, next) => {
  try {
    const result = await queryWithTenant(req.user.tenant_id,
      `SELECT af.id, af.original_name, af.file_size, af.mime_type, af.status,
              af.uploaded_at, af.completed_at, af.expires_at,
              af.error_message, af.row_count, af.conformes, af.bloquants, af.taux_conformite,
              af.dossier_id, ar.summary
       FROM audit_files af
       LEFT JOIN audit_reports ar ON ar.file_id = af.id
       WHERE af.tenant_id = current_setting('app.tenant_id')::text
       ORDER BY af.uploaded_at DESC
       LIMIT 50`,
    );
    res.json({ files: result.rows });
  } catch(err) { next(err); }
});

// ── GET /api/audit/credits ────────────────────────────────
router.get('/credits', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT credits, abonnement_plan, abonnement_status,
              abonnement_quota_fournisseurs, abonnement_reset_at
       FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (result.rows.length === 0) return res.json({ credits: 0, abonnement: null });
    const u = result.rows[0];

    res.json({
      credits:                      u.credits || 0,
      abonnement:                   u.abonnement_plan || null,
      abonnement_status:            u.abonnement_status || 'inactive',
      abonnement_quota_fournisseurs: u.abonnement_quota_fournisseurs || 0,
      abonnement_reset_date:        u.abonnement_reset_at || null,
    });
  } catch(err) { next(err); }
});

// ── POST /api/audit/upload ────────────────────────────────
router.post('/upload',
  checkRole(['admin', 'client']),
  handleUpload,
  async (req, res, next) => {
    const file = req.file;
    try {
      const isAdmin = ADMIN_EMAILS.includes(req.user.email);

      if (!isAdmin) {
        const nbFournisseurs = parseInt(req.headers['x-nb-fournisseurs'] || '0');
        const dossierId      = req.body.dossier_id || req.headers['x-dossier-id'] || null;

        // Si un dossier est specifie, verifier le quota abonnement du dossier
        if (dossierId) {
          const dossierResult = await pool.query(
            `SELECT abonnement_plan, abonnement_status, abonnement_quota_fournisseurs
             FROM client_dossiers WHERE id = $1`,
            [dossierId]
          );

          if (dossierResult.rows.length > 0) {
            const d = dossierResult.rows[0];
            if (d.abonnement_status === 'active' && d.abonnement_quota_fournisseurs > 0) {
              if (nbFournisseurs > 0 && nbFournisseurs > d.abonnement_quota_fournisseurs) {
                if (file?.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
                return res.status(403).json({
                  error: `Ce fichier contient ${nbFournisseurs} fournisseurs, mais votre abonnement ${d.abonnement_plan} est limite a ${d.abonnement_quota_fournisseurs} fournisseurs par audit.`,
                  quota_fournisseurs: d.abonnement_quota_fournisseurs,
                  demandes: nbFournisseurs,
                });
              }
            }
          }
        }

        // Verifier credits utilisateur si pas d'abonnement sur le dossier
        const userResult = await pool.query(
          `SELECT credits, abonnement_plan, abonnement_status, abonnement_quota_fournisseurs
           FROM users WHERE id = $1`,
          [req.user.id]
        );

        if (userResult.rows.length === 0) {
          if (file?.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
          return res.status(403).json({ error: 'Utilisateur introuvable' });
        }

        const u = userResult.rows[0];
        const isActive = u.abonnement_status === 'active';

        // Abonnement actif sur le compte utilisateur
        if (isActive && u.abonnement_plan) {
          const quotaFourn = u.abonnement_quota_fournisseurs || 0;
          if (nbFournisseurs > 0 && quotaFourn > 0 && nbFournisseurs > quotaFourn) {
            if (file?.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
            return res.status(403).json({
              error: `Ce fichier contient ${nbFournisseurs} fournisseurs, mais votre formule est limitee a ${quotaFourn} fournisseurs par audit.`,
              quota_fournisseurs: quotaFourn,
              demandes: nbFournisseurs,
            });
          }
        // Credits a l'acte
        } else if (u.credits > 0) {
          await pool.query(`UPDATE users SET credits = credits - 1 WHERE id = $1`, [req.user.id]);
        // Aucun acces
        } else {
          if (file?.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
          return res.status(403).json({
            error: 'Aucun abonnement actif. Souscrivez a une formule pour lancer des audits.',
          });
        }
      }

      // Enregistrement en base
      const ttlHours  = parseInt(process.env.FILE_TTL_HOURS) || 48;
      const fileId    = uuidv4();
      const dossierId = req.body.dossier_id || req.headers['x-dossier-id'] || null;

      await queryWithTenant(req.user.tenant_id,
        `INSERT INTO audit_files
           (id, tenant_id, user_id, original_name, stored_name,
            file_path, file_size, mime_type, status, expires_at, dossier_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'importing', NOW() + INTERVAL '${ttlHours} hours', $9)`,
        [fileId, req.user.tenant_id, req.user.id,
         file.originalname, file.filename,
         file.path, file.size, file.mimetype, dossierId]
      );

      safeLog('info', 'FILE_UPLOADED', { userId:req.user.id, tenantId:req.user.tenant_id, fileSize:file.size });

      setImmediate(() => {
        runAuditAnalysis(fileId, req.user).catch(err => {
          console.error(`[AUDIT] Erreur analyse ${fileId}:`, err.message);
        });
      });

      res.status(201).json({
        fileId,
        status:    'importing',
        message:   'Fichier recu. Analyse en cours...',
        expiresAt: new Date(Date.now() + ttlHours * 3600000).toISOString(),
      });

    } catch(err) {
      if (file?.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
      next(err);
    }
  }
);

// ── GET /api/audit/status/:fileId ─────────────────────────
router.get('/status/:fileId', async (req, res, next) => {
  try {
    const result = await queryWithTenant(req.user.tenant_id,
      `SELECT id, original_name, status, uploaded_at, completed_at,
              expires_at, error_message, row_count,
              conformes, a_corriger, bloquants, taux_conformite, dossier_id
       FROM audit_files
       WHERE id = $1 AND tenant_id = current_setting('app.tenant_id')::text`,
      [req.params.fileId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Fichier introuvable' });
    res.json(result.rows[0]);
  } catch(err) { next(err); }
});

// ── DELETE /api/audit/files/:fileId ──────────────────────
router.delete('/files/:fileId', checkRole(['admin','client']), async (req, res, next) => {
  try {
    const result = await queryWithTenant(req.user.tenant_id,
      `SELECT file_path FROM audit_files
       WHERE id = $1 AND tenant_id = current_setting('app.tenant_id')::text`,
      [req.params.fileId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Fichier introuvable' });

    const { file_path } = result.rows[0];
    if (file_path && fs.existsSync(file_path)) fs.unlinkSync(file_path);

    await queryWithTenant(req.user.tenant_id,
      `DELETE FROM audit_files WHERE id = $1 AND tenant_id = current_setting('app.tenant_id')::text`,
      [req.params.fileId]
    );

    safeLog('info', 'FILE_DELETED_MANUAL', { userId:req.user.id, tenantId:req.user.tenant_id });
    res.json({ message: 'Fichier supprime' });
  } catch(err) { next(err); }
});

module.exports = router;
