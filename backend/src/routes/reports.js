// routes/reports.js
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
  str = String(str);
  return str.length > max ? str.slice(0, max) + '...' : str;
}

async function generatePDF(summaryData, fileName, companyName) {
  const pdfDoc = await PDFDocument.create();
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const helvetica     = await pdfDoc.embedFont(StandardFonts.Helvetica);

  // Charger le logo
  let logoImage = null;
  try {
    const logoPath = path.join(__dirname, '../logo.png');
    if (fs.existsSync(logoPath)) {
      const logoBytes = fs.readFileSync(logoPath);
      logoImage = await pdfDoc.embedPng(logoBytes);
    }
  } catch(e) {
    console.log('Logo non charge:', e.message);
  }

  const results  = summaryData?.results  || [];
  const summary  = summaryData?.summary  || {};
  const aliasMap = summaryData?.aliasMap || {};

  const total     = summary.total     || results.length;
  const conformes = summary.conformes  || results.filter(r=>(r.statut||'').includes('Conforme')).length;
  const corriger  = summary.a_corriger || results.filter(r=>(r.statut||'').includes('corriger')).length;
  const bloquants = summary.bloquants  || results.filter(r=>(r.statut||'').includes('Bloquant')).length;
  const taux      = summary.taux       || (total > 0 ? Math.round(conformes/total*100) : 0);

  const W = 595, H = 842;

  // ══════════════════════════════════════════════════════
  // PAGE 1 — COUVERTURE
  // ══════════════════════════════════════════════════════
  const page1 = pdfDoc.addPage([W, H]);

  page1.drawRectangle({ x:0, y:0, width:W, height:H, color:C.dark });
  page1.drawRectangle({ x:0, y:H-5, width:W, height:5, color:C.accent });
  page1.drawRectangle({ x:0, y:0, width:4, height:H, color:C.accent });

  // ── Header avec logo petit ─────────────────────────────
  const headerH = 60;
  page1.drawRectangle({ x:0, y:H-headerH, width:W, height:headerH, color:C.surface });

  if (logoImage) {
    // Logo petit — max 45px de hauteur
    const dims = logoImage.scaleToFit(45, 45);
    page1.drawImage(logoImage, {
      x: 20,
      y: H - headerH/2 - dims.height/2,
      width: dims.width,
      height: dims.height,
    });
    page1.drawText('DataRemediation', {
      x: 20 + dims.width + 10,
      y: H - headerH/2 + 6,
      size: 16, font: helveticaBold, color: C.white
    });
    page1.drawText('Agent IA Conformite Fournisseurs', {
      x: 20 + dims.width + 10,
      y: H - headerH/2 - 8,
      size: 8, font: helvetica, color: C.muted
    });
  } else {
    page1.drawRectangle({ x:20, y:H-headerH+8, width:42, height:42, color:C.accent });
    page1.drawText('DR', { x:30, y:H-headerH+22, size:16, font:helveticaBold, color:C.black });
    page1.drawText('DataRemediation', { x:70, y:H-headerH+28, size:16, font:helveticaBold, color:C.white });
    page1.drawText('Agent IA Conformite Fournisseurs', { x:70, y:H-headerH+14, size:8, font:helvetica, color:C.muted });
  }

  // Ligne séparatrice
  page1.drawRectangle({ x:20, y:H-headerH-1, width:W-40, height:1, color:C.accent, opacity:0.4 });

  // ── Titre rapport ─────────────────────────────────────
  const titleY = H - headerH - 70;
  page1.drawText('RAPPORT DE CONFORMITE', { x:30, y:titleY, size:26, font:helveticaBold, color:C.white });
  page1.drawText('e-INVOICING 2026', { x:30, y:titleY-34, size:26, font:helveticaBold, color:C.accent });

  // Infos
  page1.drawText('Fichier : ' + truncate(fileName, 60), { x:30, y:titleY-70, size:9, font:helvetica, color:C.text });
  page1.drawText('Entreprise : ' + truncate(companyName || 'N/A', 60), { x:30, y:titleY-84, size:9, font:helvetica, color:C.text });
  page1.drawText('Date : ' + new Date().toLocaleDateString('fr-FR', {day:'2-digit',month:'long',year:'numeric'}), { x:30, y:titleY-98, size:9, font:helvetica, color:C.text });

  // ── Score central ─────────────────────────────────────
  const scoreY = titleY - 230;
  page1.drawRectangle({ x:20, y:scoreY, width:W-40, height:115, color:C.surface });
  page1.drawRectangle({ x:20, y:scoreY+113, width:W-40, height:3, color:C.accent });

  page1.drawText('SCORE DE CONFORMITE GLOBAL', { x:36, y:scoreY+92, size:8, font:helveticaBold, color:C.muted });

  const scoreColor = taux >= 80 ? C.accent : taux >= 50 ? C.warn : C.danger;
  page1.drawText(taux + '%', { x:36, y:scoreY+42, size:46, font:helveticaBold, color:scoreColor });

  const scoreLabel = taux >= 80 ? 'EXCELLENT' : taux >= 60 ? 'BON' : taux >= 40 ? 'MOYEN' : 'CRITIQUE';
  page1.drawText(scoreLabel, { x:160, y:scoreY+68, size:12, font:helveticaBold, color:scoreColor });
  page1.drawText('sur ' + total + ' fournisseurs analyses', { x:160, y:scoreY+52, size:9, font:helvetica, color:C.text });

  const barW = W - 200;
  page1.drawRectangle({ x:160, y:scoreY+26, width:barW, height:7, color:C.card });
  if (taux > 0) page1.drawRectangle({ x:160, y:scoreY+26, width:Math.min(barW*(taux/100), barW), height:7, color:scoreColor });

  // ── 4 KPIs ────────────────────────────────────────────
  const kpiY = scoreY - 95;
  const kpis = [
    { label:'Total',      value:total,     color:'#3d8eff' },
    { label:'Conformes',  value:conformes, color:'#00e5a0' },
    { label:'A corriger', value:corriger,  color:'#ffb340' },
    { label:'Bloquants',  value:bloquants, color:'#ff4566' },
  ];
  const kpiW = (W - 60) / 4;
  kpis.forEach((k, i) => {
    const kx = 20 + i * (kpiW + 6);
    const kColor = hexToRgb(k.color);
    page1.drawRectangle({ x:kx, y:kpiY, width:kpiW, height:78, color:C.surface });
    page1.drawRectangle({ x:kx, y:kpiY+76, width:kpiW, height:2, color:kColor });
    page1.drawText(k.label.toUpperCase(), { x:kx+8, y:kpiY+58, size:7, font:helveticaBold, color:C.muted });
    page1.drawText(String(k.value), { x:kx+8, y:kpiY+18, size:30, font:helveticaBold, color:kColor });
  });

  // ── Graphique barres ──────────────────────────────────
  const chartY = kpiY - 175;
  page1.drawText('REPARTITION DES FOURNISSEURS', { x:30, y:chartY+148, size:8, font:helveticaBold, color:C.muted });

  const bars = [
    { label:'Conformes',  value:conformes, color:C.accent },
    { label:'A corriger', value:corriger,  color:C.warn   },
    { label:'Bloquants',  value:bloquants, color:C.danger },
  ];
  const maxVal = Math.max(conformes, corriger, bloquants, 1);
  const bW = 70, bSp = 90, bH = 100, bX = 60;

  page1.drawRectangle({ x:bX-8, y:chartY+18, width:1, height:bH+5, color:C.muted, opacity:0.3 });
  bars.forEach((b, i) => {
    const bx = bX + i*(bW+bSp);
    const bh = Math.max((b.value/maxVal)*bH, 2);
    page1.drawRectangle({ x:bx, y:chartY+20, width:bW, height:bh, color:b.color, opacity:0.9 });
    page1.drawText(String(b.value), { x:bx+bW/2-8, y:chartY+24+bh, size:11, font:helveticaBold, color:C.white });
    page1.drawText(b.label, { x:bx+bW/2-(b.label.length*2.5), y:chartY+6, size:7, font:helvetica, color:C.text });
  });
  page1.drawRectangle({ x:bX-8, y:chartY+19, width:bW*3+bSp*2+20, height:1, color:C.muted, opacity:0.4 });

  // Pied page 1
  page1.drawRectangle({ x:0, y:0, width:W, height:34, color:C.surface });
  page1.drawText('Confidentiel - DataRemediation 2026 - Conformite e-Invoicing', { x:30, y:12, size:7, font:helvetica, color:C.muted });
  page1.drawText('Page 1 / 3', { x:W-58, y:12, size:7, font:helvetica, color:C.muted });

  // ══════════════════════════════════════════════════════
  // PAGE 2 — ANOMALIES
  // ══════════════════════════════════════════════════════
  const page2 = pdfDoc.addPage([W, H]);
  page2.drawRectangle({ x:0, y:0, width:W, height:H, color:C.dark });
  page2.drawRectangle({ x:0, y:H-5, width:W, height:5, color:C.accent });
  page2.drawRectangle({ x:0, y:0, width:4, height:H, color:C.accent });

  // Header page 2
  page2.drawRectangle({ x:0, y:H-50, width:W, height:50, color:C.surface });
  page2.drawText('DataRemediation', { x:20, y:H-22, size:11, font:helveticaBold, color:C.accent });
  page2.drawText('ANOMALIES DETECTEES ET RECOMMANDATIONS', { x:20, y:H-38, size:13, font:helveticaBold, color:C.white });
  page2.drawRectangle({ x:20, y:H-52, width:W-40, height:1, color:C.accent, opacity:0.3 });

  let curY = H - 72;

  const bloquantsList = results.filter(r => (r.statut||'').includes('Bloquant')).slice(0, 10);
  const corrigerList  = results.filter(r => (r.statut||'').includes('corriger')).slice(0, 10);

  if (bloquantsList.length > 0) {
    page2.drawRectangle({ x:20, y:curY-22, width:W-40, height:26, color:C.surface });
    page2.drawRectangle({ x:20, y:curY-22, width:3, height:26, color:C.danger });
    page2.drawText('FOURNISSEURS BLOQUANTS (' + bloquantsList.length + ')', { x:28, y:curY-11, size:9, font:helveticaBold, color:C.danger });
    curY -= 32;

    bloquantsList.forEach(r => {
      if (curY < 110) return;
      const nom = truncate(r.nom_reel || aliasMap[r.alias] || r.alias, 40);
      const err = truncate((r.erreurs||[]).join(' - '), 65);
      const hasRec = !!r.suggestion;
      const rowH = hasRec ? 42 : 28;

      page2.drawRectangle({ x:20, y:curY-rowH, width:W-40, height:rowH, color:C.card });
      page2.drawRectangle({ x:20, y:curY-rowH, width:3, height:rowH, color:C.danger });
      page2.drawText(nom, { x:28, y:curY-10, size:8.5, font:helveticaBold, color:C.white });
      page2.drawText(err, { x:28, y:curY-22, size:7.5, font:helvetica, color:C.muted });
      if (hasRec) {
        page2.drawText('-> ' + truncate(r.suggestion, 80), { x:28, y:curY-34, size:7.5, font:helvetica, color:C.accent });
      }
      curY -= rowH + 4;
    });
  }

  curY -= 12;

  if (corrigerList.length > 0 && curY > 150) {
    page2.drawRectangle({ x:20, y:curY-22, width:W-40, height:26, color:C.surface });
    page2.drawRectangle({ x:20, y:curY-22, width:3, height:26, color:C.warn });
    page2.drawText('FOURNISSEURS A CORRIGER (' + corrigerList.length + ')', { x:28, y:curY-11, size:9, font:helveticaBold, color:C.warn });
    curY -= 32;

    corrigerList.forEach(r => {
      if (curY < 110) return;
      const nom = truncate(r.nom_reel || aliasMap[r.alias] || r.alias, 40);
      const err = truncate((r.erreurs||[]).join(' - '), 65);
      const hasRec = !!r.suggestion;
      const rowH = hasRec ? 42 : 28;

      page2.drawRectangle({ x:20, y:curY-rowH, width:W-40, height:rowH, color:C.card });
      page2.drawRectangle({ x:20, y:curY-rowH, width:3, height:rowH, color:C.warn });
      page2.drawText(nom, { x:28, y:curY-10, size:8.5, font:helveticaBold, color:C.white });
      page2.drawText(err, { x:28, y:curY-22, size:7.5, font:helvetica, color:C.muted });
      if (hasRec) {
        page2.drawText('-> ' + truncate(r.suggestion, 80), { x:28, y:curY-34, size:7.5, font:helvetica, color:C.accent });
      }
      curY -= rowH + 4;
    });
  }

  // Recommandations
  if (curY > 160) {
    curY -= 12;
    const recH = 110;
    page2.drawRectangle({ x:20, y:curY-recH, width:W-40, height:recH, color:C.surface });
    page2.drawRectangle({ x:20, y:curY-recH+recH-2, width:W-40, height:3, color:C.blue });
    page2.drawText('RECOMMANDATIONS GENERALES - e-INVOICING 2026', { x:28, y:curY-16, size:8.5, font:helveticaBold, color:C.blue });
    const recs = [
      '1. Completer tous les SIREN (9 chiffres) en SIRET (14 chiffres) avant le 01/09/2026',
      '2. Valider les numeros de TVA intracommunautaire pour tous les fournisseurs europeens',
      '3. Eliminer les doublons fournisseurs pour eviter les rejets de factures electroniques',
      '4. Mettre a jour les donnees fournisseurs dans votre ERP ou outil comptable',
      '5. Planifier un audit de conformite tous les 6 mois',
    ];
    recs.forEach((rec, i) => {
      page2.drawText(rec, { x:28, y:curY-34-(i*13), size:7.5, font:helvetica, color:C.text });
    });
  }

  page2.drawRectangle({ x:0, y:0, width:W, height:34, color:C.surface });
  page2.drawText('Confidentiel - DataRemediation 2026 - Conformite e-Invoicing', { x:30, y:12, size:7, font:helvetica, color:C.muted });
  page2.drawText('Page 2 / 3', { x:W-58, y:12, size:7, font:helvetica, color:C.muted });

  // ══════════════════════════════════════════════════════
  // PAGE 3 — LISTE COMPLETE
  // ══════════════════════════════════════════════════════
  const page3 = pdfDoc.addPage([W, H]);
  page3.drawRectangle({ x:0, y:0, width:W, height:H, color:C.dark });
  page3.drawRectangle({ x:0, y:H-5, width:W, height:5, color:C.accent });
  page3.drawRectangle({ x:0, y:0, width:4, height:H, color:C.accent });

  page3.drawRectangle({ x:0, y:H-50, width:W, height:50, color:C.surface });
  page3.drawText('DataRemediation', { x:20, y:H-22, size:11, font:helveticaBold, color:C.accent });
  page3.drawText('LISTE COMPLETE - ' + total + ' FOURNISSEURS', { x:20, y:H-38, size:13, font:helveticaBold, color:C.white });
  page3.drawRectangle({ x:20, y:H-52, width:W-40, height:1, color:C.accent, opacity:0.3 });

  // En-tête tableau
  const colY = H - 70;
  page3.drawRectangle({ x:20, y:colY-16, width:W-40, height:20, color:C.surface });
  page3.drawRectangle({ x:20, y:colY+2, width:W-40, height:2, color:C.accent });
  page3.drawText('Fournisseur',    { x:26,  y:colY-10, size:7, font:helveticaBold, color:C.muted });
  page3.drawText('Statut',         { x:242, y:colY-10, size:7, font:helveticaBold, color:C.muted });
  page3.drawText('SIRET',          { x:308, y:colY-10, size:7, font:helveticaBold, color:C.muted });
  page3.drawText('TVA',            { x:354, y:colY-10, size:7, font:helveticaBold, color:C.muted });
  page3.drawText('Recommandation', { x:385, y:colY-10, size:7, font:helveticaBold, color:C.muted });

  let rowY = colY - 30;
  results.slice(0, 40).forEach((r, i) => {
    if (rowY < 44) return;
    const isConf  = (r.statut||'').includes('Conforme');
    const isBlock = (r.statut||'').includes('Bloquant');
    const sColor  = isConf ? C.accent : isBlock ? C.danger : C.warn;
    const statut  = isConf ? 'Conforme' : isBlock ? 'Bloquant' : 'Corriger';

    page3.drawRectangle({ x:20, y:rowY-14, width:W-40, height:18, color: i%2===0 ? C.surface : C.card });
    page3.drawRectangle({ x:20, y:rowY-14, width:2, height:18, color:sColor });

    page3.drawText(truncate(r.nom_reel || aliasMap[r.alias] || r.alias, 32), { x:26, y:rowY-8, size:6.5, font:helvetica, color:C.text });
    page3.drawText(statut, { x:242, y:rowY-8, size:6.5, font:helveticaBold, color:sColor });
    page3.drawText(r.siret_ok?'OUI':'NON', { x:308, y:rowY-8, size:6.5, font:helveticaBold, color:r.siret_ok?C.accent:C.danger });
    page3.drawText(r.tva_ok?'OUI':'NON',   { x:354, y:rowY-8, size:6.5, font:helveticaBold, color:r.tva_ok?C.accent:C.danger });
    page3.drawText(truncate(r.suggestion||'', 26), { x:385, y:rowY-8, size:5.5, font:helvetica, color:C.muted });
    rowY -= 18;
  });

  if (results.length > 40) {
    page3.drawText('... et ' + (results.length-40) + ' autres fournisseurs - voir fichier Excel pour la liste complete', {
      x:26, y:rowY+4, size:7.5, font:helvetica, color:C.muted
    });
  }

  page3.drawRectangle({ x:0, y:0, width:W, height:34, color:C.surface });
  page3.drawText('Confidentiel - DataRemediation 2026 - Conformite e-Invoicing', { x:30, y:12, size:7, font:helvetica, color:C.muted });
  page3.drawText('Page 3 / 3', { x:W-58, y:12, size:7, font:helvetica, color:C.muted });

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
      if (!['csv', 'pdf'].includes(type)) return res.status(400).json({ error: 'Type invalide' });

      const result = await queryWithTenant(req.user.tenant_id,
        `SELECT id, status FROM audit_files
         WHERE id = $1 AND tenant_id = current_setting('app.tenant_id')::text AND status = 'done'`,
        [fileId]
      );
      if (result.rows.length === 0) return res.status(404).json({ error: 'Rapport introuvable ou analyse non terminee' });

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
    try { decoded = jwt.verify(token, process.env.JWT_SECRET); }
    catch { return res.status(401).json({ error: 'Lien invalide ou expire' }); }

    if (decoded.purpose !== 'download') return res.status(401).json({ error: 'Token invalide' });

    const result = await pool.query(
      `SELECT af.original_name, af.tenant_id, ar.csv_content, ar.pdf_content, ar.summary
       FROM audit_files af
       LEFT JOIN audit_reports ar ON ar.file_id = af.id
       WHERE af.id = $1 AND af.tenant_id = $2 LIMIT 1`,
      [decoded.fileId, decoded.tenantId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Rapport introuvable' });

    const row = result.rows[0];
    const baseName = row.original_name.replace(/\.[^.]+$/, '');

    let companyName = 'N/A';
    try {
      const cr = await pool.query('SELECT company FROM users WHERE tenant_id = $1 LIMIT 1', [decoded.tenantId]);
      if (cr.rows.length > 0) companyName = cr.rows[0].company;
    } catch(e) {}

    // ── Export Excel ──────────────────────────────────────
    if (decoded.type === 'csv') {
      try {
        const summaryData = typeof row.summary === 'string' ? JSON.parse(row.summary) : row.summary;
        const results  = summaryData?.results  || [];
        const aliasMap = summaryData?.aliasMap  || {};
        const summary  = summaryData?.summary   || {};
        const wb = XLSX.utils.book_new();

        const resumeData = [
          ['RAPPORT DE CONFORMITE e-INVOICING 2026'],['DataRemediation - Confidentiel'],[],
          ['Fichier analyse', row.original_name],['Date', new Date().toLocaleDateString('fr-FR')],[],
          ['RESUME'],['Total', summary.total||results.length],['Conformes', summary.conformes||0],
          ['A corriger', summary.a_corriger||0],['Bloquants', summary.bloquants||0],
          ['Taux de conformite', (summary.taux||0)+'%'],
        ];
        const wsR = XLSX.utils.aoa_to_sheet(resumeData);
        wsR['!cols'] = [{ wch:30 },{ wch:50 }];
        XLSX.utils.book_append_sheet(wb, wsR, 'Resume');

        const headers = ['Nom fournisseur','Alias','Statut','SIRET valide','TVA valide','SIREN coherent','Erreurs','Recommandation'];
        const cols = [{ wch:35 },{ wch:12 },{ wch:15 },{ wch:14 },{ wch:12 },{ wch:16 },{ wch:40 },{ wch:60 }];
        const toRow = r => [r.nom_reel||aliasMap[r.alias]||r.alias, r.alias, r.statut||'', r.siret_ok?'OUI':'NON', r.tva_ok?'OUI':'NON', r.siren_coherent?'OUI':'NON', (r.erreurs||[]).join(' | '), r.suggestion||''];

        const wsD = XLSX.utils.aoa_to_sheet([headers, ...results.map(toRow)]);
        wsD['!cols'] = cols;
        XLSX.utils.book_append_sheet(wb, wsD, 'Fournisseurs');

        const conformes = results.filter(r => (r.statut||'').includes('Conforme'));
        if (conformes.length > 0) {
          const ws = XLSX.utils.aoa_to_sheet([headers, ...conformes.map(toRow)]);
          ws['!cols'] = cols;
          XLSX.utils.book_append_sheet(wb, ws, 'Conformes');
        }

        const nonConf = results.filter(r => !(r.statut||'').includes('Conforme'));
        if (nonConf.length > 0) {
          const ws = XLSX.utils.aoa_to_sheet([headers, ...nonConf.map(toRow)]);
          ws['!cols'] = cols;
          XLSX.utils.book_append_sheet(wb, ws, 'A corriger et Bloquants');
        }

        const buf = XLSX.write(wb, { type:'buffer', bookType:'xlsx' });
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="rapport_${baseName}.xlsx"`);
        res.setHeader('Cache-Control', 'no-store');
        return res.send(buf);
      } catch(e) {
        console.error('Erreur Excel:', e.message);
        return res.status(500).json({ error: 'Erreur generation Excel: ' + e.message });
      }
    }

    // ── Export PDF ────────────────────────────────────────
    if (decoded.type === 'pdf') {
      try {
        const summaryData = typeof row.summary === 'string' ? JSON.parse(row.summary) : row.summary;
        const pdfBuffer = await generatePDF(summaryData, row.original_name, companyName);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="rapport_conformite_${baseName}.pdf"`);
        res.setHeader('Cache-Control', 'no-store');
        return res.send(pdfBuffer);
      } catch(e) {
        console.error('Erreur PDF:', e.message, e.stack);
        return res.status(500).json({ error: 'Erreur generation PDF: ' + e.message });
      }
    }

    res.status(400).json({ error: 'Type inconnu' });
  } catch (err) {
    console.error('Erreur download:', err.message);
    next(err);
  }
});

module.exports = router;
