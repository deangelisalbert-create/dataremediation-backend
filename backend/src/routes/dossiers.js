// routes/dossiers.js — Gestion des dossiers clients
const express = require('express');
const { authenticate } = require('../middleware/authenticate');
const { queryWithTenant, pool } = require('../config/database');

const router = express.Router();

// Quotas par plan
const PLANS = {
  'essentiel': { audits: 10,   fournisseurs: 50,   label: 'Essentiel', prix: 290 },
  'pro':       { audits: 30,   fournisseurs: 200,  label: 'Pro',       prix: 499 },
  'cabinet':   { audits: 9999, fournisseurs: 500,  label: 'Cabinet',   prix: 899 },
};

// ── GET /api/dossiers ─────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const result = await queryWithTenant(req.user.tenant_id,
      `SELECT
         cd.id, cd.nom, cd.siret, cd.contact, cd.email, cd.notes,
         cd.created_at, cd.updated_at,
         cd.abonnement_plan, cd.abonnement_status,
         cd.abonnement_quota_audits, cd.abonnement_audits_used,
         cd.abonnement_quota_fournisseurs, cd.abonnement_reset_at,
         COUNT(af.id)                                     AS nb_audits,
         MAX(af.uploaded_at)                              AS dernier_audit,
         (SELECT af2.taux_conformite
          FROM audit_files af2
          WHERE af2.dossier_id = cd.id AND af2.status = 'done'
          ORDER BY af2.uploaded_at DESC LIMIT 1)          AS dernier_score,
         (SELECT af3.id
          FROM audit_files af3
          WHERE af3.dossier_id = cd.id AND af3.status = 'done'
          ORDER BY af3.uploaded_at DESC LIMIT 1)          AS dernier_audit_id,
         (SELECT af4.original_name
          FROM audit_files af4
          WHERE af4.dossier_id = cd.id AND af4.status = 'done'
          ORDER BY af4.uploaded_at DESC LIMIT 1)          AS dernier_audit_nom
       FROM client_dossiers cd
       LEFT JOIN audit_files af ON af.dossier_id = cd.id
       WHERE cd.tenant_id = $1
       GROUP BY cd.id
       ORDER BY cd.updated_at DESC`,
      [req.user.tenant_id]
    );
    res.json({ dossiers: result.rows });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/dossiers ────────────────────────────────────
