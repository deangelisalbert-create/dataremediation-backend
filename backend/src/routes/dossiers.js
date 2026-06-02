// routes/dossiers.js — Gestion des dossiers clients
const express = require('express');
const { authenticate } = require('../middleware/authenticate');
const { queryWithTenant, pool } = require('../config/database');

const router = express.Router();

// ── GET /api/dossiers — Lister les dossiers du tenant ────
router.get('/', authenticate, async (req, res) => {
  try {
    const result = await queryWithTenant(req.user.tenant_id,
      `SELECT cd.*,
        COUNT(af.id) AS nb_audits,
        MAX(af.uploaded_at) AS dernier_audit
       FROM client_dossiers cd
       LEFT JOIN audit_files af ON af.dossier_id = cd.id
       WHERE cd.tenant_id = $1
       GROUP BY cd.id
       ORDER BY cd.created_at DESC`,
      [req.user.tenant_id]
    );
    res.json({ dossiers: result.rows });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/dossiers — Creer un dossier ────────────────
router.post('/', authenticate, async (req, res) => {
  try {
    const { nom, siret, contact, email, notes } = req.body;
    if (!nom || !nom.trim()) return res.status(400).json({ error: 'Le nom du dossier est requis.' });

    const result = await queryWithTenant(req.user.tenant_id,
      `INSERT INTO client_dossiers (tenant_id, nom, siret, contact, email, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [req.user.tenant_id, nom.trim(), siret||null, contact||null, email||null, notes||null]
    );
    res.status(201).json({ dossier: result.rows[0] });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/dossiers/:id — Detail d'un dossier ──────────
router.get('/:id', authenticate, async (req, res) => {
  try {
    const result = await queryWithTenant(req.user.tenant_id,
      `SELECT cd.*,
        json_agg(
          json_build_object(
            'id', af.id,
            'nom', af.original_name,
            'status', af.status,
            'taux', af.taux_conformite,
            'date', af.uploaded_at,
            'size', af.file_size
          ) ORDER BY af.uploaded_at DESC
        ) FILTER (WHERE af.id IS NOT NULL) AS audits
       FROM client_dossiers cd
       LEFT JOIN audit_files af ON af.dossier_id = cd.id
       WHERE cd.id = $1 AND cd.tenant_id = $2
       GROUP BY cd.id`,
      [req.params.id, req.user.tenant_id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Dossier introuvable.' });
    res.json({ dossier: result.rows[0] });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/dossiers/:id — Modifier un dossier ──────────
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { nom, siret, contact, email, notes } = req.body;
    const result = await queryWithTenant(req.user.tenant_id,
      `UPDATE client_dossiers
       SET nom=$1, siret=$2, contact=$3, email=$4, notes=$5, updated_at=NOW()
       WHERE id=$6 AND tenant_id=$7
       RETURNING *`,
      [nom, siret||null, contact||null, email||null, notes||null, req.params.id, req.user.tenant_id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Dossier introuvable.' });
    res.json({ dossier: result.rows[0] });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/dossiers/:id — Supprimer un dossier ──────
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
