// routes/rectification.js  Support CSV + XLSX + JSON + XML + PDF rapport
const express = require('express');
const multer  = require('multer');
const XLSX    = require('xlsx');
const path    = require('path');
const fs      = require('fs');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const { runRectificationPipeline } = require('../modules/rectification');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 },
});

// Couleurs PDF
const C = {
  dark:    rgb(6/255, 8/255, 15/255),
  surface: rgb(11/255, 14/255, 24/255),
  card:    rgb(15/255, 18/255, 32/255),
  accent:  rgb(0/255, 229/255, 160/255),
  blue:    rgb(61/255, 142/255, 255/255),
  warn:    rgb(255/255, 179/255, 64/255),
  danger:  rgb(255/255, 69/255, 102/255),
  green:   rgb(34/255, 197/255, 94/255),
  white:   rgb(1, 1, 1),
  black:   rgb(0, 0, 0),
  text:    rgb(200/255, 212/255, 238/255),
  muted:   rgb(74/255, 88/255, 120/255),
  purple:  rgb(139/255, 92/255, 246/255),
};

function s(str) {
  if (!str) return '';
  return String(str)
    .replace(/[\u00e0\u00e2\u00e4\u00e1]/g,'a').replace(/[\u00e9\u00e8\u00ea\u00eb]/g,'e')
    .replace(/[\u00ee\u00ef\u00ed]/g,'i').replace(/[\u00f4\u00f6\u00f3]/g,'o')
    .replace(/[\u00f9\u00fb\u00fc\u00fa]/g,'u').replace(/[\u00e7]/g,'c')
    .replace(/[\u00c9\u00c8\u00ca]/g,'E').replace(/[\u00c0\u00c2]/g,'A')
    .replace(/[\u2019\u2018]/g,"'").replace(/[\u2013\u2014]/g,'-')
    .replace(/[^\x00-\x7F]/g,'');
}

function t(str, max) {
  const c = s(str);
  return c.length > max ? c.slice(0, max) + '...' : c;
}

function drawHeader(page, hB, h, logoImage, title, pageNum, total, W, H) {
  page.drawRectangle({ x:0, y:0, width:W, height:H, color:C.dark });
  page.drawRectangle({ x:0, y:H-5, width:W, height:5, color:C.accent });
  page.drawRectangle({ x:0, y:0, width:4, height:H, color:C.accent });
  const hH = 48;
  page.drawRectangle({ x:0, y:H-hH, width:W, height:hH, color:C.surface });
  if (logoImage) {
    const dims = logoImage.scaleToFit(36,36);
    page.drawImage(logoImage, { x:14, y:H-hH/2-dims.height/2, width:dims.width, height:dims.height });
    page.drawText('DataRemediation', { x:14+dims.width+8, y:H-hH/2+4, size:11, font:hB, color:C.white });
    page.drawText('Conformite Fournisseurs & Facturation Electronique 2026', { x:14+dims.width+8, y:H-hH/2-7, size:6.5, font:h, color:C.muted });
  } else {
    page.drawRectangle({ x:14, y:H-hH+6, width:34, height:34, color:C.accent });
    page.drawText('DR', { x:22, y:H-hH+16, size:13, font:hB, color:C.black });
    page.drawText('DataRemediation', { x:56, y:H-hH+22, size:11, font:hB, color:C.white });
  }
  page.drawText(s(title), { x:W-180, y:H-26, size:8, font:hB, color:C.muted });
  page.drawRectangle({ x:18, y:H-hH-1, width:W-36, height:1, color:C.accent, opacity:0.3 });
  page.drawRectangle({ x:0, y:0, width:W, height:28, color:C.surface });
  page.drawText('Rapport de Conformite Fournisseurs - Facturation Electronique 2026 - Confidentiel', { x:28, y:9, size:6, font:h, color:C.muted });
  page.drawText('Page ' + pageNum + ' / ' + total, { x:W-50, y:9, size:6, font:h, color:C.muted });
}

