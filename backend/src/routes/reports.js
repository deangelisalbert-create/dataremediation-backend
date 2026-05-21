// routes/reports.js — Téléchargement rapports avec liens temporaires
const express = require('express');
const jwt     = require('jsonwebtoken');
const XLSX    = require('xlsx');
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

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'Lien de téléchargement invalide ou expiré' });
    }

    if (decoded.purpose !== 'download') {
      return res.status(401).json({ error: 'Token invalide' });
    }

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

    // ── Export Excel ──────────────────────────────────────
    if (decoded.type === 'csv') {
      try {
        // Parser le summary pour récupérer les résultats
        const summaryData = typeof row.summary === 'string'
          ? JSON.parse(row.summary)
          : row.summary;

        const results  = summaryData?.results  || [];
        const aliasMap = summaryData?.aliasMap  || {};
        const summary  = summaryData?.summary   || {};

        const wb = XLSX.utils.book_new();

        // ── Feuille 1 : Résumé ────────────────────────────
        const resumeData = [
          ['RAPPORT DE CONFORMITÉ e-INVOICING 2026'],
          ['DataRemédiation — Confidentiel'],
          [],
          ['Fichier analysé', row.original_name],
          ['Date de génération', new Date().toLocaleDateString('fr-FR')],
          [],
          ['RÉSUMÉ'],
          ['Total fournisseurs', summary.total || results.length],
          ['Conformes',          summary.conformes  || 0],
          ['À corriger',         summary.a_corriger || 0],
          ['Bloquants',          summary.bloquants  || 0],
          ['Taux de conformité', `${summary.taux || 0}%`],
          [],
          ['NOTE : Les fournisseurs "Conformes" avec SIREN (9 chiffres) devront compléter'],
          ['leur identifiant en SIRET (14 chiffres) pour la conformité e-Invoicing 2026.'],
        ];

        const wsResume = XLSX.utils.aoa_to_sheet(resumeData);

        // Style titre
        wsResume['A1'] = { v: 'RAPPORT DE CONFORMITÉ e-INVOICING 2026', t: 's' };
        wsResume['!cols'] = [{ wch: 30 }, { wch: 50 }];
        XLSX.utils.book_append_sheet(wb, wsResume, 'Résumé');

        // ── Feuille 2 : Détail fournisseurs ───────────────
        const headers = [
          'Nom fournisseur',
          'Alias',
          'Statut',
          'SIRET/SIREN valide',
          'TVA valide',
          'Cohérence SIREN',
          'Erreurs',
          'Recommandation e-Invoicing 2026',
        ];

        const detailData = [headers];

        results.forEach(r => {
          detailData.push([
            r.nom_reel || aliasMap[r.alias] || r.alias,
            r.alias,
            r.statut || '',
            r.siret_ok ? 'OUI' : 'NON',
            r.tva_ok   ? 'OUI' : 'NON',
            r.siren_coherent ? 'OUI' : 'NON',
            (r.erreurs || []).join(' | '),
            r.suggestion || '',
          ]);
        });

        const wsDetail = XLSX.utils.aoa_to_sheet(detailData);

        // Largeurs colonnes
        wsDetail['!cols'] = [
          { wch: 35 }, // Nom
          { wch: 12 }, // Alias
          { wch: 15 }, // Statut
          { wch: 18 }, // SIRET
          { wch: 12 }, // TVA
          { wch: 18 }, // SIREN
          { wch: 40 }, // Erreurs
          { wch: 60 }, // Recommandation
        ];

        XLSX.utils.book_append_sheet(wb, wsDetail, 'Fournisseurs');

        // ── Feuille 3 : Conformes ─────────────────────────
        const conformes = results.filter(r => (r.statut||'').includes('Conforme'));
        if (conformes.length > 0) {
          const conformeData = [headers];
          conformes.forEach(r => {
            conformeData.push([
              r.nom_reel || aliasMap[r.alias] || r.alias,
              r.alias,
              r.statut || '',
              r.siret_ok ? 'OUI' : 'NON',
              r.tva_ok   ? 'OUI' : 'NON',
              r.siren_coherent ? 'OUI' : 'NON',
              (r.erreurs || []).join(' | '),
              r.suggestion || '',
            ]);
          });
          const wsConformes = XLSX.utils.aoa_to_sheet(conformeData);
          wsConformes['!cols'] = wsDetail['!cols'];
          XLSX.utils.book_append_sheet(wb, wsConformes, 'Conformes');
        }

        // ── Feuille 4 : À corriger + Bloquants ───────────
        const nonConformes = results.filter(r => !(r.statut||'').includes('Conforme'));
        if (nonConformes.length > 0) {
          const nonConformeData = [headers];
          nonConformes.forEach(r => {
            nonConformeData.push([
              r.nom_reel || aliasMap[r.alias] || r.alias,
              r.alias,
              r.statut || '',
              r.siret_ok ? 'OUI' : 'NON',
              r.tva_ok   ? 'OUI' : 'NON',
              r.siren_coherent ? 'OUI' : 'NON',
              (r.erreurs || []).join(' | '),
              r.suggestion || '',
            ]);
          });
          const wsNonConformes = XLSX.utils.aoa_to_sheet(nonConformeData);
          wsNonConformes['!cols'] = wsDetail['!cols'];
          XLSX.utils.book_append_sheet(wb, wsNonConformes, 'À corriger & Bloquants');
        }

        // Générer le buffer Excel
        const xlsxBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="rapport_${baseName}.xlsx"`);
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        return res.send(xlsxBuffer);

      } catch(xlsxErr) {
        console.error('Erreur génération Excel:', xlsxErr.message);
        // Fallback CSV si erreur
        const csvContent = row.csv_content || 'Aucune donnée';
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="rapport_${baseName}.csv"`);
        return res.send('\uFEFF' + csvContent);
      }
    }

    // ── Export rapport texte ──────────────────────────────
    if (decoded.type === 'pdf') {
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
