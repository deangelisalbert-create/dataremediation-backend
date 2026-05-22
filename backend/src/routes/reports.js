// routes/reports.js — Téléchargement rapports avec liens temporaires
const express  = require('express');
const jwt      = require('jsonwebtoken');
const XLSX     = require('xlsx');
const path     = require('path');
const fs       = require('fs');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const { authenticate, checkRole } = require('../middleware/authenticate');
const { queryWithTenant, pool } = require('../config/database');
const { safeLog } = require('../middleware/errorHandler');

const router = express.Router();
const DOWNLOAD_TTL_MIN = parseInt(process.env.DOWNLOAD_LINK_TTL_MINUTES) || 15;

const C = {
  accent:  rgb(0/255, 229/255, 160/255),
  blue:    rgb(61/255, 142/255, 255/255),
  warn:    rgb(255/255, 179/255, 64/255),
  danger:  rgb(255/255, 69/255, 102/255),
  dark:    rgb(6/255, 8/255, 15/255),
  surface: rgb(11/255, 14/255, 24/255),
  card:    rgb(15/255, 18/255, 32/255),
  text:    rgb(200/255, 212/255, 238/255),
  muted:   rgb(74/255, 88/255, 120/255),
  white:   rgb(1, 1, 1),
  black:   rgb(0, 0, 0),
};

function hexToRgb(hex) {
  const r = parseInt(hex.slice(1,3),16)/255;
  const g = parseInt(hex.slice(3,5),16)/255;
  const b = parseInt(hex.slice(5,7),16)/255;
  return rgb(r,g,b);
}

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '…' : str;
}