async function generateRectificationPDF(rapport, donneesCorrigees, nomFichier, companyName) {
  const pdfDoc = await PDFDocument.create();
  const hB     = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const h      = await pdfDoc.embedFont(StandardFonts.Helvetica);

  let logoImage = null;
  try {
    const logoPath = path.join(__dirname, '../logo.png');
    if (fs.existsSync(logoPath)) logoImage = await pdfDoc.embedPng(fs.readFileSync(logoPath));
  } catch(e) {}

  const stats      = rapport.statistiques    || {};
  const score      = rapport.score_qualite   || {};
  const scoreCateg = rapport.score_par_categorie || {};
  const risquePDP  = rapport.risque_pdp      || {};
  const roi        = rapport.roi             || {};
  const planAction = rapport.plan_action     || [];
  const details    = rapport.details         || [];
  const meta       = rapport.meta            || {};
  const typeFichier = meta.type_fichier || 'fournisseurs';

  const niveauColor = risquePDP.niveau === 'CRITIQUE' ? C.danger :
                      risquePDP.niveau === 'ELEVE' ? C.warn :
                      risquePDP.niveau === 'MODERE' ? C.blue : C.green;
  const scoreColor  = score.valeur >= 70 ? C.green : score.valeur >= 40 ? C.warn : C.danger;

  // Score apres remediation estime
  const scoreApres = Math.min(100, Math.round(score.valeur + (stats.corriges / Math.max(stats.total,1)) * 100 * 0.6));

  const W = 595, H = 842, TP = 4;

  // 
  // PAGE 1  RESUME EXECUTIF
  // 
  const p1 = pdfDoc.addPage([W, H]);
  drawHeader(p1, hB, h, logoImage, 'RESUME EXECUTIF', 1, TP, W, H);

  let y = H - 68;

  // Titre
  p1.drawText('RAPPORT DE CONFORMITE FOURNISSEURS', { x:28, y, size:14, font:hB, color:C.white });
  y -= 14;
  p1.drawText('Facturation Electronique 2026 - e-Invoicing PDP', { x:28, y, size:8, font:h, color:C.accent });
  y -= 10;
  p1.drawText('Fichier : ' + t(nomFichier,50) + '   |   Entreprise : ' + t(companyName||'N/A',30) + '   |   ' + new Date().toLocaleDateString('fr-FR'), { x:28, y, size:7, font:h, color:C.muted });
  y -= 22;

  // Bloc score + risque
  p1.drawRectangle({ x:18, y:y-88, width:W-36, height:92, color:C.surface });
  p1.drawRectangle({ x:18, y:y+2, width:W-36, height:3, color:scoreColor });

  // Score
  p1.drawText('SCORE CONFORMITE', { x:32, y:y-14, size:7, font:hB, color:C.muted });
  p1.drawText(score.valeur + '/100', { x:32, y:y-50, size:36, font:hB, color:scoreColor });
  p1.drawText(s(score.mention||''), { x:32, y:y-66, size:9, font:hB, color:scoreColor });

  p1.drawRectangle({ x:155, y:y-82, width:1, height:80, color:C.muted, opacity:0.3 });

  // Risque PDP
  p1.drawText('RISQUE PDP', { x:165, y:y-14, size:7, font:hB, color:C.muted });
  p1.drawText(s(risquePDP.niveau||'N/A'), { x:165, y:y-32, size:14, font:hB, color:niveauColor });
  p1.drawText(t(risquePDP.description||'',55), { x:165, y:y-46, size:7, font:h, color:C.text });
  p1.drawText(t(risquePDP.impact||'',55), { x:165, y:y-58, size:7, font:h, color:C.warn });
  p1.drawText('Conformite PDP : ' + (risquePDP.score_conformite_pdp||0) + '%', { x:165, y:y-72, size:7.5, font:hB, color:niveauColor });

  p1.drawRectangle({ x:376, y:y-82, width:1, height:80, color:C.muted, opacity:0.3 });

  // ROI
  p1.drawText('TEMPS ECONOMISE', { x:386, y:y-14, size:7, font:hB, color:C.muted });
  p1.drawText('Manuel : ' + (roi.temps_manuel_h||0) + 'h', { x:386, y:y-28, size:8, font:h, color:C.warn });
  p1.drawText('Automatise : ' + (roi.temps_automatise_min||0) + ' min', { x:386, y:y-40, size:8, font:h, color:C.accent });
  p1.drawText('Gain estime : ' + (roi.cout_manuel_eur||0) + ' EUR', { x:386, y:y-54, size:8, font:hB, color:C.accent });
  p1.drawText('Correction auto : ' + (stats.taux_correction||0) + '%', { x:386, y:y-68, size:7.5, font:h, color:C.blue });

  y -= 102;

  // Tableau KPIs
  const kpis = [
    { label:'Analyses',    value:stats.total||0,    color:'#3d8eff' },
    { label:'Conformes',   value:stats.valides||0,   color:'#00e5a0' },
    { label:'Corriges',    value:stats.corriges||0,  color:'#ffb340' },
    { label:'Anomalies',   value:stats.erreurs||0,   color:'#ff4566' },
  ];
  const kW = (W-48)/4;
  kpis.forEach((k, i) => {
    const kx = 18 + i*(kW+5);
    const kC = rgb(parseInt(k.color.slice(1,3),16)/255, parseInt(k.color.slice(3,5),16)/255, parseInt(k.color.slice(5,7),16)/255);
    p1.drawRectangle({ x:kx, y:y-68, width:kW, height:70, color:C.surface });
    p1.drawRectangle({ x:kx, y:y+1, width:kW, height:2, color:kC });
    p1.drawText(k.label.toUpperCase(), { x:kx+8, y:y-14, size:6.5, font:hB, color:C.muted });
    p1.drawText(String(k.value), { x:kx+8, y:y-46, size:26, font:hB, color:kC });
  });
  y -= 80;

  // Impacts
  y -= 12;
  p1.drawRectangle({ x:18, y:y-62, width:W-36, height:66, color:C.surface });
  p1.drawRectangle({ x:18, y:y+2, width:W-36, height:3, color:C.danger });
  p1.drawText('IMPACTS IDENTIFIES', { x:28, y:y-14, size:8, font:hB, color:C.danger });

  const impacts = [
    risquePDP.fournisseurs_bloquants > 0 ? risquePDP.fournisseurs_bloquants + ' fournisseurs susceptibles de provoquer un rejet PDP' : null,
    stats.sans_tva > 0 ? stats.sans_tva + ' fournisseurs sans TVA intracommunautaire valide' : null,
    'Risque d\'echec des echanges avec la Plateforme de Dematerialisation Partenaire (PDP)',
  ].filter(Boolean);

  impacts.forEach((imp, i) => {
    p1.drawText('  - ' + t(imp, 85), { x:28, y:y-28-(i*14), size:7.5, font:h, color:C.text });
  });
  y -= 76;

  // Score de preparation avant/apres
  y -= 12;
  p1.drawRectangle({ x:18, y:y-88, width:W-36, height:92, color:C.surface });
  p1.drawRectangle({ x:18, y:y+2, width:W-36, height:3, color:C.blue });
  p1.drawText('SCORE DE PREPARATION FACTURATION ELECTRONIQUE 2026', { x:28, y:y-14, size:8, font:hB, color:C.blue });

  const barW = W - 200;
  const barData = [
    { label:'Avant remediation', value:score.valeur, color:scoreColor },
    { label:'Apres remediation', value:scoreApres,   color:C.accent  },
    { label:'Objectif recommande', value:95,         color:C.green   },
  ];
  barData.forEach((b, i) => {
    const by = y - 34 - i*22;
    p1.drawText(b.label, { x:28, y:by, size:7, font:h, color:C.muted });
    p1.drawRectangle({ x:155, y:by-4, width:barW, height:10, color:C.card });
    p1.drawRectangle({ x:155, y:by-4, width:Math.min(barW*(b.value/100),barW), height:10, color:b.color });
    p1.drawText(b.value+'%', { x:155+barW+6, y:by, size:8, font:hB, color:b.color });
  });

  // 
  // PAGE 2  SCORES PAR CATEGORIE + CORRECTIONS
  // 
  const p2 = pdfDoc.addPage([W, H]);
  drawHeader(p2, hB, h, logoImage, 'CORRECTIONS EFFECTUEES', 2, TP, W, H);

  y = H - 68;

  // Score par categorie
  p2.drawText('SCORE PAR CATEGORIE', { x:28, y, size:11, font:hB, color:C.white });
  p2.drawText('Ou agir en priorite pour la conformite e-Invoicing 2026', { x:28, y:y-14, size:7.5, font:h, color:C.muted });
  y -= 28;

  const cats = Object.entries(scoreCateg);
  cats.forEach(([key, cat], i) => {
    const cy    = y - i*46;
    const cVal  = cat.score || 0;
    const cC    = cVal >= 80 ? C.green : cVal >= 50 ? C.warn : C.danger;
    p2.drawRectangle({ x:18, y:cy-38, width:W-36, height:40, color:C.surface });
    p2.drawRectangle({ x:18, y:cy-38, width:3, height:40, color:cC });
    p2.drawText(s(cat.libelle||key), { x:28, y:cy-12, size:8.5, font:hB, color:C.text });
    p2.drawText(s(cat.priorite||''), { x:28, y:cy-26, size:7, font:h, color:cC });
    p2.drawText(cVal+'%', { x:W-74, y:cy-20, size:17, font:hB, color:cC });
    const bw2 = W-200;
    p2.drawRectangle({ x:155, y:cy-24, width:bw2, height:8, color:C.card });
    p2.drawRectangle({ x:155, y:cy-24, width:Math.min(bw2*(cVal/100),bw2), height:8, color:cC });
    y -= 46;
  });

  y -= 16;

  // Tableau corrections effectuees
  const correctionsFaites = details.filter(d => d.corrections && d.corrections.length > 0);
  p2.drawText('CORRECTIONS EFFECTUEES (' + correctionsFaites.reduce((a,d)=>a+d.corrections.length,0) + ')', { x:28, y, size:10, font:hB, color:C.white });
  p2.drawText('Ce que DataRemediation a corrige automatiquement', { x:28, y:y-13, size:7.5, font:h, color:C.muted });
  y -= 26;

  // Header tableau
  p2.drawRectangle({ x:18, y:y-14, width:W-36, height:16, color:C.surface });
  p2.drawRectangle({ x:18, y:y, width:W-36, height:2, color:C.accent });
  p2.drawText('FOURNISSEUR',    { x:24,  y:y-10, size:6.5, font:hB, color:C.muted });
  p2.drawText('CHAMP',          { x:180, y:y-10, size:6.5, font:hB, color:C.muted });
  p2.drawText('VALEUR INITIALE',{ x:235, y:y-10, size:6.5, font:hB, color:C.muted });
  p2.drawText('VALEUR CORRIGEE',{ x:355, y:y-10, size:6.5, font:hB, color:C.muted });
  p2.drawText('CONFIANCE',      { x:475, y:y-10, size:6.5, font:hB, color:C.muted });
  y -= 18;

  let rowCount = 0;
  for (const d of correctionsFaites) {
    const nom = t(d.donnees_originales?.denomination || d.donnees_originales?.Denomination ||
                  d.donnees_originales?.raison_sociale || d.donnees_originales?.nom || 'Ligne '+(d.index+1), 22);
    for (const c of d.corrections) {
      if (y < 50 || rowCount > 28) break;
      const conf = parseFloat(String(c.confiance).replace('%','')) || 0;
      const confColor = conf >= 90 ? C.green : conf >= 70 ? C.accent : C.warn;
      p2.drawRectangle({ x:18, y:y-14, width:W-36, height:16, color:rowCount%2===0?C.surface:C.card });
      p2.drawRectangle({ x:18, y:y-14, width:2, height:16, color:C.accent });
      p2.drawText(nom,                    { x:24,  y:y-9, size:6.5, font:hB, color:C.text });
      p2.drawText(s(c.champ||''),         { x:180, y:y-9, size:6.5, font:h,  color:C.muted });
      p2.drawText(t(c.avant||'',18),      { x:235, y:y-9, size:6.5, font:h,  color:C.danger });
      p2.drawText(t(c.apres||'',18),      { x:355, y:y-9, size:6.5, font:hB, color:C.accent });
      p2.drawText(s(c.confiance||''),     { x:475, y:y-9, size:6.5, font:hB, color:confColor });
      y -= 16;
      rowCount++;
    }
    if (y < 50 || rowCount > 28) break;
  }

  if (correctionsFaites.length === 0) {
    p2.drawRectangle({ x:18, y:y-32, width:W-36, height:34, color:C.surface });
    p2.drawText('Aucune correction automatique effectuee sur ce fichier.', { x:28, y:y-18, size:8, font:h, color:C.muted });
    y -= 44;
  }

  // 
  // PAGE 3  ANOMALIES RESTANTES
  // 
  const p3 = pdfDoc.addPage([W, H]);
  drawHeader(p3, hB, h, logoImage, 'ANOMALIES RESTANTES', 3, TP, W, H);

  y = H - 68;
  const anomaliesRestantes = details.filter(d =>
    d.statut === 'ANOMALIE' || d.statut === 'ERREUR_RECTIFICATION'
  );

  p3.drawText('ANOMALIES NECESSITANT UNE INTERVENTION MANUELLE (' + anomaliesRestantes.length + ')', { x:28, y, size:10, font:hB, color:C.white });
  p3.drawText('Ce que DataRemediation ne peut pas corriger automatiquement', { x:28, y:y-13, size:7.5, font:h, color:C.muted });
  y -= 28;

  // Header
  p3.drawRectangle({ x:18, y:y-14, width:W-36, height:16, color:C.surface });
  p3.drawRectangle({ x:18, y:y, width:W-36, height:2, color:C.danger });
  p3.drawText('FOURNISSEUR',       { x:24,  y:y-10, size:6.5, font:hB, color:C.muted });
  p3.drawText('ANOMALIE',          { x:200, y:y-10, size:6.5, font:hB, color:C.muted });
  p3.drawText('ACTION RECOMMANDEE',{ x:340, y:y-10, size:6.5, font:hB, color:C.muted });
  y -= 18;

  const actionsMap = {
    'siret_MANQUANT':    'Demander extrait KBIS ou rechercher sur data.gouv.fr',
    'siret_INVALIDE':    'Verifier le SIRET (14 chiffres) sur societe.com',
    'tva_MANQUANT':      'Contacter le fournisseur pour obtenir son N TVA',
    'tva_INVALIDE':      'Verifier format : FR + 2 car. + 9 chiffres',
    'adresse_MANQUANT':  'Completer l\'adresse complete du fournisseur',
    'email_INVALIDE':    'Corriger l\'email (format invalide)',
    'iban_INVALIDE':     'Verifier le RIB / IBAN aupres du fournisseur',
    'denomination_MANQUANT': 'Renseigner la raison sociale complete',
  };

  rowCount = 0;
  for (const d of anomaliesRestantes) {
    if (y < 50 || rowCount > 32) break;
    const nom = t(d.donnees_originales?.denomination || d.donnees_originales?.Denomination ||
                  d.donnees_originales?.raison_sociale || d.donnees_originales?.nom || 'Ligne '+(d.index+1), 24);

    for (const a of (d.anomalies||[])) {
      if (y < 50 || rowCount > 32) break;
      const key    = a.champ + '_' + a.type;
      const action = actionsMap[key] || 'Verification manuelle requise';
      p3.drawRectangle({ x:18, y:y-14, width:W-36, height:16, color:rowCount%2===0?C.surface:C.card });
      p3.drawRectangle({ x:18, y:y-14, width:2, height:16, color:C.danger });
      p3.drawText(nom,                   { x:24,  y:y-9, size:6.5, font:hB, color:C.text });
      p3.drawText(s(a.champ+' - '+a.type),{ x:200, y:y-9, size:6.5, font:h,  color:C.warn });
      p3.drawText(t(action,30),          { x:340, y:y-9, size:6.5, font:h,  color:C.accent });
      y -= 16;
      rowCount++;
    }
  }

  if (anomaliesRestantes.length === 0) {
    p3.drawRectangle({ x:18, y:y-32, width:W-36, height:34, color:C.surface });
    p3.drawText('Aucune anomalie restante  toutes les corrections ont ete effectuees.', { x:28, y:y-18, size:8, font:h, color:C.green });
    y -= 44;
  }

  // 
  // PAGE 4  VALORISATION + PLAN D'ACTION
  // 
  const p4 = pdfDoc.addPage([W, H]);
  drawHeader(p4, hB, h, logoImage, 'VALORISATION & PLAN D\'ACTION', 4, TP, W, H);

  y = H - 68;

  // ROI detaille
  p4.drawText('VALORISATION FINANCIERE', { x:28, y, size:11, font:hB, color:C.white });
  p4.drawText('Estimation du gain apporte par DataRemediation', { x:28, y:y-13, size:7.5, font:h, color:C.muted });
  y -= 28;

  p4.drawRectangle({ x:18, y:y-80, width:W-36, height:84, color:C.surface });
  p4.drawRectangle({ x:18, y:y+2, width:W-36, height:3, color:C.accent });

  // Detail ROI
  const roiRows = [
    { label:'Anomalies detectees',        value: stats.anomalies + ' fournisseurs',    color:'#ffb340' },
    { label:'Temps moyen par anomalie',   value: '8 minutes',                          color:'#94a3b8' },
    { label:'Temps total manuel estime',  value: (roi.temps_manuel_h||0) + ' heures',  color:'#ffb340' },
    { label:'Temps DataRemediation',      value: (roi.temps_automatise_min||0) + ' minutes', color:'#00e5a0' },
    { label:'Gain financier estime',      value: (roi.cout_manuel_eur||0) + ' EUR (base 55 EUR/h)', color:'#00e5a0' },
    { label:'Gain evitement rejets PDP',  value: (roi.gain_rejets_eur||0) + ' EUR',    color:'#00e5a0' },
  ];

  p4.drawRectangle({ x:18, y:y-14, width:W-36, height:16, color:C.card });
  p4.drawText('INDICATEUR', { x:28, y:y-10, size:6.5, font:hB, color:C.muted });
  p4.drawText('VALEUR', { x:W-120, y:y-10, size:6.5, font:hB, color:C.muted });
  y -= 16;

  roiRows.forEach((row, i) => {
    const rC = rgb(parseInt(row.color.slice(1,3),16)/255, parseInt(row.color.slice(3,5),16)/255, parseInt(row.color.slice(5,7),16)/255);
    p4.drawRectangle({ x:18, y:y-13, width:W-36, height:14, color:i%2===0?C.surface:C.card });
    p4.drawText(row.label, { x:28, y:y-9, size:7.5, font:h, color:C.text });
    p4.drawText(s(row.value), { x:W-140, y:y-9, size:7.5, font:hB, color:rC });
    y -= 14;
  });

  y -= 20;

  // Plan d'action
  p4.drawText('PLAN D\'ACTION RECOMMANDE', { x:28, y, size:11, font:hB, color:C.white });
  p4.drawText('Actions prioritaires pour atteindre 95% de conformite', { x:28, y:y-13, size:7.5, font:h, color:C.muted });
  y -= 28;

  planAction.forEach((action, i) => {
    if (y < 60) return;
    const pC = action.priorite === 'CRITIQUE' ? C.danger :
               action.priorite === 'ELEVE'    ? C.warn :
               action.priorite === 'MODERE'   ? C.blue : C.muted;
    const rH = 54;
    p4.drawRectangle({ x:18, y:y-rH, width:W-36, height:rH, color:C.surface });
    p4.drawRectangle({ x:18, y:y-rH, width:3, height:rH, color:pC });
    p4.drawText(s(action.priorite||''), { x:26, y:y-12, size:6.5, font:hB, color:pC });
    p4.drawText(s(action.action||''), { x:26, y:y-24, size:8.5, font:hB, color:C.text });
    p4.drawText(t(action.detail||'', 90), { x:26, y:y-36, size:7, font:h, color:C.muted });
    p4.drawText('Delai : ' + s(action.delai||''), { x:26, y:y-48, size:6.5, font:h, color:C.accent });
    y -= rH + 6;
  });

  return Buffer.from(await pdfDoc.save());
}

