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

// ── Emails admin — bypass paiement ───────────────────────────────────────────
const ADMIN_EMAILS = [
  'deangelis.albert@gmail.com',
];

// ── GET /api/audit/files — Liste des fichiers du tenant ──────────────────────
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

// ── GET /api/audit/credits — Solde crédits et abonnement ─────────────────────
router.get('/credits', async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT credits, abonnement, abonnement_quota,
              abonnement_fournisseurs_restants, abonnement_reset_date
       FROM users WHERE id = $1`,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.json({ credits: 0, abonnement: null });
    }

    const u = result.rows[0];

    // Vérifier si le quota mensuel doit être remis à zéro
    if (u.abonnement && u.abonnement_reset_date) {
      const resetDate = new Date(u.abonnement_reset_date);
      if (new Date() >= resetDate) {
        await pool.query(
          `UPDATE users
           SET abonnement_fournisseurs_restants = abonnement_quota,
               abonnement_reset_date = $2
           WHERE id = $1`,
          [req.user.id, new Date(resetDate.setMonth(resetDate.getMonth()+1)).toISOString().split('T')[0]]
        );
        u.abonnement_fournisseurs_restants = u.abonnement_quota;
      }
    }

    res.json({
      credits:                        u.credits || 0,
      abonnement:                     u.abonnement || null,
      abonnement_quota:               u.abonnement_quota || 0,
      abonnement_fournisseurs_restants: u.abonnement_fournisseurs_restants || 0,
      abonnement_reset_date:          u.abonnement_reset_date || null,
    });
  } catch (err) { next(err); }
});

// ── POST /api/audit/upload — Upload + lancement analyse ──────────────────────
router.post('/upload',
  checkRole(['admin', 'client']),
  handleUpload,
  async (req, res, next) => {
    const file = req.file;

    try {
      const isAdmin = ADMIN_EMAILS.includes(req.user.email);

      // ── Vérification crédits (sauf admin) ──────────────
      if (!isAdmin) {
        const userResult = await pool.query(
          `SELECT credits, abonnement, abonnement_fournisseurs_restants, abonnement_reset_date
           FROM users WHERE id = $1`,
          [req.user.id]
        );

        if (userResult.rows.length === 0) {
          if (file?.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
          return res.status(403).json({ error: 'Utilisateur introuvable' });
        }

        const u = userResult.rows[0];

        // Nombre de fournisseurs dans le fichier (depuis le header X-Nb-Fournisseurs)
        const nbFournisseurs = parseInt(req.headers['x-nb-fournisseurs'] || '0');

        // Vérifier si le quota mensuel doit être remis à zéro
        if (u.abonnement && u.abonnement_reset_date) {
          const resetDate = new Date(u.abonnement_reset_date);
          if (new Date() >= resetDate) {
            await pool.query(
              `UPDATE users
               SET abonnement_fournisseurs_restants = abonnement_quota,
                   abonnement_reset_date = $2
               WHERE id = $1`,
              [req.user.id, new Date(resetDate.setMonth(resetDate.getMonth()+1)).toISOString().split('T')[0]]
            );
            u.abonnement_fournisseurs_restants = u.abonnement_quota || 0;
          }
        }

        // ── Cas 1 : Abonnement actif ──────────────────────
        if (u.abonnement) {
          const restants = u.abonnement_fournisseurs_restants || 0;
          if (nbFournisseurs > 0 && restants < nbFournisseurs) {
            if (file?.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
            return res.status(403).json({
              error: `Quota insuffisant. Il vous reste ${restants} fournisseurs ce mois-ci sur votre abonnement ${u.abonnement}.`,
              restants,
              demandes: nbFournisseurs,
            });
          }

          // Décrémenter le quota
          if (nbFournisseurs > 0) {
            await pool.query(
              `UPDATE users
               SET abonnement_fournisseurs_restants = abonnement_fournisseurs_restants - $2
               WHERE id = $1`,
              [req.user.id, nbFournisseurs]
            );
          }

        // ── Cas 2 : Audit à l'acte (crédits) ─────────────
        } else if (u.credits > 0) {
          // Consommer 1 crédit
          await pool.query(
            `UPDATE users SET credits = credits - 1 WHERE id = $1`,
            [req.user.id]
          );

        // ── Cas 3 : Aucun crédit ni abonnement ───────────
        } else {
          if (file?.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
          return res.status(403).json({
            error: 'Aucun crédit disponible. Veuillez effectuer un paiement pour accéder à l\'analyse.',
            credits: 0,
            abonnement: null,
          });
        }
      }

      // ── Enregistrement en base ────────────────────────────
      const ttlHours = parseInt(process.env.FILE_TTL_HOURS) || 48;
      const fileId   = uuidv4();

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

      // Lancer l'analyse en arrière-plan
      setImmediate(() => {
        runAuditAnalysis(fileId, req.user).catch(err => {
          console.error(`[AUDIT] Erreur analyse ${fileId}:`, err.message);
        });
      });

      res.status(201).json({
        fileId,
        status:    'importing',
        message:   'Fichier reçu. Analyse en cours...',
        expiresAt: new Date(Date.now() + ttlHours * 3600000).toISOString(),
      });

    } catch (err) {
      if (file?.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
      next(err);
    }
  }
);

// ── GET /api/audit/status/:fileId — Statut d'un fichier ──────────────────────
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

// ── DELETE /api/audit/files/:fileId — Suppression manuelle ───────────────────
router.delete('/files/:fileId',
  checkRole(['admin', 'client']),
  async (req, res, next) => {
    try {
      const { fileId } = req.params;

      const result = await queryWithTenant(req.user.tenant_id,
        `SELECT file_path FROM audit_files
         WHERE id = $1 AND tenant_id = current_setting('app.tenant_id')::text`,
        [fileId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Fichier introuvable' });
      }

      const { file_path } = result.rows[0];

      if (file_path && fs.existsSync(file_path)) {
        fs.unlinkSync(file_path);
      }

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