async function generatePDF(summaryData, fileName, companyName) {
  const pdfDoc = await PDFDocument.create();
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const helvetica     = await pdfDoc.embedFont(StandardFonts.Helvetica);

  // Charger le logo
  let logoImage = null;
  try {
    const logoPath = path.join(__dirname, '../logo.png');
    const logoBytes = fs.readFileSync(logoPath);
    logoImage = await pdfDoc.embedPng(logoBytes);
  } catch(e) {
    console.log('Logo non trouvé, on continue sans:', e.message);
  }

  const results  = summaryData?.results  || [];
  const summary  = summaryData?.summary  || {};
  const aliasMap = summaryData?.aliasMap || {};

  const total     = summary.total     || results.length;
  const conformes = summary.conformes  || results.filter(r=>(r.statut||'').includes('Conforme')).length;
  const corriger  = summary.a_corriger || results.filter(r=>(r.statut||'').includes('corriger')).length;
  const bloquants = summary.bloquants  || results.filter(r=>(r.statut||'').includes('Bloquant')).length;
  const taux      = summary.taux       || (total > 0 ? Math.round(conformes/total*100) : 0);

  // ══════════════════════════════════════════════════════
  // PAGE 1 — COUVERTURE
  // ══════════════════════════════════════════════════════
  const page1 = pdfDoc.addPage([595, 842]);
  const { width, height } = page1.getSize();

  page1.drawRectangle({ x:0, y:0, width, height, color:C.dark });
  page1.drawRectangle({ x:0, y:height-6, width, height:6, color:C.accent });
  page1.drawRectangle({ x:0, y:0, width:4, height, color:C.accent });

  // Logo ou fallback texte
  if (logoImage) {
    const logoDims = logoImage.scale(0.18);
    page1.drawImage(logoImage, {
      x: 40,
      y: height - 50 - logoDims.height,
      width: logoDims.width,
      height: logoDims.height,
    });
    page1.drawText('DataRemédiation', {
      x: 40 + logoDims.width + 14,
      y: height - 62,
      size: 24, font: helveticaBold, color: C.white
    });
    page1.drawText('Agent IA Conformité Fournisseurs', {
      x: 40 + logoDims.width + 14,
      y: height - 82,
      size: 10, font: helvetica, color: C.muted
    });
  } else {
    page1.drawCircle({ x:65, y:height-65, size:30, color:C.accent });
    page1.drawText('DR', { x:52, y:height-72, size:18, font:helveticaBold, color:C.black });
    page1.drawText('DataRemédiation', { x:110, y:height-60, size:24, font:helveticaBold, color:C.white });
    page1.drawText('Agent IA Conformité Fournisseurs', { x:110, y:height-80, size:10, font:helvetica, color:C.muted });
  }

  page1.drawRectangle({ x:40, y:height-105, width:width-80, height:1, color:C.muted, opacity:0.3 });

  // Titre rapport
  page1.drawText('RAPPORT DE CONFORMITÉ', { x:40, y:height-155, size:30, font:helveticaBold, color:C.white });
  page1.drawText('e-INVOICING 2026', { x:40, y:height-193, size:30, font:helveticaBold, color:C.accent });

  page1.drawText(`Fichier : ${truncate(fileName, 55)}`, { x:40, y:height-235, size:10, font:helvetica, color:C.text });
  page1.drawText(`Entreprise : ${truncate(companyName || 'N/A', 55)}`, { x:40, y:height-252, size:10, font:helvetica, color:C.text });
  page1.drawText(`Date : ${new Date().toLocaleDateString('fr-FR', {day:'2-digit',month:'long',year:'numeric'})}`, { x:40, y:height-269, size:10, font:helvetica, color:C.text });

  // ── Score central ─────────────────────────────────────
  const scoreY = height - 430;
  page1.drawRectangle({ x:40, y:scoreY, width:width-80, height:130, color:C.surface });
  page1.drawRectangle({ x:40, y:scoreY+128, width:width-80, height:3, color:C.accent });

  page1.drawText('SCORE DE CONFORMITÉ GLOBAL', { x:60, y:scoreY+105, size:9, font:helveticaBold, color:C.muted });

  const scoreColor = taux >= 80 ? C.accent : taux >= 50 ? C.warn : C.danger;
  page1.drawText(`${taux}%`, { x:60, y:scoreY+48, size:52, font:helveticaBold, color:scoreColor });

  const scoreLabel = taux >= 80 ? 'EXCELLENT' : taux >= 60 ? 'BON' : taux >= 40 ? 'MOYEN' : 'CRITIQUE';
  page1.drawText(scoreLabel, { x:180, y:scoreY+72, size:13, font:helveticaBold, color:scoreColor });
  page1.drawText(`sur ${total} fournisseurs analysés`, { x:180, y:scoreY+54, size:10, font:helvetica, color:C.text });

  const barW = width - 220;
  page1.drawRectangle({ x:180, y:scoreY+30, width:barW, height:8, color:C.card });
  page1.drawRectangle({ x:180, y:scoreY+30, width:barW*(taux/100), height:8, color:scoreColor });
  page1.drawText(`${taux}%`, { x:180+barW*(taux/100)+4, y:scoreY+30, size:7, font:helvetica, color:scoreColor });

  // ── 4 KPIs ────────────────────────────────────────────
  const kpiY = scoreY - 105;
  const kpis = [
    { label:'Total',      value:total,     color:'#3d8eff' },
    { label:'Conformes',  value:conformes, color:'#00e5a0' },
    { label:'À corriger', value:corriger,  color:'#ffb340' },
    { label:'Bloquants',  value:bloquants, color:'#ff4566' },
  ];

  const kpiW = (width - 120) / 4;
  kpis.forEach((k, i) => {
    const kx = 40 + i * (kpiW + 13);
    const kColor = hexToRgb(k.color);
    page1.drawRectangle({ x:kx, y:kpiY, width:kpiW, height:85, color:C.surface });
    page1.drawRectangle({ x:kx, y:kpiY+83, width:kpiW, height:2, color:kColor });
    page1.drawText(k.label.toUpperCase(), { x:kx+10, y:kpiY+65, size:8, font:helveticaBold, color:C.muted });
    page1.drawText(String(k.value), { x:kx+10, y:kpiY+22, size:34, font:helveticaBold, color:kColor });
  });

  // ── Graphique en barres ───────────────────────────────
  const chartY = kpiY - 185;
  page1.drawText('RÉPARTITION DES FOURNISSEURS', { x:40, y:chartY+155, size:9, font:helveticaBold, color:C.muted });

  const bars = [
    { label:'Conformes',  value:conformes, color:C.accent },
    { label:'À corriger', value:corriger,  color:C.warn   },
    { label:'Bloquants',  value:bloquants, color:C.danger },
  ];

  const maxVal  = Math.max(conformes, corriger, bloquants, 1);
  const chartH  = 100;
  const barWidth = 65;
  const barSpacing = 85;
  const chartX  = 70;

  // Axe Y
  page1.drawRectangle({ x:chartX-15, y:chartY+18, width:1, height:chartH+5, color:C.muted, opacity:0.4 });

  bars.forEach((b, i) => {
    const bx = chartX + i * (barWidth + barSpacing);
    const bh = total > 0 ? (b.value / maxVal) * chartH : 0;
    page1.drawRectangle({ x:bx, y:chartY+20, width:barWidth, height:Math.max(bh, 2), color:b.color, opacity:0.9 });
    const valStr = String(b.value);
    page1.drawText(valStr, { x:bx + barWidth/2 - (valStr.length*3.5), y:chartY+25+bh, size:11, font:helveticaBold, color:C.white });
    page1.drawText(b.label, { x:bx + barWidth/2 - (b.label.length*2.5), y:chartY+6, size:7, font:helvetica, color:C.text });
  });

  page1.drawRectangle({ x:chartX-15, y:chartY+19, width:barWidth*3+barSpacing*2+30, height:1, color:C.muted, opacity:0.5 });

  // Pied de page
  page1.drawRectangle({ x:0, y:0, width, height:38, color:C.surface });
  page1.drawText('Confidentiel — DataRemédiation © 2026 — Conformité e-Invoicing', { x:40, y:14, size:8, font:helvetica, color:C.muted });
  page1.drawText('Page 1 / 3', { x:width-65, y:14, size:8, font:helvetica, color:C.muted });

  // ══════════════════════════════════════════════════════
  // PAGE 2 — ANOMALIES & RECOMMANDATIONS
  // ══════════════════════════════════════════════════════
  const page2 = pdfDoc.addPage([595, 842]);
  page2.drawRectangle({ x:0, y:0, width, height, color:C.dark });
  page2.drawRectangle({ x:0, y:height-6, width, height:6, color:C.accent });
  page2.drawRectangle({ x:0, y:0, width:4, height, color:C.accent });

  // Header
  page2.drawText('DataRemédiation', { x:40, y:height-45, size:12, font:helveticaBold, color:C.accent });
  page2.drawText('ANOMALIES DÉTECTÉES & RECOMMANDATIONS', { x:40, y:height-68, size:15, font:helveticaBold, color:C.white });
  page2.drawRectangle({ x:40, y:height-82, width:width-80, height:1, color:C.muted, opacity:0.3 });

  let currentY = height - 108;

  const bloquantsList = results.filter(r => (r.statut||'').includes('Bloquant')).slice(0, 9);
  const corrigerList  = results.filter(r => (r.statut||'').includes('corriger')).slice(0, 9);

  if (bloquantsList.length > 0) {
    page2.drawRectangle({ x:40, y:currentY-18, width:width-80, height:22, color:hexToRgb('#ff456615'), opacity:0.3 });
    page2.drawText(`✗ FOURNISSEURS BLOQUANTS (${bloquantsList.length})`, { x:45, y:currentY-10, size:10, font:helveticaBold, color:C.danger });
    currentY -= 28;

    bloquantsList.forEach((r) => {
      if (currentY < 120) return;
      const nom = truncate(r.nom_reel || aliasMap[r.alias] || r.alias, 38);
      const erreurs = truncate((r.erreurs||[]).join(' · '), 60);

      page2.drawRectangle({ x:40, y:currentY-16, width:width-80, height:20, color:C.surface });
      page2.drawRectangle({ x:40, y:currentY-16, width:3, height:20, color:C.danger });
      page2.drawText(nom, { x:50, y:currentY-8, size:9, font:helveticaBold, color:C.white });
      page2.drawText(erreurs, { x:50, y:currentY-20, size:7.5, font:helvetica, color:C.muted });

      if (r.suggestion) {
        page2.drawText(`→ ${truncate(r.suggestion, 75)}`, { x:50, y:currentY-32, size:7.5, font:helvetica, color:C.accent });
        currentY -= 44;
      } else {
        currentY -= 28;
      }
    });
  }

  currentY -= 16;

  if (corrigerList.length > 0 && currentY > 160) {
    page2.drawRectangle({ x:40, y:currentY-18, width:width-80, height:22, color:hexToRgb('#ffb34015'), opacity:0.3 });
    page2.drawText(`⚠ FOURNISSEURS À CORRIGER (${corrigerList.length})`, { x:45, y:currentY-10, size:10, font:helveticaBold, color:C.warn });
    currentY -= 28;

    corrigerList.forEach((r) => {
      if (currentY < 120) return;
      const nom = truncate(r.nom_reel || aliasMap[r.alias] || r.alias, 38);
      const erreurs = truncate((r.erreurs||[]).join(' · '), 60);

      page2.drawRectangle({ x:40, y:currentY-16, width:width-80, height:20, color:C.surface });
      page2.drawRectangle({ x:40, y:currentY-16, width:3, height:20, color:C.warn });
      page2.drawText(nom, { x:50, y:currentY-8, size:9, font:helveticaBold, color:C.white });
      page2.drawText(erreurs, { x:50, y:currentY-20, size:7.5, font:helvetica, color:C.muted });

      if (r.suggestion) {
        page2.drawText(`→ ${truncate(r.suggestion, 75)}`, { x:50, y:currentY-32, size:7.5, font:helvetica, color:C.accent });
        currentY -= 44;
      } else {
        currentY -= 28;
      }
    });
  }

  // Recommandations générales
  if (currentY > 170) {
    currentY -= 16;
    const recH = 115;
    page2.drawRectangle({ x:40, y:currentY-recH, width:width-80, height:recH, color:C.surface });
    page2.drawRectangle({ x:40, y:currentY-recH+recH-2, width:width-80, height:3, color:C.blue });

    page2.drawText('RECOMMANDATIONS GÉNÉRALES — e-INVOICING 2026', { x:50, y:currentY-16, size:9, font:helveticaBold, color:C.blue });

    const recs = [
      '1.  Compléter tous les SIREN (9 chiffres) en SIRET (14 chiffres) avant le 01/09/2026',
      '2.  Valider les numéros de TVA intracommunautaire pour tous les fournisseurs européens',
      '3.  Éliminer les doublons fournisseurs pour éviter les rejets de factures électroniques',
      '4.  Mettre à jour les données fournisseurs dans votre ERP / outil comptable',
      '5.  Planifier un audit de conformité tous les 6 mois pour maintenir le niveau de qualité',
    ];

    recs.forEach((rec, i) => {
      page2.drawText(rec, { x:50, y:currentY-34-(i*15), size:8, font:helvetica, color:C.text });
    });
  }

  page2.drawRectangle({ x:0, y:0, width, height:38, color:C.surface });
  page2.drawText('Confidentiel — DataRemédiation © 2026 — Conformité e-Invoicing', { x:40, y:14, size:8, font:helvetica, color:C.muted });
  page2.drawText('Page 2 / 3', { x:width-65, y:14, size:8, font:helvetica, color:C.muted });

  // ══════════════════════════════════════════════════════
  // PAGE 3 — LISTE COMPLÈTE FOURNISSEURS
  // ══════════════════════════════════════════════════════
  const page3 = pdfDoc.addPage([595, 842]);
  page3.drawRectangle({ x:0, y:0, width, height, color:C.dark });
  page3.drawRectangle({ x:0, y:height-6, width, height:6, color:C.accent });
  page3.drawRectangle({ x:0, y:0, width:4, height, color:C.accent });

  page3.drawText('DataRemédiation', { x:40, y:height-45, size:12, font:helveticaBold, color:C.accent });
  page3.drawText(`LISTE COMPLÈTE — ${total} FOURNISSEURS`, { x:40, y:height-68, size:15, font:helveticaBold, color:C.white });
  page3.drawRectangle({ x:40, y:height-82, width:width-80, height:1, color:C.muted, opacity:0.3 });

  // En-tête tableau
  const colY = height - 100;
  page3.drawRectangle({ x:40, y:colY-14, width:width-80, height:18, color:C.surface });
  page3.drawRectangle({ x:40, y:colY+2, width:width-80, height:2, color:C.accent });

  page3.drawText('Fournisseur',    { x:46,  y:colY-8, size:7.5, font:helveticaBold, color:C.muted });
  page3.drawText('Statut',         { x:248, y:colY-8, size:7.5, font:helveticaBold, color:C.muted });
  page3.drawText('SIRET',          { x:318, y:colY-8, size:7.5, font:helveticaBold, color:C.muted });
  page3.drawText('TVA',            { x:368, y:colY-8, size:7.5, font:helveticaBold, color:C.muted });
  page3.drawText('Recommandation', { x:400, y:colY-8, size:7.5, font:helveticaBold, color:C.muted });

  let rowY = colY - 24;
  const maxRows = 38;

  results.slice(0, maxRows).forEach((r, i) => {
    if (rowY < 50) return;
    const isConf  = (r.statut||'').includes('Conforme');
    const isBlock = (r.statut||'').includes('Bloquant');
    const rowBg   = i % 2 === 0 ? C.surface : C.card;
    const statusColor = isConf ? C.accent : isBlock ? C.danger : C.warn;
    const statut = isConf ? 'Conforme' : isBlock ? 'Bloquant' : 'Corriger';
    const nom = truncate(r.nom_reel || aliasMap[r.alias] || r.alias, 30);
    const suggestion = truncate(r.suggestion || '', 22);

    page3.drawRectangle({ x:40, y:rowY-13, width:width-80, height:17, color:rowBg });
    page3.drawRectangle({ x:40, y:rowY-13, width:2, height:17, color:statusColor });

    page3.drawText(nom,        { x:46,  y:rowY-7, size:7, font:helvetica,     color:C.text });
    page3.drawText(statut,     { x:248, y:rowY-7, size:7, font:helveticaBold, color:statusColor });
    page3.drawText(r.siret_ok?'✓':'✗', { x:332, y:rowY-7, size:8, font:helveticaBold, color:r.siret_ok?C.accent:C.danger });
    page3.drawText(r.tva_ok?'✓':'✗',   { x:378, y:rowY-7, size:8, font:helveticaBold, color:r.tva_ok?C.accent:C.danger });
    page3.drawText(suggestion, { x:400, y:rowY-7, size:6, font:helvetica,     color:C.muted });

    rowY -= 18;
  });

  if (results.length > maxRows) {
    page3.drawText(`... et ${results.length - maxRows} autres fournisseurs — voir fichier Excel pour la liste complète`, {
      x:40, y:rowY+2, size:8, font:helvetica, color:C.muted
    });
  }

  page3.drawRectangle({ x:0, y:0, width, height:38, color:C.surface });
  page3.drawText('Confidentiel — DataRemédiation © 2026 — Conformité e-Invoicing', { x:40, y:14, size:8, font:helvetica, color:C.muted });
  page3.drawText('Page 3 / 3', { x:width-65, y:14, size:8, font:helvetica, color:C.muted });

  return Buffer.from(await pdfDoc.save());
}