//  POST /api/rectification/analyser 
router.post('/analyser', upload.single('fichier'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier fourni.' });

    const { buffer, mimetype, originalname } = req.file;
    const ext = (originalname.split('.').pop() || '').toLowerCase();

    if (!['csv','xlsx','xls','json','xml'].includes(ext)) {
      return res.status(400).json({ error: 'Format non supporte : .' + ext });
    }

    let effectiveMime = mimetype;
    if (ext === 'xlsx' || ext === 'xls') effectiveMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    else if (ext === 'csv')  effectiveMime = 'text/csv';
    else if (ext === 'json') effectiveMime = 'application/json';
    else if (ext === 'xml')  effectiveMime = 'application/xml';

    const result = await runRectificationPipeline(buffer, effectiveMime, originalname);

    return res.status(200).json({
      success:          true,
      rapport:          result.rapport,
      donnees_corrigees: result.donnees_corrigees,
    });
  } catch (err) {
    console.error('[Route rectification]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

//  POST /api/rectification/export-pdf 
router.post('/export-pdf', express.json({ limit: '20mb' }), async (req, res) => {
  try {
    const { rapport, donnees_corrigees, nomFichier, companyName } = req.body;
    if (!rapport) return res.status(400).json({ error: 'Donnees manquantes.' });

    const pdfBuffer = await generateRectificationPDF(
      rapport, donnees_corrigees || [], nomFichier || 'rectification', companyName || ''
    );

    const baseName = (nomFichier||'rectification').replace(/\.[^.]+$/,'');
    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="conformite_' + baseName + '.pdf"');
    res.setHeader('Cache-Control','no-store');
    return res.send(pdfBuffer);
  } catch (err) {
    console.error('[Export PDF rectification]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

//  POST /api/rectification/export-excel 
router.post('/export-excel', express.json({ limit: '20mb' }), async (req, res) => {
  try {
    const { rapport, donnees_corrigees, nomFichier } = req.body;
    if (!donnees_corrigees || !rapport) return res.status(400).json({ error: 'Donnees manquantes.' });

    const stats = rapport.statistiques  || {};
    const score = rapport.score_qualite || {};
    const meta  = rapport.meta          || {};
    const roi   = rapport.roi           || {};
    const wb    = XLSX.utils.book_new();

    const resumeData = [
      ['RAPPORT DE CONFORMITE FOURNISSEURS - DataRemediation'],
      ['Facturation Electronique 2026 - e-Invoicing PDP'],
      [],
      ['Fichier', meta.fichier || nomFichier || ''],
      ['Date',    new Date(meta.date_analyse || Date.now()).toLocaleString('fr-FR')],
      ['Type',    meta.type_fichier || 'fournisseurs'],
      [],
      ['SCORE QUALITE', (score.valeur||0) + '/100', score.mention||''],
      [],
      ['STATISTIQUES'],
      ['Total analyses',    stats.total||0],
      ['Conformes',         stats.valides||0],
      ['Corriges auto',     stats.corriges||0],
      ['Anomalies restantes', stats.erreurs||0],
      ['Sans SIRET',        stats.sans_siret||0],
      ['Sans TVA',          stats.sans_tva||0],
      ['Sans adresse',      stats.sans_adresse||0],
      [],
      ['VALORISATION'],
      ['Temps manuel estime',    (roi.temps_manuel_h||0) + ' heures'],
      ['Temps automatise',       (roi.temps_automatise_min||0) + ' minutes'],
      ['Gain financier estime',  (roi.cout_manuel_eur||0) + ' EUR'],
      ['Gain evitement rejets',  (roi.gain_rejets_eur||0) + ' EUR'],
    ];
    const wsR = XLSX.utils.aoa_to_sheet(resumeData);
    wsR['!cols'] = [{wch:30},{wch:50}];
    XLSX.utils.book_append_sheet(wb, wsR, 'Resume');

    if (donnees_corrigees.length > 0) {
      const headers = Object.keys(donnees_corrigees[0]);
      const rows    = donnees_corrigees.map(r => headers.map(h2 => r[h2]??''));
      const wsD     = XLSX.utils.aoa_to_sheet([headers, ...rows]);
      wsD['!cols']  = headers.map(()=>({wch:20}));
      XLSX.utils.book_append_sheet(wb, wsD, 'Donnees corrigees');
    }

    const details     = rapport.details || [];
    const corrDetails = details
      .filter(d=>d.corrections&&d.corrections.length>0)
      .flatMap(d=>d.corrections.map(c=>({
        'Fournisseur': d.donnees_originales?.denomination || d.donnees_originales?.Denomination || d.donnees_originales?.nom || 'Ligne '+(d.index+1),
        'Champ':c.champ,'Avant':c.avant,'Apres':c.apres,
        'Confiance':c.confiance,'Justification':c.justification||''
      })));
    if (corrDetails.length > 0) {
      const wsC = XLSX.utils.json_to_sheet(corrDetails);
      wsC['!cols'] = [{wch:30},{wch:16},{wch:28},{wch:28},{wch:12},{wch:50}];
      XLSX.utils.book_append_sheet(wb, wsC, 'Corrections effectuees');
    }

    const anomalies = details
      .filter(d=>d.anomalies&&d.anomalies.length>0)
      .flatMap(d=>d.anomalies.map(a=>({
        'Fournisseur': d.donnees_originales?.denomination || d.donnees_originales?.Denomination || d.donnees_originales?.nom || 'Ligne '+(d.index+1),
        'Champ':a.champ,'Type':a.type,'Valeur':a.valeur||'','Statut':d.statut
      })));
    if (anomalies.length > 0) {
      const wsA = XLSX.utils.json_to_sheet(anomalies);
      wsA['!cols'] = [{wch:30},{wch:16},{wch:18},{wch:28},{wch:14}];
      XLSX.utils.book_append_sheet(wb, wsA, 'Anomalies restantes');
    }

    const buf = XLSX.write(wb, {type:'buffer', bookType:'xlsx'});
    const baseName = (nomFichier||'rectification').replace(/\.[^.]+$/,'');
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition','attachment; filename="conformite_'+baseName+'.xlsx"');
    res.setHeader('Cache-Control','no-store');
    return res.send(buf);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

//  GET /api/rectification/ping 
router.get('/ping', (req, res) => res.json({ status:'ok', module:'rectification' }));

module.exports = router;
