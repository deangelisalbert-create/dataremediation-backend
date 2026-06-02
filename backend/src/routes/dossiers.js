// routes/dossiers.js — Gestion des dossiers clients
const express = require('express');
const { authenticate } = require('../middleware/authenticate');
const { queryWithTenant, pool } = require('../config/database');

const router = express.Router();

// ── GET /api/dossiers ─────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const result = await queryWithTenant(req.user.tenant_id,
      `SELECT
         cd.id, cd.nom, cd.siret, cd.contact, cd.email, cd.notes,
         cd.created_at, cd.updated_at,
         COUNT(af.id)                                    AS nb_audits,
         MAX(af.uploaded_at)                             AS dernier_audit,
         (SELECT af2.taux_conformite
          FROM audit_files af2
          WHERE af2.dossier_id = cd.id AND af2.status = 'done'
          ORDER BY af2.uploaded_at DESC LIMIT 1)         AS dernier_score,
         (SELECT af3.id
          FROM audit_files af3
          WHERE af3.dossier_id = cd.id AND af3.status = 'done'
          ORDER BY af3.uploaded_at DESC LIMIT 1)         AS dernier_audit_id,
         (SELECT af4.original_name
          FROM audit_files af4
          WHERE af4.dossier_id = cd.id AND af4.status = 'done'
          ORDER BY af4.uploaded_at DESC LIMIT 1)         AS dernier_audit_nom
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

module.exports = router;