// ── POST /api/reports/:fileId/link ────────────────────────────────────────────
router.post('/:fileId/link',
  authenticate,
  checkRole(['admin', 'client']),
  async (req, res, next) => {
    try {
      const { fileId } = req.params;
      const { type } = req.body;

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
        { fileId, tenantId: req.user.tenant_id, userId: req.user.id, type, purpose: 'download' },
        process.env.JWT_SECRET,
        { expiresIn: `${DOWNLOAD_TTL_MIN}m` }
      );

      safeLog('info', 'DOWNLOAD_LINK_GENERATED', { userId: req.user.id, tenantId: req.user.tenant_id, type });

      res.json({
        downloadUrl: `/api/reports/download/${downloadToken}`,
        expiresAt: new Date(Date.now() + DOWNLOAD_TTL_MIN * 60000).toISOString(),
        ttlMinutes: DOWNLOAD_TTL_MIN,
      });
    } catch (err) { next(err); }
  }
);

// ── GET /api/reports/download/:token ─────────────────────────────────────────
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
      `SELECT af.original_name, af.tenant_id, ar.csv_content, ar.pdf_content, ar.summary,
              u.company
       FROM audit_files af
       LEFT JOIN audit_reports ar ON ar.file_id = af.id
       LEFT JOIN users u ON u.tenant_id = af.tenant_id
       WHERE af.id = $1 AND af.tenant_id = $2
       LIMIT 1`,
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
        const summaryData = typeof row.summary === 'string' ? JSON.parse(row.summary) : row.summary;
        const results  = summaryData?.results  || [];
        const aliasMap = summaryData?.aliasMap  || {};
        const summary  = summaryData?.summary   || {};

        const wb = XLSX.utils.book_new();

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
        ];

        const wsResume = XLSX.utils.aoa_to_sheet(resumeData);
        wsResume['!cols'] = [{ wch: 30 }, { wch: 50 }];
        XLSX.utils.book_append_sheet(wb, wsResume, 'Résumé');

        const headers = ['Nom fournisseur','Alias','Statut','SIRET/SIREN valide','TVA valide','Cohérence SIREN','Erreurs','Recommandation e-Invoicing 2026'];
        const detailData = [headers];
        results.forEach(r => {
          detailData.push([
            r.nom_reel || aliasMap[r.alias] || r.alias,
            r.alias, r.statut || '',
            r.siret_ok ? 'OUI' : 'NON',
            r.tva_ok   ? 'OUI' : 'NON',
            r.siren_coherent ? 'OUI' : 'NON',
            (r.erreurs || []).join(' | '),
            r.suggestion || '',
          ]);
        });

        const wsDetail = XLSX.utils.aoa_to_sheet(detailData);
        wsDetail['!cols'] = [{ wch:35 },{ wch:12 },{ wch:15 },{ wch:18 },{ wch:12 },{ wch:18 },{ wch:40 },{ wch:60 }];
        XLSX.utils.book_append_sheet(wb, wsDetail, 'Fournisseurs');

        const conformes = results.filter(r => (r.statut||'').includes('Conforme'));
        if (conformes.length > 0) {
          const cd = [headers, ...conformes.map(r => [r.nom_reel||aliasMap[r.alias]||r.alias,r.alias,r.statut||'',r.siret_ok?'OUI':'NON',r.tva_ok?'OUI':'NON',r.siren_coherent?'OUI':'NON',(r.erreurs||[]).join(' | '),r.suggestion||''])];
          const ws = XLSX.utils.aoa_to_sheet(cd);
          ws['!cols'] = wsDetail['!cols'];
          XLSX.utils.book_append_sheet(wb, ws, 'Conformes');
        }

        const nonConformes = results.filter(r => !(r.statut||'').includes('Conforme'));
        if (nonConformes.length > 0) {
          const nd = [headers, ...nonConformes.map(r => [r.nom_reel||aliasMap[r.alias]||r.alias,r.alias,r.statut||'',r.siret_ok?'OUI':'NON',r.tva_ok?'OUI':'NON',r.siren_coherent?'OUI':'NON',(r.erreurs||[]).join(' | '),r.suggestion||''])];
          const ws = XLSX.utils.aoa_to_sheet(nd);
          ws['!cols'] = wsDetail['!cols'];
          XLSX.utils.book_append_sheet(wb, ws, 'À corriger & Bloquants');
        }

        const xlsxBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="rapport_${baseName}.xlsx"`);
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        return res.send(xlsxBuffer);

      } catch(xlsxErr) {
        console.error('Erreur génération Excel:', xlsxErr.message);
        const csvContent = row.csv_content || 'Aucune donnée';
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="rapport_${baseName}.csv"`);
        return res.send('\uFEFF' + csvContent);
      }
    }

    // ── Export PDF ────────────────────────────────────────
    if (decoded.type === 'pdf') {
      try {
        const summaryData = typeof row.summary === 'string' ? JSON.parse(row.summary) : row.summary;
        const pdfBuffer = await generatePDF(summaryData, row.original_name, row.company);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="rapport_conformite_${baseName}.pdf"`);
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        return res.send(pdfBuffer);
      } catch(pdfErr) {
        console.error('Erreur génération PDF:', pdfErr.message);
        const content = row.pdf_content || row.csv_content || 'Rapport non disponible';
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="rapport_${baseName}.txt"`);
        return res.send(content);
      }
    }

    res.status(400).json({ error: 'Type inconnu' });
  } catch (err) { next(err); }
});

module.exports = router;
