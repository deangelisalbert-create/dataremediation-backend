// routes/reports.js - Rapport PDF DataRemediation v4 - ASCII only
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
  purple:  rgb(139/255, 92/255, 246/255),
  green:   rgb(34/255, 197/255, 94/255),
};

const CATEGORIES_DEPENSES = [
  'transport', 'taxi', 'peage', 'hotel', 'restaurant', 'parking',
  'repas', 'carburant', 'frais', 'autre', 'divers', 'note de frais',
  'kilometrique', 'kilometriques', 'airbnb', 'booking', 'easy-jet',
  'easyjet', 'bulletin', 'salaire',
];

const ENSEIGNES_PONCTUELLES = [
  'leroy merlin', 'leroymerlin', 'castorama', 'brico depot', 'bricodepot',
  'point p', 'intermarche', 'intermarché', 'leclerc', 'carrefour', 'auchan',
  'lidl', 'aldi', 'super u', 'casino', 'monoprix', 'metro', 'promocash',
  'totalenergies', 'total energies', 'bp', 'shell', 'esso',
  'amazon', 'fnac', 'darty', 'boulanger', 'ikea', 'conforama',
  'mcdonald', 'mcdo', 'burger king', 'kfc', 'flunch',
];

function isCategorieDep(nom) {
  if (!nom) return false;
  const n = nom.toLowerCase().trim();
  return CATEGORIES_DEPENSES.some(c => n.includes(c));
}

function isEnseignePonctuelle(nom) {
  if (!nom) return false;
  const n = nom.toLowerCase().trim();
  return ENSEIGNES_PONCTUELLES.some(e => n.includes(e));
}

function isExclu(nom) {
  return isCategorieDep(nom) || isEnseignePonctuelle(nom);
}

function hexToRgb(hex) {
  const r = parseInt(hex.slice(1,3),16)/255;
  const g = parseInt(hex.slice(3,5),16)/255;
  const b = parseInt(hex.slice(5,7),16)/255;
  return rgb(r,g,b);
}

function s(str) {
  if (str === null || str === undefined) return '';
  str = String(str);
  return str
    .replace(/[\u00e0\u00e2\u00e4\u00e1\u00e3\u00e5]/g, 'a')
    .replace(/[\u00e9\u00e8\u00ea\u00eb]/g, 'e')
    .replace(/[\u00ee\u00ef\u00ed\u00ec]/g, 'i')
    .replace(/[\u00f4\u00f6\u00f3\u00f2\u00f5]/g, 'o')
    .replace(/[\u00f9\u00fb\u00fc\u00fa]/g, 'u')
    .replace(/[\u00e7]/g, 'c')
    .replace(/[\u00f1]/g, 'n')
    .replace(/[\u00c0\u00c2\u00c4\u00c1\u00c3]/g, 'A')
    .replace(/[\u00c9\u00c8\u00ca\u00cb]/g, 'E')
    .replace(/[\u00ce\u00cf\u00cd]/g, 'I')
    .replace(/[\u00d4\u00d6\u00d3]/g, 'O')
    .replace(/[\u00d9\u00db\u00dc\u00da]/g, 'U')
    .replace(/[\u00c7]/g, 'C')
    .replace(/[\u00d1]/g, 'N')
    .replace(/[\u2019\u2018]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[^\x00-\x7F]/g, '');
}

function t(str, max) {
  const clean = s(str);
  return clean.length > max ? clean.slice(0, max) + '...' : clean;
}

function drawPageHeader(page, hB, h, logoImage, title, pageNum, total, W, H) {
  page.drawRectangle({ x:0, y:0, width:W, height:H, color:C.dark });
  page.drawRectangle({ x:0, y:H-5, width:W, height:5, color:C.accent });
  page.drawRectangle({ x:0, y:0, width:4, height:H, color:C.accent });
  const hH = 50;
  page.drawRectangle({ x:0, y:H-hH, width:W, height:hH, color:C.surface });
  if (logoImage) {
    const dims = logoImage.scaleToFit(38, 38);
    page.drawImage(logoImage, { x:16, y:H-hH/2-dims.height/2, width:dims.width, height:dims.height });
    page.drawText('DataRemediation', { x:16+dims.width+8, y:H-hH/2+5, size:12, font:hB, color:C.white });
    page.drawText('Agent IA Conformite Fournisseurs', { x:16+dims.width+8, y:H-hH/2-7, size:7, font:h, color:C.muted });
  } else {
    page.drawRectangle({ x:16, y:H-hH+6, width:36, height:36, color:C.accent });
    page.drawText('DR', { x:24, y:H-hH+18, size:14, font:hB, color:C.black });
    page.drawText('DataRemediation', { x:60, y:H-hH+24, size:12, font:hB, color:C.white });
  }
  page.drawText(s(title), { x:W-Math.min(s(title).length*5+20, 300), y:H-28, size:9, font:hB, color:C.muted });
  page.drawRectangle({ x:20, y:H-hH-1, width:W-40, height:1, color:C.accent, opacity:0.3 });
  page.drawRectangle({ x:0, y:0, width:W, height:30, color:C.surface });
  page.drawText('Confidentiel - DataRemediation 2026 - Conformite e-Invoicing', { x:30, y:10, size:6.5, font:h, color:C.muted });
  page.drawText('Page ' + pageNum + ' / ' + total, { x:W-54, y:10, size:6.5, font:h, color:C.muted });
}

