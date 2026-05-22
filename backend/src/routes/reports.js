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
    const logoPath = path.join(__dirname, '../assets/logo.png');
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

  // PAGE 1 — COUVERTURE
  const page1 = pdfDoc.addPage([595, 842]);
  const W = 595, H = 842;

  page1.drawRectangle({ x:0, y:0, width:W, height:H, color:C.dark });
  page1.drawRectangle({ x:0, y:H-6, width:W, height:6, color:C.accent });
  page1.drawRectangle({ x:0, y:0, width:4, height:H, color:C.accent });

  // Logo ou fallback
  if (logoImage) {
    const logoDims = logoImage.scale(0.15);
    page1.drawImage(logoImage, { x:40, y:H-55-logoDims.height, width:logoDims.width, height:logoDims.height });
    const logoRight = 40 + logoDims.width + 12;
    page1.drawText('DataRemediation', { x:logoRight, y:H-58, size:22, font:helveticaBold, color:C.white });
    page1.drawText('Agent IA Conformite Fournisseurs', { x:logoRight, y:H-76, size:9, font:helvetica, color:C.muted });
  } else {
    page1.drawRectangle({ x:40, y:H-90, width:50, height:50, color:C.accent });
    page1.drawText('DR', { x:52, y:H-72, size:20, font:helveticaBold, color:C.black });
    page1.drawText('DataRemediation', { x:100, y:H-62, size:22, font:helveticaBold, color:C.white });
    page1.drawText('Agent IA Conformite Fournisseurs', { x:100, y:H-80, size:9, font:helvetica, color:C.muted });
  }

  page1.drawRectangle({ x:40, y:H-108, width:W-80, height:1, color:C.muted, opacity:0.3 });

  page1.drawText('RAPPORT DE CONFORMITE', { x:40, y:H-150, size:28, font:helveticaBold, color:C.white });
  page1.drawText('e-INVOICING 2026', { x:40, y:H-186, size:28, font:helveticaBold, color:C.accent });

  page1.drawText('Fichier : ' + truncate(fileName, 55), { x:40, y:H-228, size:10, font:helvetica, color:C.text });
  page1.drawText('Entreprise : ' + truncate(companyName || 'N/A', 55), { x:40, y:H-245, size:10, font:helvetica, color:C.text });
  page1.drawText('Date : ' + new Date().toLocaleDateString('fr-FR', {day:'2-digit',month:'long',year:'numeric'}), { x:40, y:H-262, size:10, font:helvetica, color:C.text });

  // Score
  const scoreY = H-420;
  page1.drawRectangle({ x:40, y:scoreY, width:W-80, height:125, color:C.surface });
  page1.drawRectangle({ x:40, y:scoreY+123, width:W-80, height:3, color:C.accent });
  page1.drawText('SCORE DE CONFORMITE GLOBAL', { x:58, y:scoreY+100, size:9, font:helveticaBold, color:C.muted });

  const scoreColor = taux >= 80 ? C.accent : taux >= 50 ? C.warn : C.danger;
  page1.drawText(taux + '%', { x:58, y:scoreY+44, size:50, font:helveticaBold, color:scoreColor });

  const scoreLabel = taux >= 80 ? 'EXCELLENT' : taux >= 60 ? 'BON' : taux >= 40 ? 'MOYEN' : 'CRITIQUE';
  page1.drawText(scoreLabel, { x:175, y:scoreY+70, size:13, font:helveticaBold, color:scoreColor });
  page1.drawText('sur ' + total + ' fournisseurs analyses', { x:175, y:scoreY+52, size:10, font:helvetica, color:C.text });

  const barW = W - 215;
  page1.drawRectangle({ x:175, y:scoreY+28, width:barW, height:8, color:C.card });
  if (taux > 0) page1.drawRectangle({ x:175, y:scoreY+28, width:Math.min(barW*(taux/100), barW), height:8, color:scoreColor });

  // KPIs
  const kpiY = scoreY - 105;
  const kpis = [
    { label:'Total',      value:total,     color:'#3d8eff' },
    { label:'Conformes',  value:conformes, color:'#00e5a0' },
    { label:'A corriger', value:corriger,  color:'#ffb340' },
    { label:'Bloquants',  value:bloquants, color:'#ff4566' },
  ];
  const kpiW = (W - 120) / 4;
  kpis.forEach((k, i) => {
    const kx = 40 + i * (kpiW + 13);
    const kColor = hexToRgb(k.color);
    page1.drawRectangle({ x:kx, y:kpiY, width:kpiW, height:82, color:C.surface });
    page1.drawRectangle({ x:kx, y:kpiY+80, width:kpiW, height:2, color:kColor });
    page1.drawText(k.label.toUpperCase(), { x:kx+8, y:kpiY+62, size:7.5, font:helveticaBold, color:C.muted });
    page1.drawText(String(k.value), { x:kx+8, y:kpiY+20, size:32, font:helveticaBold, color:kColor });
  });

  // Graphique barres
  const chartY = kpiY - 180;
  page1.drawText('REPARTITION DES FOURNISSEURS', { x:40, y:chartY+152, size:9, font:helveticaBold, color:C.muted });

  const bars = [
    { label:'Conformes',  value:conformes, color:C.accent },
    { label:'A corriger', value:corriger,  color:C.warn   },
    { label:'Bloquants',  value:bloquants, color:C.danger },
  ];
  const maxVal = Math.max(conformes, corriger, bloquants, 1);
  const bW = 65, bSp = 85, bH = 100, bX = 70;

  page1.drawRectangle({ x:bX-10, y:chartY+19, width:1, height:bH+5, color:C.muted, opacity:0.3 });
  bars.forEach((b, i) => {
    const bx = bX + i*(bW+bSp);
    const bh = Math.max((b.value/maxVal)*bH, 2);
    page1.drawRectangle({ x:bx, y:chartY+20, width:bW, height:bh, color:b.color, opacity:0.9 });
    page1.drawText(String(b.value), { x:bx+bW/2-8, y:chartY+24+bh, size:11, font:helveticaBold, color:C.white });
    page1.drawText(b.label, { x:bx+bW/2-(b.label.length*2.3), y:chartY+6, size:7, font:helvetica, color:C.text });
  });
  page1.drawRectangle({ x:bX-10, y:chartY+19, width:bW*3+bSp*2+20, height:1, color:C.muted, opacity:0.4 });

  // Pied page 1
  page1.drawRectangle({ x:0, y:0, width:W, height:36, color:C.surface });
  page1.drawText('Confidentiel - DataRemediation 2026 - Conformite e-Invoicing', { x:40, y:13, size:7.5, font:helvetica, color:C.muted });
  page1.drawText('Page 1 / 3', { x:W-62, y:13, size:7.5, font:helvetica, color:C.muted });

  // PAGE 2 — ANOMALIES
  const page2 = pdfDoc.addPage([595, 842]);
  page2.drawRectangle({ x:0, y:0, width:W, height:H, color:C.dark });
  page2.drawRectangle({ x:0, y:H-6, width:W, height:6, color:C.accent });
  page2.drawRectangle({ x:0, y:0, width:4, height:H, color:C.accent });

  page2.drawText('DataRemediation', { x:40, y:H-44, size:11, font:helveticaBold, color:C.accent });
  page2.drawText('ANOMALIES DETECTEES ET RECOMMANDATIONS', { x:40, y:H-66, size:14, font:helveticaBold, color:C.white });
  page2.drawRectangle({ x:40, y:H-80, width:W-80, height:1, color:C.muted, opacity:0.3 });

  let curY = H-105;

  const bloquantsList = results.filter(r => (r.statut||'').includes('Bloquant')).slice(0, 10);
  const corrigerList  = results.filter(r => (r.statut||'').includes('corriger')).slice(0, 10);

  if (bloquantsList.length > 0) {
    page2.drawRectangle({ x:40, y:curY-20, width:W-80, height:24, color:C.surface });
    page2.drawText('FOURNISSEURS BLOQUANTS (' + bloquantsList.length + ')', { x:46, y:curY-11, size:10, font:helveticaBold, color:C.danger });
    curY -= 30;

    bloquantsList.forEach(r => {
      if (curY < 110) return;
      const nom = truncate(r.nom_reel || aliasMap[r.alias] || r.alias, 38);
      const err = truncate((r.erreurs||[]).join(' - '), 62);
      page2.drawRectangle({ x:40, y:curY-15, width:W-80, height:19, color:C.card });
      page2.drawRectangle({ x:40, y:curY-15, width:3, height:19, color:C.danger });
      page2.drawText(nom, { x:50, y:curY-7, size:8.5, font:helveticaBold, color:C.white });
      page2.drawText(err, { x:50, y:curY-19, size:7.5, font:helvetica, color:C.muted });
      if (r.suggestion) {
        page2.drawText('-> ' + truncate(r.suggestion, 78), { x:50, y:curY-30, size:7.5, font:helvetica, color:C.accent });
        curY -= 42;
      } else { curY -= 27; }
    });
  }

  curY -= 15;

  if (corrigerList.length > 0 && curY > 150) {
    page2.drawRectangle({ x:40, y:curY-20, width:W-80, height:24, color:C.surface });
    page2.drawText('FOURNISSEURS A CORRIGER (' + corrigerList.length + ')', { x:46, y:curY-11, size:10, font:helveticaBold, color:C.warn });
    curY -= 30;

    corrigerList.forEach(r => {
      if (curY < 110) return;
      const nom = truncate(r.nom_reel || aliasMap[r.alias] || r.alias, 38);
      const err = truncate((r.erreurs||[]).join(' - '), 62);
      page2.drawRectangle({ x:40, y:curY-15, width:W-80, height:19, color:C.card });
      page2.drawRectangle({ x:40, y:curY-15, width:3, height:19, color:C.warn });
      page2.drawText(nom, { x:50, y:curY-7, size:8.5, font:helveticaBold, color:C.white });
      page2.drawText(err, { x:50, y:curY-19, size:7.5, font:helvetica, color:C.muted });
      if (r.suggestion) {
        page2.drawText('-> ' + truncate(r.suggestion, 78), { x:50, y:curY-30, size:7.5, font:helvetica, color:C.accent });
        curY -= 42;
      } else { curY -= 27; }
    });
  }

  if (curY > 160) {
    curY -= 15;
    page2.drawRectangle({ x:40, y:curY-110, width:W-80, height:118, color:C.surface });
    page2.drawRectangle({ x:40, y:curY+6, width:W-80, height:3, color:C.blue });
    page2.drawText('RECOMMANDATIONS GENERALES - e-INVOICING 2026', { x:50, y:curY-14, size:9, font:helveticaBold, color:C.blue });
    const recs = [
      '1. Completer tous les SIREN (9 chiffres) en SIRET (14 chiffres) avant le 01/09/2026',
      '2. Valider les numeros de TVA intracommunautaire pour tous les fournisseurs europeens',
      '3. Eliminer les doublons fournisseurs pour eviter les rejets de factures electroniques',
      '4. Mettre a jour les donnees fournisseurs dans votre ERP ou outil comptable',
      '5. Planifier un audit de conformite tous les 6 mois',
    ];
    recs.forEach((rec, i) => {
      page2.drawText(rec, { x:50, y:curY-32-(i*14), size:8, font:helvetica, color:C.text });
    });
  }

  page2.drawRectangle({ x:0, y:0, width:W, height:36, color:C.surface });
  page2.drawText('Confidentiel - DataRemediation 2026 - Conformite e-Invoicing', { x:40, y:13, size:7.5, font:helvetica, color:C.muted });
  page2.drawText('Page 2 / 3', { x:W-62, y:13, size:7.5, font:helvetica, color:C.muted });

  // PAGE 3 — LISTE COMPLETE
  const page3 = pdfDoc.addPage([595, 842]);
  page3.drawRectangle({ x:0, y:0, width:W, height:H, color:C.dark });
  page3.drawRectangle({ x:0, y:H-6, width:W, height:6, color:C.accent });
  page3.drawRectangle({ x:0, y:0, width:4, height:H, color:C.accent });

  page3.drawText('DataRemediation', { x:40, y:H-44, size:11, font:helveticaBold, color:C.accent });
  page3.drawText('LISTE COMPLETE - ' + total + ' FOURNISSEURS', { x:40, y:H-66, size:14, font:helveticaBold, color:C.white });
  page3.drawRectangle({ x:40, y:H-80, width:W-80, height:1, color:C.muted, opacity:0.3 });

  const colY = H-100;
  page3.drawRectangle({ x:40, y:colY-14, width:W-80, height:18, color:C.surface });
  page3.drawRectangle({ x:40, y:colY+2, width:W-80, height:2, color:C.accent });
  page3.drawText('Fournisseur',    { x:46,  y:colY-8, size:7.5, font:helveticaBold, color:C.muted });
  page3.drawText('Statut',         { x:250, y:colY-8, size:7.5, font:helveticaBold, color:C.muted });
  page3.drawText('SIRET',          { x:320, y:colY-8, size:7.5, font:helveticaBold, color:C.muted });
  page3.drawText('TVA',            { x:368, y:colY-8, size:7.5, font:helveticaBold, color:C.muted });
  page3.drawText('Recommandation', { x:400, y:colY-8, size:7.5, font:helveticaBold, color:C.muted });

  let rowY = colY - 24;
  results.slice(0, 38).forEach((r, i) => {
    if (rowY < 50) return;
    const isConf  = (r.statut||'').includes('Conforme');
    const isBlock = (r.statut||'').includes('Bloquant');
    const sColor  = isConf ? C.accent : isBlock ? C.danger : C.warn;
    const statut  = isConf ? 'Conforme' : isBlock ? 'Bloquant' : 'Corriger';
    page3.drawRectangle({ x:40, y:rowY-13, width:W-80, height:17, color: i%2===0 ? C.surface : C.card });
    page3.drawRectangle({ x:40, y:rowY-13, width:2, height:17, color:sColor });
    page3.drawText(truncate(r.nom_reel || aliasMap[r.alias] || r.alias, 30), { x:46, y:rowY-7, size:7, font:helvetica, color:C.text });
    page3.drawText(statut, { x:250, y:rowY-7, size:7, font:helveticaBold, color:sColor });
    page3.drawText(r.siret_ok?'OUI':'NON', { x:320, y:rowY-7, size:7, font:helveticaBold, color:r.siret_ok?C.accent:C.danger });
    page3.drawText(r.tva_ok?'OUI':'NON',   { x:368, y:rowY-7, size:7, font:helveticaBold, color:r.tva_ok?C.accent:C.danger });
    page3.drawText(truncate(r.suggestion||'', 22), { x:400, y:rowY-7, size:6, font:helvetica, color:C.muted });
    rowY -= 18;
  });

  if (results.length > 38) {
    page3.drawText('... et ' + (results.length-38) + ' autres fournisseurs - voir fichier Excel pour la liste complete', {
      x:40, y:rowY+2, size:8, font:helvetica, color:C.muted
    });
  }

  page3.drawRectangle({ x:0, y:0, width:W, height:36, color:C.surface });
  page3.drawText('Confidentiel - DataRemediation 2026 - Conformite e-Invoicing', { x:40, y:13, size:7.5, font:helvetica, color:C.muted });
  page3.drawText('Page 3 / 3', { x:W-62, y:13, size:7.5, font:helvetica, color:C.muted });

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
        return res.status(404).json({ error: 'Rapport introuvable ou analyse non terminee' });
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
      return res.status(401).json({ error: 'Lien invalide ou expire' });
    }

    if (decoded.purpose !== 'download') {
      return res.status(401).json({ error: 'Token invalide' });
    }

    // Requête simplifiée sans JOIN complexe
    const result = await pool.query(
      `SELECT af.original_name, af.tenant_id, ar.csv_content, ar.pdf_content, ar.summary
       FROM audit_files af
       LEFT JOIN audit_reports ar ON ar.file_id = af.id
       WHERE af.id = $1 AND af.tenant_id = $2
       LIMIT 1`,
      [decoded.fileId, decoded.tenantId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Rapport introuvable' });
    }

    const row = result.rows[0];
    const baseName = row.original_name.replace(/\.[^.]+$/, '');

    // Récupérer le nom de l'entreprise séparément
    let companyName = 'N/A';
    try {
      const companyResult = await pool.query(
        'SELECT company FROM users WHERE tenant_id = $1 LIMIT 1',
        [decoded.tenantId]
      );
      if (companyResult.rows.length > 0) companyName = companyResult.rows[0].company;
    } catch(e) {
      console.log('Company non trouvee:', e.message);
    }

    // ── Export Excel ──────────────────────────────────────
    if (decoded.type === 'csv') {
      try {
        const summaryData = typeof row.summary === 'string' ? JSON.parse(row.summary) : row.summary;
        const results  = summaryData?.results  || [];
        const aliasMap = summaryData?.aliasMap  || {};
        const summary  = summaryData?.summary   || {};

        const wb = XLSX.utils.book_new();

        const resumeData = [
          ['RAPPORT DE CONFORMITE e-INVOICING 2026'],
          ['DataRemediation - Confidentiel'],
          [],
          ['Fichier analyse', row.original_name],
          ['Date de generation', new Date().toLocaleDateString('fr-FR')],
          [],
          ['RESUME'],
          ['Total fournisseurs', summary.total || results.length],
          ['Conformes',          summary.conformes  || 0],
          ['A corriger',         summary.a_corriger || 0],
          ['Bloquants',          summary.bloquants  || 0],
          ['Taux de conformite', (summary.taux || 0) + '%'],
        ];

        const wsResume = XLSX.utils.aoa_to_sheet(resumeData);
        wsResume['!cols'] = [{ wch: 30 }, { wch: 50 }];
        XLSX.utils.book_append_sheet(wb, wsResume, 'Resume');

        const headers = ['Nom fournisseur','Alias','Statut','SIRET valide','TVA valide','SIREN coherent','Erreurs','Recommandation'];
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
        wsDetail['!cols'] = [{ wch:35 },{ wch:12 },{ wch:15 },{ wch:14 },{ wch:12 },{ wch:16 },{ wch:40 },{ wch:60 }];
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
          XLSX.utils.book_append_sheet(wb, ws, 'A corriger et Bloquants');
        }

        const xlsxBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="rapport_${baseName}.xlsx"`);
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        return res.send(xlsxBuffer);

      } catch(xlsxErr) {
        console.error('Erreur Excel:', xlsxErr.message);
        return res.status(500).json({ error: 'Erreur generation Excel: ' + xlsxErr.message });
      }
    }

    // ── Export PDF ────────────────────────────────────────
    if (decoded.type === 'pdf') {
      try {
        const summaryData = typeof row.summary === 'string' ? JSON.parse(row.summary) : row.summary;
        const pdfBuffer = await generatePDF(summaryData, row.original_name, companyName);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="rapport_conformite_${baseName}.pdf"`);
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        return res.send(pdfBuffer);
      } catch(pdfErr) {
        console.error('Erreur PDF:', pdfErr.message, pdfErr.stack);
        return res.status(500).json({ error: 'Erreur generation PDF: ' + pdfErr.message });
      }
    }

    res.status(400).json({ error: 'Type inconnu' });
  } catch (err) {
    console.error('Erreur download:', err.message, err.stack);
    next(err);
  }
});

module.exports = router;