router.post('/', authenticate, async (req, res) => {
  try {
    const { nom, siret, contact, email, notes } = req.body;
    if (!nom || !nom.trim()) return res.status(400).json({ error: 'Le nom du dossier est requis.' });
    const result = await queryWithTenant(req.user.tenant_id,
      `INSERT INTO client_dossiers (tenant_id, nom, siret, contact, email, notes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.user.tenant_id, nom.trim(), siret||null, contact||null, email||null, notes||null]
    );
    res.status(201).json({ dossier: result.rows[0] });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/dossiers/:id ─────────────────────────────────
router.get('/:id', authenticate, async (req, res) => {
  try {
    const dossier = await queryWithTenant(req.user.tenant_id,
      `SELECT cd.*, COUNT(af.id) AS nb_audits
       FROM client_dossiers cd
       LEFT JOIN audit_files af ON af.dossier_id = cd.id
       WHERE cd.id = $1 AND cd.tenant_id = $2
       GROUP BY cd.id`,
      [req.params.id, req.user.tenant_id]
    );
    if (dossier.rows.length === 0) return res.status(404).json({ error: 'Dossier introuvable.' });

    const audits = await queryWithTenant(req.user.tenant_id,
      `SELECT id, original_name, status, taux_conformite, uploaded_at,
              completed_at, row_count, conformes, bloquants
       FROM audit_files
       WHERE dossier_id = $1
       ORDER BY uploaded_at DESC`,
      [req.params.id]
    );

    res.json({ dossier: { ...dossier.rows[0], audits: audits.rows } });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/dossiers/:id ─────────────────────────────────
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { nom, siret, contact, email, notes } = req.body;
    const result = await queryWithTenant(req.user.tenant_id,
      `UPDATE client_dossiers
       SET nom=$1, siret=$2, contact=$3, email=$4, notes=$5, updated_at=NOW()
       WHERE id=$6 AND tenant_id=$7 RETURNING *`,
      [nom, siret||null, contact||null, email||null, notes||null, req.params.id, req.user.tenant_id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Dossier introuvable.' });
    res.json({ dossier: result.rows[0] });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/dossiers/:id ──────────────────────────────
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const result = await queryWithTenant(req.user.tenant_id,
      `DELETE FROM client_dossiers WHERE id=$1 AND tenant_id=$2 RETURNING id`,
      [req.params.id, req.user.tenant_id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Dossier introuvable.' });
    res.json({ success: true });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/dossiers/:id/abonnement ─────────────────────
// Activer un abonnement sur un dossier (apres paiement Stripe)
router.post('/:id/abonnement', authenticate, async (req, res) => {
  try {
    const { plan, stripe_sub_id, stripe_customer_id } = req.body;

    // Verifier que le dossier a deja au moins 1 audit
    const auditCheck = await queryWithTenant(req.user.tenant_id,
      `SELECT COUNT(af.id) AS nb
       FROM audit_files af
       WHERE af.dossier_id = $1 AND af.status = 'done'`,
      [req.params.id]
    );

    const nbAudits = parseInt(auditCheck.rows[0]?.nb || 0);
    if (nbAudits === 0) {
      return res.status(403).json({
        error: 'Un audit doit etre realise avant de souscrire un abonnement pour ce dossier.',
        code: 'AUDIT_REQUIRED',
      });
    }

    const planInfo = PLANS[plan];
    if (!planInfo) return res.status(400).json({ error: 'Plan invalide.' });

    const result = await queryWithTenant(req.user.tenant_id,
      `UPDATE client_dossiers SET
         abonnement_plan = $1,
         abonnement_status = 'active',
         abonnement_quota_audits = $2,
         abonnement_quota_fournisseurs = $3,
         abonnement_audits_used = 0,
         abonnement_reset_at = NOW() + INTERVAL '1 month',
         stripe_sub_id = $4,
         stripe_customer_id = $5,
         updated_at = NOW()
       WHERE id = $6 AND tenant_id = $7
       RETURNING *`,
      [plan, planInfo.audits, planInfo.fournisseurs,
       stripe_sub_id||null, stripe_customer_id||null,
       req.params.id, req.user.tenant_id]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Dossier introuvable.' });
    res.json({ dossier: result.rows[0], message: `Abonnement ${planInfo.label} active.` });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/dossiers/:id/abonnement ──────────────────────
// Statut abonnement d'un dossier
router.get('/:id/abonnement', authenticate, async (req, res) => {
  try {
    const result = await queryWithTenant(req.user.tenant_id,
      `SELECT
         cd.abonnement_plan, cd.abonnement_status,
         cd.abonnement_quota_audits, cd.abonnement_audits_used,
         cd.abonnement_quota_fournisseurs, cd.abonnement_reset_at,
         COUNT(af.id) AS nb_audits_total,
         COUNT(af.id) FILTER (WHERE af.status = 'done') AS nb_audits_done
       FROM client_dossiers cd
       LEFT JOIN audit_files af ON af.dossier_id = cd.id
       WHERE cd.id = $1 AND cd.tenant_id = $2
       GROUP BY cd.id`,
      [req.params.id, req.user.tenant_id]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Dossier introuvable.' });

    const d = result.rows[0];
    const nbDone = parseInt(d.nb_audits_done || 0);

    res.json({
      plan: d.abonnement_plan,
      status: d.abonnement_status,
      actif: d.abonnement_status === 'active',
      quota_audits: d.abonnement_quota_audits,
      audits_used: d.abonnement_audits_used,
      audits_restants: Math.max(0, (d.abonnement_quota_audits||0) - (d.abonnement_audits_used||0)),
      quota_fournisseurs: d.abonnement_quota_fournisseurs,
      reset_at: d.abonnement_reset_at,
      // Eligibilite abonnement
      peut_s_abonner: nbDone > 0,
      nb_audits_done: nbDone,
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