async function generatePDF(summaryData, fileName, companyName) {
  const pdfDoc = await PDFDocument.create();
  const hB     = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const h      = await pdfDoc.embedFont(StandardFonts.Helvetica);

  let logoImage = null;
  try {
    const logoPath = path.join(__dirname, '../logo.png');
    if (fs.existsSync(logoPath)) logoImage = await pdfDoc.embedPng(fs.readFileSync(logoPath));
  } catch(e) {}

  const results  = summaryData?.results  || [];
  const summary  = summaryData?.summary  || {};
  const aliasMap = summaryData?.aliasMap || {};

  const total     = summary.total     || results.length;
  const conformes = summary.conformes  || results.filter(r=>(r.statut||'').includes('Conforme')).length;
  const corriger  = summary.a_corriger || results.filter(r=>(r.statut||'').includes('corriger')).length;
  const bloquants = summary.bloquants  || results.filter(r=>(r.statut||'').includes('Bloquant')).length;
  const taux      = summary.taux       || (total > 0 ? Math.round(conformes/total*100) : 0);

  // Séparation exclus / fournisseurs réels
  const exclus            = results.filter(r => isExclu(r.nom_reel || aliasMap[r.alias] || r.alias));
  const vraisFournisseurs = results.filter(r => !isExclu(r.nom_reel || aliasMap[r.alias] || r.alias));
  const nbCategories      = results.filter(r => isCategorieDep(r.nom_reel || aliasMap[r.alias] || r.alias)).length;
  const nbPonctuels       = results.filter(r => isEnseignePonctuelle(r.nom_reel || aliasMap[r.alias] || r.alias)).length;
  const totalReels        = vraisFournisseurs.length;
  const conformesReels    = vraisFournisseurs.filter(r=>(r.statut||'').includes('Conforme')).length;
  const bloquantsReels    = vraisFournisseurs.filter(r=>(r.statut||'').includes('Bloquant')).length;
  const corrigerReels     = vraisFournisseurs.filter(r=>(r.statut||'').includes('corriger')).length;
  const tauxReels         = totalReels > 0 ? Math.round(conformesReels/totalReels*100) : 0;

  // Scores par catégorie (sur fournisseurs réels uniquement)
  const tauxSiret = totalReels > 0 ? Math.round(vraisFournisseurs.filter(r=>r.siret_ok).length/totalReels*100) : 0;
  const tauxTva   = totalReels > 0 ? Math.round(vraisFournisseurs.filter(r=>r.tva_ok).length/totalReels*100) : 0;
  const tauxSiren = totalReels > 0 ? Math.round(vraisFournisseurs.filter(r=>r.siren_coherent).length/totalReels*100) : 0;

  const sirenMap = {};
  vraisFournisseurs.forEach(r => {
    const siret = String(r.siret||'').replace(/\s/g,'');
    if (siret.length >= 9) {
      const siren = siret.slice(0,9);
      if (!sirenMap[siren]) sirenMap[siren] = [];
      sirenMap[siren].push(r.nom_reel||r.alias);
    }
  });
  const doublons = Object.values(sirenMap).filter(g=>g.length>1).length;
  const tauxDbl  = totalReels > 0 ? Math.round((1-doublons/totalReels)*100) : 100;

  const critiques = vraisFournisseurs.filter(r=>(r.statut||'').includes('Bloquant') && !r.siret_ok && !r.tva_ok).length;
  const elevees   = vraisFournisseurs.filter(r=>(r.statut||'').includes('Bloquant') && (r.siret_ok || r.tva_ok)).length;
  const moyennes  = vraisFournisseurs.filter(r=>(r.statut||'').includes('corriger')).length;
  const faibles   = vraisFournisseurs.filter(r=>(r.statut||'').includes('Conforme') && !r.siren_coherent).length;

  // ROI — temps manuel réel, sans correction auto fictive
  const TEMPS_TOT  = Math.max(1, Math.round((bloquantsReels + corrigerReels) * 8 / 60 * 10) / 10);
  const TAUX_H     = 55;
  const coutManuel = Math.round(TEMPS_TOT * TAUX_H);
  const coutAudit  = 490;
  const economie   = Math.max(0, coutManuel - coutAudit);
  const scoreMoyen = 65;

  const scoreColor  = tauxReels >= 80 ? C.accent : tauxReels >= 50 ? C.warn : C.danger;
  const scoreLabel  = tauxReels >= 80 ? 'EXCELLENT' : tauxReels >= 60 ? 'BON' : tauxReels >= 40 ? 'MOYEN' : 'CRITIQUE';
  const niveauLabel = tauxReels >= 92 ? 'FAIBLE' : tauxReels >= 75 ? 'MODERE' : tauxReels >= 50 ? 'ELEVE' : 'CRITIQUE';
  const niveauColor = tauxReels >= 92 ? C.accent : tauxReels >= 75 ? C.warn : C.danger;
  const readyLabel  = tauxReels >= 90 ? 'OK - PRET' : tauxReels >= 75 ? 'PARTIELLEMENT PRET' : 'X NON PRET';

  const W = 595, H = 842, TP = 4;

  // ══════════════════════════════════════════════
  // PAGE 1 — SYNTHESE DIRIGEANT
  // ══════════════════════════════════════════════
  const p1 = pdfDoc.addPage([W, H]);
  drawPageHeader(p1, hB, h, logoImage, 'SYNTHESE DIRIGEANT', 1, TP, W, H);
  let y = H - 75;

  p1.drawText('RAPPORT DE CONFORMITE e-INVOICING 2026', { x:30, y, size:15, font:hB, color:C.white });
  y -= 16;
  p1.drawText('Fichier : ' + t(fileName,55), { x:30, y, size:7.5, font:h, color:C.muted });
  y -= 12;
  p1.drawText('Entreprise : ' + t(companyName||'N/A',40) + '   Date : ' + new Date().toLocaleDateString('fr-FR',{day:'2-digit',month:'long',year:'numeric'}), { x:30, y, size:7.5, font:h, color:C.muted });
  y -= 22;

  // Bloc score / risque / temps
  p1.drawRectangle({ x:20, y:y-92, width:W-40, height:96, color:C.surface });
  p1.drawRectangle({ x:20, y:y+2,  width:W-40, height:3,  color:scoreColor });

  // Score (sur fournisseurs réels)
  p1.drawText('SCORE CONFORMITE', { x:36, y:y-14, size:7, font:hB, color:C.muted });
  p1.drawText(tauxReels+'%', { x:36, y:y-54, size:40, font:hB, color:scoreColor });
  p1.drawText(scoreLabel,    { x:36, y:y-68, size:9,  font:hB, color:scoreColor });

  p1.drawRectangle({ x:155, y:y-84, width:1, height:82, color:C.muted, opacity:0.3 });

  // Risque
  p1.drawText('RISQUE OPERATIONNEL', { x:165, y:y-14, size:7, font:hB, color:C.muted });
  p1.drawText(bloquantsReels + ' fournisseurs a risque de rejet', { x:165, y:y-28, size:7.5, font:h, color:C.text });
  p1.drawText(Math.round((bloquantsReels/Math.max(totalReels,1))*100) + '% du referentiel non conforme', { x:165, y:y-40, size:7.5, font:h, color:C.warn });
  p1.drawText('Niveau : ' + niveauLabel, { x:165, y:y-54, size:8, font:hB, color:niveauColor });
  p1.drawText('Score PDP : ' + (tauxSiret>=70?'MODERE':'ELEVE'), { x:165, y:y-68, size:7.5, font:h, color:tauxSiret>=70?C.warn:C.danger });

  p1.drawRectangle({ x:375, y:y-84, width:1, height:82, color:C.muted, opacity:0.3 });

  // Temps (SANS remédiation auto)
  p1.drawText('TEMPS ECONOMISE', { x:385, y:y-14, size:7, font:hB, color:C.muted });
  p1.drawText('Manuel estime : ' + TEMPS_TOT + ' heures', { x:385, y:y-28, size:7.5, font:h, color:C.warn });
  p1.drawText('DataRemediation : 5 minutes', { x:385, y:y-40, size:7.5, font:h, color:C.accent });
  p1.drawText('Gain : ~' + coutManuel + ' EUR evites', { x:385, y:y-54, size:7.5, font:hB, color:C.accent });
  // SUPPRIME : "Remediation auto : X%" — non active
  p1.drawText('Entrees exclues : ' + exclus.length, { x:385, y:y-68, size:7, font:h, color:C.muted });

  y -= 106;

  // Note exclus
  if (exclus.length > 0) {
    p1.drawRectangle({ x:20, y:y-32, width:W-40, height:34, color:C.card });
    p1.drawRectangle({ x:20, y:y+2,  width:W-40, height:2,  color:C.blue });
    p1.drawText('NOTE : ' + exclus.length + ' entrees exclues du score (categories comptables : ' + nbCategories + ', enseignes ponctuelles : ' + nbPonctuels + ')', { x:28, y:y-12, size:7, font:hB, color:C.blue });
    p1.drawText('Score fournisseurs reels : ' + tauxReels + '% (' + totalReels + ' fournisseurs analyses)', { x:28, y:y-24, size:7, font:h, color:C.muted });
    y -= 42;
  }

  y -= 4;

  // KPIs (fournisseurs réels)
  const kpis = [
    { label:'TOTAL',      value:total,        color:'#3d8eff' },
    { label:'CONFORMES',  value:conformesReels, color:'#00e5a0' },
    { label:'A CORRIGER', value:corrigerReels,  color:'#ffb340' },
    { label:'BLOQUANTS',  value:bloquantsReels, color:'#ff4566' },
  ];
  const kW = (W-60)/4;
  kpis.forEach((k, i) => {
    const kx = 20 + i*(kW+6);
    const kC = hexToRgb(k.color);
    p1.drawRectangle({ x:kx, y:y-70, width:kW, height:73, color:C.surface });
    p1.drawRectangle({ x:kx, y:y+1,  width:kW, height:2,  color:kC });
    p1.drawText(k.label, { x:kx+8, y:y-14, size:6.5, font:hB, color:C.muted });
    p1.drawText(String(k.value), { x:kx+8, y:y-48, size:26, font:hB, color:kC });
  });
  y -= 82;
  y -= 12;

  // Matrice criticité
  p1.drawRectangle({ x:20, y:y-74, width:W-40, height:78, color:C.surface });
  p1.drawRectangle({ x:20, y:y+2,  width:W-40, height:3,  color:C.danger });
  p1.drawText('MATRICE DE CRITICITE', { x:30, y:y-14, size:8, font:hB, color:C.danger });
  const matrix = [
    { label:'Critique (SIRET + TVA absents)',   nb:critiques, color:C.danger },
    { label:'Elevee (un identifiant manquant)', nb:elevees,   color:C.warn },
    { label:'Moyenne (TVA a corriger)',          nb:moyennes,  color:hexToRgb('#ffb340') },
    { label:'Faible (SIREN incoherent)',         nb:faibles,   color:C.blue },
  ];
  const maxNb = Math.max(...matrix.map(m=>m.nb), 1);
  matrix.forEach((m, i) => {
    const mx = 30 + i * ((W-80)/4 + 5);
    const mw = (W-80)/4;
    p1.drawText(String(m.nb), { x:mx, y:y-36, size:20, font:hB, color:m.color });
    const bw2 = mw - 10;
    p1.drawRectangle({ x:mx, y:y-50, width:bw2, height:6, color:C.card });
    p1.drawRectangle({ x:mx, y:y-50, width:Math.max(bw2*(m.nb/maxNb),2), height:6, color:m.color });
    p1.drawText(t(m.label, 22), { x:mx, y:y-62, size:6, font:h, color:C.muted });
  });
  y -= 86;
  y -= 10;

  // Indice préparation
  p1.drawRectangle({ x:20, y:y-62, width:W-40, height:66, color:C.surface });
  p1.drawRectangle({ x:20, y:y+2,  width:W-40, height:3,  color:C.blue });
  p1.drawText('INDICE DE PREPARATION e-INVOICING 2026', { x:30, y:y-14, size:8, font:hB, color:C.blue });
  [
    { label:'Preparation globale', value:tauxReels,              color:scoreColor },
    { label:'Objectif cible',      value:90,                     color:C.accent },
    { label:'Ecart a combler',     value:Math.max(0,90-tauxReels), color:C.warn },
  ].forEach((j, i) => {
    const jx = 30 + i*180;
    p1.drawText(j.label.toUpperCase(), { x:jx, y:y-30, size:6,  font:hB, color:C.muted });
    p1.drawText(j.value+'%',           { x:jx, y:y-50, size:20, font:hB, color:j.color });
    const bw3 = 140;
    p1.drawRectangle({ x:jx, y:y-58, width:bw3, height:4, color:C.card });
    p1.drawRectangle({ x:jx, y:y-58, width:Math.min(bw3*(j.value/100),bw3), height:4, color:j.color });
  });
  p1.drawText(readyLabel, { x:440, y:y-40, size:10, font:hB, color:niveauColor });

  // ══════════════════════════════════════════════
  // PAGE 2 — ANALYSE DETAILLEE
  // ══════════════════════════════════════════════
  const p2 = pdfDoc.addPage([W, H]);
  drawPageHeader(p2, hB, h, logoImage, 'ANALYSE DETAILLEE', 2, TP, W, H);
  y = H - 75;

  p2.drawText('SCORE PAR CATEGORIE', { x:30, y, size:11, font:hB, color:C.white });
  p2.drawText('Ou agir en priorite (fournisseurs reels uniquement)', { x:30, y:y-14, size:8, font:h, color:C.muted });
  y -= 26;

  [
    { label:'SIRET / SIREN',          value:tauxSiret, color:tauxSiret>=80?C.accent:tauxSiret>=50?C.warn:C.danger, desc:tauxSiret<80?'Action prioritaire':'Satisfaisant' },
    { label:'TVA Intracommunautaire', value:tauxTva,   color:tauxTva>=80?C.accent:tauxTva>=50?C.warn:C.danger,    desc:tauxTva<80?'A verifier':'Satisfaisant' },
    { label:'Coherence SIREN/TVA',    value:tauxSiren, color:tauxSiren>=80?C.accent:tauxSiren>=50?C.warn:C.danger, desc:tauxSiren<80?'Risque fiscal':'Satisfaisant' },
    { label:'Absence de doublons',    value:tauxDbl,   color:tauxDbl>=80?C.accent:tauxDbl>=50?C.warn:C.danger,    desc:tauxDbl<80?'Doublons detectes':'Satisfaisant' },
  ].forEach((cat, i) => {
    const cy = y - i*50;
    p2.drawRectangle({ x:20, y:cy-42, width:W-40, height:44, color:C.surface });
    p2.drawRectangle({ x:20, y:cy-42, width:3,    height:44, color:cat.color });
    p2.drawText(cat.label, { x:32, y:cy-12, size:8.5, font:hB, color:C.text });
    p2.drawText(cat.desc,  { x:32, y:cy-26, size:7,   font:h,  color:cat.color });
    p2.drawText(cat.value+'%', { x:W-86, y:cy-22, size:18, font:hB, color:cat.color });
    const barW = W-220;
    p2.drawRectangle({ x:160, y:cy-28, width:barW, height:7, color:C.card });
    p2.drawRectangle({ x:160, y:cy-28, width:Math.min(barW*(cat.value/100),barW), height:7, color:cat.color });
  });
  y -= 4*50 + 20;
  y -= 12;

  // Priorité business
  p2.drawRectangle({ x:20, y:y-74, width:W-40, height:78, color:C.surface });
  p2.drawRectangle({ x:20, y:y+2,  width:W-40, height:3,  color:C.purple });
  p2.drawText('PRIORITE BUSINESS', { x:30, y:y-14, size:8, font:hB, color:C.purple });
  const prioData = [
    { label:'Correction immediate', nb:bloquantsReels, color:C.danger, desc:'Fournisseurs bloquants reels' },
    { label:'Correction sous 30j',  nb:corrigerReels,  color:C.warn,  desc:'A corriger manuellement' },
    { label:'Surveillance',         nb:conformesReels, color:C.accent, desc:'Conformes a surveiller' },
  ];
  prioData.forEach((p, i) => {
    const px = 30 + i * ((W-80)/3 + 8);
    p2.drawText(String(p.nb),          { x:px, y:y-36, size:22, font:hB, color:p.color });
    p2.drawText(p.label.toUpperCase(), { x:px, y:y-52, size:6,  font:hB, color:p.color });
    p2.drawText(p.desc,                { x:px, y:y-63, size:6,  font:h,  color:C.muted });
  });
  y -= 86;
  y -= 12;

  // Estimation financière (SANS correction auto)
  p2.drawText('ESTIMATION FINANCIERE', { x:30, y, size:11, font:hB, color:C.white });
  y -= 26;
  [
    { label:'COUT INTERNE ESTIME',   value:TEMPS_TOT+'h x '+TAUX_H+' EUR/h = '+coutManuel+' EUR', color:'#ffb340', desc:'Traitement manuel estime' },
    { label:'AUDIT DATAREMEDIATION', value:coutAudit+' EUR',  color:'#3d8eff', desc:'Tarif audit ponctuel' },
    { label:'ECONOMIE POTENTIELLE',  value:economie+' EUR',   color:'#00e5a0', desc:'+ securisation conformite 2026' },
  ].forEach((b, i) => {
    const bx = 20 + i*((W-50)/3+5);
    const bw = (W-50)/3;
    const bC = hexToRgb(b.color);
    p2.drawRectangle({ x:bx, y:y-72, width:bw, height:75, color:C.surface });
    p2.drawRectangle({ x:bx, y:y+1,  width:bw, height:3,  color:bC });
    p2.drawText(b.label, { x:bx+8, y:y-14, size:5.5, font:hB, color:C.muted });
    p2.drawText(b.value, { x:bx+8, y:y-40, size:11,  font:hB, color:bC });
    p2.drawText(b.desc,  { x:bx+8, y:y-60, size:6.5, font:h,  color:C.muted });
  });
  y -= 86;
  y -= 12;

  // Benchmark
  p2.drawRectangle({ x:20, y:y-60, width:W-40, height:64, color:C.surface });
  p2.drawRectangle({ x:20, y:y+2,  width:W-40, height:3,  color:C.purple });
  p2.drawText('BENCHMARK - ENTREPRISES SIMILAIRES', { x:30, y:y-14, size:8, font:hB, color:C.purple });
  const bW2 = W-200;
  p2.drawText('Score moyen secteur', { x:30, y:y-30, size:7, font:h, color:C.muted });
  p2.drawRectangle({ x:170, y:y-34, width:bW2, height:7, color:C.card });
  p2.drawRectangle({ x:170, y:y-34, width:bW2*(scoreMoyen/100), height:7, color:C.purple, opacity:0.6 });
  p2.drawText(scoreMoyen+'%', { x:170+bW2+6, y:y-32, size:7, font:hB, color:C.purple });
  p2.drawText('Votre score', { x:30, y:y-46, size:7, font:h, color:C.muted });
  p2.drawRectangle({ x:170, y:y-50, width:bW2, height:7, color:C.card });
  p2.drawRectangle({ x:170, y:y-50, width:Math.max(bW2*(tauxReels/100),2), height:7, color:scoreColor });
  p2.drawText(tauxReels+'%', { x:170+bW2+6, y:y-48, size:7, font:hB, color:scoreColor });
  const ecart = tauxReels - scoreMoyen;
  p2.drawText('Ecart vs benchmark : ' + (ecart>=0?'+':'') + ecart + ' points', { x:30, y:y-60, size:7.5, font:hB, color:ecart>=0?C.accent:C.danger });

  // ══════════════════════════════════════════════
  // PAGE 3 — PLAN DE REMEDIATION (remplace "REMEDIATION AUTOMATIQUE")
  // ══════════════════════════════════════════════
  const p3 = pdfDoc.addPage([W, H]);
  drawPageHeader(p3, hB, h, logoImage, 'PLAN DE REMEDIATION', 3, TP, W, H);
  y = H - 75;

  p3.drawText('TOP 10 - FOURNISSEURS A TRAITER EN PRIORITE', { x:30, y, size:11, font:hB, color:C.white });
  p3.drawText('Classement par niveau d\'urgence (categories de depenses exclues)', { x:30, y:y-14, size:8, font:h, color:C.muted });
  y -= 26;

  const prior = vraisFournisseurs
    .filter(r=>(r.statut||'').includes('Bloquant')||(r.statut||'').includes('corriger'))
    .slice(0,10);

  p3.drawRectangle({ x:20, y:y-16, width:W-40, height:18, color:C.surface });
  p3.drawRectangle({ x:20, y:y, width:W-40, height:2, color:C.danger });
  p3.drawText('#',           { x:26,  y:y-11, size:6.5, font:hB, color:C.muted });
  p3.drawText('FOURNISSEUR', { x:42,  y:y-11, size:6.5, font:hB, color:C.muted });
  p3.drawText('PRIORITE',    { x:228, y:y-11, size:6.5, font:hB, color:C.muted });
  p3.drawText('PROBLEME',    { x:296, y:y-11, size:6.5, font:hB, color:C.muted });
  p3.drawText('ACTION',      { x:436, y:y-11, size:6.5, font:hB, color:C.muted });
  y -= 20;

  prior.forEach((r, i) => {
    const isB  = (r.statut||'').includes('Bloquant');
    const sC   = isB ? C.danger : C.warn;
    const nom  = t(r.nom_reel||aliasMap[r.alias]||r.alias, 27);
    const prob = !r.siret_ok ? 'SIRET invalide' : !r.tva_ok ? 'TVA manquante' : 'SIREN incoherent';
    const act  = !r.siret_ok ? 'Contacter / INSEE' : !r.tva_ok ? 'Verifier VIES' : 'Verifier coherence';
    p3.drawRectangle({ x:20, y:y-16, width:W-40, height:18, color:i%2===0?C.surface:C.card });
    p3.drawRectangle({ x:20, y:y-16, width:2, height:18, color:sC });
    p3.drawText(String(i+1), { x:26, y:y-10, size:7,   font:hB, color:C.muted });
    p3.drawText(nom,          { x:42, y:y-10, size:7.5, font:hB, color:C.text });
    p3.drawText(isB?'CRITIQUE':'MODERE', { x:228, y:y-10, size:6.5, font:hB, color:sC });
    p3.drawText(prob,         { x:296, y:y-10, size:6.5, font:h,  color:C.text });
    p3.drawText(act,          { x:436, y:y-10, size:6.5, font:h,  color:C.accent });
    y -= 18;
  });

  y -= 16;

  // Fournisseurs bloquants
  const blList = vraisFournisseurs.filter(r=>(r.statut||'').includes('Bloquant')).slice(0,7);
  if (blList.length > 0 && y > 200) {
    p3.drawRectangle({ x:20, y:y-22, width:W-40, height:24, color:C.surface });
    p3.drawRectangle({ x:20, y:y-22, width:3,    height:24, color:C.danger });
    p3.drawText('FOURNISSEURS BLOQUANTS (' + bloquantsReels + ')', { x:28, y:y-13, size:8.5, font:hB, color:C.danger });
    y -= 30;
    blList.forEach(r => {
      if (y < 80) return;
      const nom = t(r.nom_reel||aliasMap[r.alias]||r.alias, 38);
      const err = t((r.erreurs||[]).join(' - '), 60);
      const rH  = r.suggestion ? 38 : 24;
      p3.drawRectangle({ x:20, y:y-rH, width:W-40, height:rH, color:C.card });
      p3.drawRectangle({ x:20, y:y-rH, width:3,    height:rH, color:C.danger });
      p3.drawText(nom, { x:28, y:y-10, size:8, font:hB, color:C.white });
      p3.drawText(err, { x:28, y:y-20, size:7, font:h,  color:C.muted });
      if (r.suggestion) p3.drawText('-> ' + t(r.suggestion,80), { x:28, y:y-30, size:7, font:h, color:C.accent });
      y -= rH + 3;
    });
  }

  // Fournisseurs à corriger
  const crList = vraisFournisseurs.filter(r=>(r.statut||'').includes('corriger')).slice(0,4);
  if (crList.length > 0 && y > 120) {
    y -= 8;
    p3.drawRectangle({ x:20, y:y-22, width:W-40, height:24, color:C.surface });
    p3.drawRectangle({ x:20, y:y-22, width:3,    height:24, color:C.warn });
    p3.drawText('FOURNISSEURS A CORRIGER (' + corrigerReels + ')', { x:28, y:y-13, size:8.5, font:hB, color:C.warn });
    y -= 30;
    crList.forEach(r => {
      if (y < 80) return;
      const nom = t(r.nom_reel||aliasMap[r.alias]||r.alias, 38);
      const err = t((r.erreurs||[]).join(' - '), 60);
      const rH  = r.suggestion ? 38 : 24;
      p3.drawRectangle({ x:20, y:y-rH, width:W-40, height:rH, color:C.card });
      p3.drawRectangle({ x:20, y:y-rH, width:3,    height:rH, color:C.warn });
      p3.drawText(nom, { x:28, y:y-10, size:8, font:hB, color:C.white });
      p3.drawText(err, { x:28, y:y-20, size:7, font:h,  color:C.muted });
      if (r.suggestion) p3.drawText('-> ' + t(r.suggestion,80), { x:28, y:y-30, size:7, font:h, color:C.accent });
      y -= rH + 3;
    });
  }

  // Plan d'action 30 jours
  if (y > 180) {
    y -= 16;
    p3.drawText('PLAN D\'ACTION 30 JOURS', { x:30, y, size:11, font:hB, color:C.white });
    p3.drawText('Feuille de route pour atteindre 90% de conformite', { x:30, y:y-14, size:8, font:h, color:C.muted });
    y -= 28;
    const plan = [
      { sem:'SEMAINE 1', titre:'Corrections critiques',     desc:'Traiter les ' + bloquantsReels + ' fournisseurs bloquants. Contacter directement ou rechercher sur data.gouv.fr.', color:C.danger },
      { sem:'SEMAINE 2', titre:'Validation TVA manquantes', desc:'Completer les ' + corrigerReels + ' TVA manquantes via le portail VIES. Verifier la coherence SIREN.', color:C.warn },
      { sem:'SEMAINE 3', titre:'Verification finale',       desc:'Relancer un audit DataRemediation pour valider les corrections. Objectif : score > 90%.', color:C.blue },
      { sem:'SEMAINE 4', titre:'Transmission a la PDP',     desc:'Transmettre le referentiel corrige a votre Plateforme de Dematerialisation Partenaire (PDP).', color:C.accent },
    ];
    plan.forEach((step, i) => {
      if (y < 80) return;
      const sx = 20 + (i%2) * ((W-50)/2 + 6);
      const sy = y - Math.floor(i/2) * 80;
      const sw = (W-50)/2;
      p3.drawRectangle({ x:sx, y:sy-72, width:sw, height:74, color:C.surface });
      p3.drawRectangle({ x:sx, y:sy+1,  width:sw, height:3,  color:step.color });
      p3.drawText(step.sem,   { x:sx+10, y:sy-14, size:7,   font:hB, color:step.color });
      p3.drawText(step.titre, { x:sx+10, y:sy-28, size:8.5, font:hB, color:C.text });
      p3.drawText(t(step.desc, 52), { x:sx+10, y:sy-42, size:7, font:h, color:C.muted });
      if (i%2===1) y -= 80;
    });
  }

  // ══════════════════════════════════════════════
  // PAGE 4 — LISTE COMPLETE + EXCLUS
  // ══════════════════════════════════════════════
  const p4 = pdfDoc.addPage([W, H]);
  drawPageHeader(p4, hB, h, logoImage, 'LISTE COMPLETE - ' + total + ' ENTREES', 4, TP, W, H);
  y = H - 72;

  p4.drawRectangle({ x:20, y:y-16, width:W-40, height:18, color:C.surface });
  p4.drawRectangle({ x:20, y:y, width:W-40, height:2, color:C.accent });
  p4.drawText('Fournisseur',    { x:26,  y:y-11, size:6.5, font:hB, color:C.muted });
  p4.drawText('Statut',         { x:215, y:y-11, size:6.5, font:hB, color:C.muted });
  p4.drawText('SIRET',          { x:268, y:y-11, size:6.5, font:hB, color:C.muted });
  p4.drawText('TVA',            { x:308, y:y-11, size:6.5, font:hB, color:C.muted });
  p4.drawText('SIREN OK',       { x:340, y:y-11, size:6.5, font:hB, color:C.muted });
  p4.drawText('Cat. depense',   { x:385, y:y-11, size:6.5, font:hB, color:C.muted });
  p4.drawText('Recommandation', { x:435, y:y-11, size:6.5, font:hB, color:C.muted });
  y -= 20;

  let rowCount = 0;
  results.slice(0,44).forEach((r, i) => {
    if (y < 44) return;
    const nom     = r.nom_reel||aliasMap[r.alias]||r.alias;
    const isConf  = (r.statut||'').includes('Conforme');
    const isBlock = (r.statut||'').includes('Bloquant');
    const isCat   = isCategorieDep(nom);
    const isPonct = isEnseignePonctuelle(nom);
    const isExcluRow = isCat || isPonct;
    const sC      = isExcluRow ? C.muted : isConf ? C.accent : isBlock ? C.danger : C.warn;
    const statut  = isExcluRow ? (isCat ? 'Cat. depense' : 'Ponctuel') : isConf ? 'Conforme' : isBlock ? 'Bloquant' : 'Corriger';
    p4.drawRectangle({ x:20, y:y-14, width:W-40, height:16, color:i%2===0?C.surface:C.card });
    p4.drawRectangle({ x:20, y:y-14, width:2,    height:16, color:sC });
    p4.drawText(t(nom, 28),                  { x:26,  y:y-9, size:6.5, font:h,  color:isExcluRow?C.muted:C.text });
    p4.drawText(statut,                       { x:215, y:y-9, size:6.5, font:hB, color:sC });
    p4.drawText(isExcluRow?'—':r.siret_ok?'OUI':'NON', { x:268, y:y-9, size:6.5, font:hB, color:isExcluRow?C.muted:r.siret_ok?C.accent:C.danger });
    p4.drawText(isExcluRow?'—':r.tva_ok?'OUI':'NON',   { x:308, y:y-9, size:6.5, font:hB, color:isExcluRow?C.muted:r.tva_ok?C.accent:C.danger });
    p4.drawText(isExcluRow?'—':r.siren_coherent?'OUI':'NON', { x:340, y:y-9, size:6.5, font:hB, color:isExcluRow?C.muted:r.siren_coherent?C.accent:C.danger });
    p4.drawText(isExcluRow?'OUI':'NON',      { x:385, y:y-9, size:6.5, font:hB, color:isExcluRow?C.blue:C.muted });
    p4.drawText(t(isExcluRow?(isCat?'Libelle comptable':'Enseigne ponctuelle — exclu'):(r.suggestion||''),22), { x:435, y:y-9, size:5.5, font:h, color:C.muted });
    y -= 16;
    rowCount++;
  });

  if (results.length > 44) {
    p4.drawText('... et ' + (results.length-44) + ' autres entrees - voir fichier Excel pour la liste complete', { x:26, y:y+2, size:7, font:h, color:C.muted });
  }

  return Buffer.from(await pdfDoc.save());
}

// ── POST /api/reports/:fileId/link ────────────────────────
router.post('/:fileId/link', authenticate, checkRole(['admin','client']), async (req, res, next) => {
  try {
    const { fileId } = req.params;
    const { type } = req.body;
    if (!['csv','pdf'].includes(type)) return res.status(400).json({ error: 'Type invalide' });
    const result = await queryWithTenant(req.user.tenant_id,
      `SELECT id FROM audit_files WHERE id=$1 AND tenant_id=current_setting('app.tenant_id')::text AND status='done'`,
      [fileId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Rapport introuvable ou analyse non terminee' });
    const downloadToken = jwt.sign(
      { fileId, tenantId:req.user.tenant_id, userId:req.user.id, type, purpose:'download' },
      process.env.JWT_SECRET,
      { expiresIn: DOWNLOAD_TTL_MIN + 'm' }
    );
    safeLog('info', 'DOWNLOAD_LINK_GENERATED', { userId:req.user.id, tenantId:req.user.tenant_id, type });
    res.json({
      downloadUrl: '/api/reports/download/' + downloadToken,
      expiresAt: new Date(Date.now() + DOWNLOAD_TTL_MIN*60000).toISOString(),
      ttlMinutes: DOWNLOAD_TTL_MIN,
    });
  } catch(err) {
    console.error('[Reports/link] Erreur:', err.message, err.stack);
    next(err);
  }
});

// ── POST /api/reports/:fileId/send ────────────────────────
router.post('/:fileId/send', authenticate, checkRole(['admin','client']), async (req, res, next) => {
  try {
    const { fileId } = req.params;
    const { email, nom_client } = req.body;
    if (!email) return res.status(400).json({ error: 'Email du destinataire requis.' });

    const result = await pool.query(
      `SELECT af.original_name, af.tenant_id, ar.summary, u.company
       FROM audit_files af
       LEFT JOIN audit_reports ar ON ar.file_id = af.id
       LEFT JOIN users u ON u.tenant_id::text = af.tenant_id
       WHERE af.id = $1 AND af.tenant_id::text = $2 AND af.status = 'done'
       LIMIT 1`,
      [fileId, req.user.tenant_id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Rapport introuvable ou analyse non terminee.' });

    const row = result.rows[0];
    const sd  = typeof row.summary === 'string' ? JSON.parse(row.summary) : row.summary;
    const vrais = (sd?.results||[]).filter(r => !isExclu(r.nom_reel||sd?.aliasMap?.[r.alias]||r.alias));
    const tauxR = vrais.length > 0 ? Math.round(vrais.filter(r=>(r.statut||'').includes('Conforme')).length/vrais.length*100) : 0;
    const totalR = vrais.length;
    const bloquantsR = vrais.filter(r=>(r.statut||'').includes('Bloquant')).length;
    const companyName = row.company || 'DataRemediation';
    const baseName = row.original_name.replace(/\.[^.]+$/, '');

    const pdfBuffer = await generatePDF(sd, row.original_name, companyName);
    const pdfBase64 = pdfBuffer.toString('base64');

    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    if (!RESEND_API_KEY) return res.status(500).json({ error: 'Service email non configure.' });

    const scoreLabel = tauxR >= 80 ? 'Conforme' : tauxR >= 50 ? 'A ameliorer' : 'Critique';
    const scoreEmoji = tauxR >= 80 ? '✅' : tauxR >= 50 ? '⚠️' : '🚨';

    const emailBody = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="font-family:Arial,sans-serif;background:#f5f5f5;margin:0;padding:20px;">
<div style="max-width:600px;margin:0 auto;background:white;border-radius:8px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,.1);">
  <div style="background:#06080f;padding:30px;text-align:center;">
    <h1 style="color:#00e5a0;margin:0;font-size:24px;">DataRemediation</h1>
    <p style="color:#8899cc;margin:8px 0 0;font-size:14px;">Conformite e-Invoicing 2026</p>
  </div>
  <div style="padding:30px;">
    <p style="color:#333;font-size:16px;">Bonjour${nom_client?' '+nom_client:''},</p>
    <p style="color:#555;font-size:14px;line-height:1.6;">Suite a l'audit de votre base fournisseurs, veuillez trouver ci-joint votre rapport de conformite e-Invoicing 2026.</p>
    <div style="background:#f8f9fa;border-left:4px solid #00e5a0;padding:20px;margin:20px 0;border-radius:4px;">
      <div style="font-size:32px;font-weight:bold;color:${tauxR>=80?'#00e5a0':tauxR>=50?'#ffb340':'#ff4566'};">
        ${scoreEmoji} ${tauxR}% — ${scoreLabel}
      </div>
      <div style="color:#666;margin-top:8px;font-size:14px;">
        ${totalR} fournisseurs reels analyses · ${bloquantsR} fournisseurs bloquants identifies
      </div>
    </div>
    <p style="color:#555;font-size:14px;line-height:1.6;">Le rapport PDF complet (4 pages) est joint a cet email.</p>
    <p style="color:#333;font-size:14px;margin-top:30px;">Cordialement,<br><strong>L'equipe DataRemediation</strong><br><span style="color:#00e5a0;">contact@dataremediation.fr</span></p>
  </div>
  <div style="background:#06080f;padding:20px;text-align:center;">
    <p style="color:#4a5878;font-size:12px;margin:0;">DataRemediation · Conformite e-Invoicing 2026 · Confidentiel</p>
  </div>
</div></body></html>`;

    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'DataRemediation <contact@dataremediation.fr>',
        reply_to: 'dataremediation.contact@gmail.com',
        to: [email],
        subject: `Rapport de conformite fournisseurs — Score ${tauxR}% — ${new Date().toLocaleDateString('fr-FR')}`,
        html: emailBody,
        attachments: [{ filename: `rapport_conformite_${baseName}.pdf`, content: pdfBase64 }],
      }),
    });

    const resendData = await resendRes.json().catch(() => ({}));
    if (!resendRes.ok) return res.status(500).json({ error: 'Erreur envoi email: ' + (resendData.message || resendRes.status) });

    safeLog('info', 'REPORT_SENT', { userId: req.user.id, tenantId: req.user.tenant_id, to: email });
    res.json({ success: true, message: `Rapport envoye a ${email}` });
  } catch(err) {
    console.error('[Send] ERREUR:', err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/reports/download/:token ─────────────────────
router.get('/download/:token', async (req, res, next) => {
  try {
    let decoded;
    try { decoded = jwt.verify(req.params.token, process.env.JWT_SECRET); }
    catch { return res.status(401).json({ error: 'Lien invalide ou expire' }); }
    if (decoded.purpose !== 'download') return res.status(401).json({ error: 'Token invalide' });

    const result = await pool.query(
      `SELECT af.original_name, af.tenant_id, ar.csv_content, ar.pdf_content, ar.summary
       FROM audit_files af LEFT JOIN audit_reports ar ON ar.file_id=af.id
       WHERE af.id=$1 AND af.tenant_id=$2 LIMIT 1`,
      [decoded.fileId, decoded.tenantId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Rapport introuvable' });

    const row      = result.rows[0];
    const baseName = row.original_name.replace(/\.[^.]+$/, '');
    let companyName = 'N/A';
    try {
      const cr = await pool.query('SELECT company FROM users WHERE tenant_id=$1 LIMIT 1', [decoded.tenantId]);
      if (cr.rows.length > 0) companyName = cr.rows[0].company;
    } catch(e) {}

    if (decoded.type === 'csv') {
      try {
        const sd       = typeof row.summary==='string' ? JSON.parse(row.summary) : row.summary;
        const results  = sd?.results  || [];
        const aliasMap = sd?.aliasMap || {};
        const summary  = sd?.summary  || {};
        const bl = summary.bloquants||0;
        const cr2 = summary.a_corriger||0;
        const catDep  = results.filter(r=>isCategorieDep(r.nom_reel||aliasMap[r.alias]||r.alias));
        const ponct   = results.filter(r=>isEnseignePonctuelle(r.nom_reel||aliasMap[r.alias]||r.alias));
        const vrais   = results.filter(r=>!isExclu(r.nom_reel||aliasMap[r.alias]||r.alias));
        const tauxR2  = vrais.length > 0 ? Math.round(vrais.filter(r=>(r.statut||'').includes('Conforme')).length/vrais.length*100) : 0;
        const TEMPS   = Math.max(1, Math.round((bl+cr2)*8/60*10)/10);

        const wb = XLSX.utils.book_new();
        const resumeData = [
          ['RAPPORT DE CONFORMITE e-INVOICING 2026'],['DataRemediation - Confidentiel'],[],
          ['Fichier', row.original_name],['Entreprise', companyName],['Date', new Date().toLocaleDateString('fr-FR')],[],
          ['PERIMETRE'],
          ['Total lignes', summary.total||results.length],
          ['Fournisseurs reels (score)', vrais.length],
          ['Entrees exclues', catDep.length + ponct.length],
          ['  dont categories comptables', catDep.length],
          ['  dont enseignes ponctuelles', ponct.length],
          [],
          ['SCORE QUALITE (fournisseurs reels)', tauxR2+'%'],
          ['Conformes', vrais.filter(r=>(r.statut||'').includes('Conforme')).length],
          ['Bloquants', vrais.filter(r=>(r.statut||'').includes('Bloquant')).length],
          ['A corriger', vrais.filter(r=>(r.statut||'').includes('corriger')).length],
          [],
          ['VALORISATION'],
          ['Temps manuel estime', TEMPS+' heures'],
          ['Avec DataRemediation', '5 minutes'],
          ['Cout interne evite', Math.round(TEMPS*55)+' EUR'],
          ['Audit DataRemediation', '490 EUR'],
          ['Economie potentielle', Math.max(0,Math.round(TEMPS*55)-490)+' EUR'],
        ];
        const wsR = XLSX.utils.aoa_to_sheet(resumeData);
        wsR['!cols'] = [{wch:35},{wch:50}];
        XLSX.utils.book_append_sheet(wb, wsR, 'Resume');

        const headers = ['Nom fournisseur','Alias','Statut','SIRET valide','TVA valide','SIREN coherent','Cat. depense','Erreurs','Recommandation'];
        const cols    = [{wch:35},{wch:12},{wch:15},{wch:14},{wch:12},{wch:16},{wch:14},{wch:40},{wch:60}];
        const toRow   = r => {
          const nom = r.nom_reel||aliasMap[r.alias]||r.alias;
          const exclu = isExclu(nom);
          return [nom, r.alias, exclu?(isCategorieDep(nom)?'Cat. depense':'Ponctuel'):r.statut||'',
            exclu?'—':r.siret_ok?'OUI':'NON', exclu?'—':r.tva_ok?'OUI':'NON',
            exclu?'—':r.siren_coherent?'OUI':'NON', exclu?'OUI':'NON',
            exclu?'':((r.erreurs||[]).join(' | ')), exclu?'':r.suggestion||''];
        };

        const wsD = XLSX.utils.aoa_to_sheet([headers, ...results.map(toRow)]);
        wsD['!cols'] = cols;
        XLSX.utils.book_append_sheet(wb, wsD, 'Tous les fournisseurs');

        if (vrais.filter(r=>(r.statut||'').includes('Bloquant')).length > 0) {
          const ws = XLSX.utils.aoa_to_sheet([headers, ...vrais.filter(r=>(r.statut||'').includes('Bloquant')).map(toRow)]);
          ws['!cols'] = cols;
          XLSX.utils.book_append_sheet(wb, ws, 'Bloquants');
        }
        if (vrais.filter(r=>(r.statut||'').includes('corriger')).length > 0) {
          const ws = XLSX.utils.aoa_to_sheet([headers, ...vrais.filter(r=>(r.statut||'').includes('corriger')).map(toRow)]);
          ws['!cols'] = cols;
          XLSX.utils.book_append_sheet(wb, ws, 'A corriger');
        }
        if (catDep.length > 0) {
          const ws = XLSX.utils.aoa_to_sheet([headers, ...catDep.map(toRow)]);
          ws['!cols'] = cols;
          XLSX.utils.book_append_sheet(wb, ws, 'Categories depenses');
        }
        if (ponct.length > 0) {
          const ws = XLSX.utils.aoa_to_sheet([headers, ...ponct.map(toRow)]);
          ws['!cols'] = cols;
          XLSX.utils.book_append_sheet(wb, ws, 'Enseignes ponctuelles');
        }
        if (vrais.filter(r=>(r.statut||'').includes('Conforme')).length > 0) {
          const ws = XLSX.utils.aoa_to_sheet([headers, ...vrais.filter(r=>(r.statut||'').includes('Conforme')).map(toRow)]);
          ws['!cols'] = cols;
          XLSX.utils.book_append_sheet(wb, ws, 'Conformes');
        }

        const buf = XLSX.write(wb, {type:'buffer', bookType:'xlsx'});
        res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="rapport_'+baseName+'.xlsx"');
        res.setHeader('Cache-Control','no-store');
        return res.send(buf);
      } catch(e) {
        return res.status(500).json({ error:'Erreur Excel: '+e.message });
      }
    }

    if (decoded.type === 'pdf') {
      try {
        const sd = typeof row.summary==='string' ? JSON.parse(row.summary) : row.summary;
        const pdfBuffer = await generatePDF(sd, row.original_name, companyName);
        res.setHeader('Content-Type','application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename="rapport_conformite_'+baseName+'.pdf"');
        res.setHeader('Cache-Control','no-store');
        return res.send(pdfBuffer);
      } catch(e) {
        console.error('Erreur PDF:', e.message);
        return res.status(500).json({ error:'Erreur generation PDF: '+e.message });
      }
    }

    res.status(400).json({ error:'Type inconnu' });
  } catch(err) { next(err); }
});

module.exports = router;
