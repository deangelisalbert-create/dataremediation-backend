// routes/reports.js - Rapport PDF DataRemediation - ASCII only
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
};

function hexToRgb(hex) {
  const r = parseInt(hex.slice(1,3),16)/255;
  const g = parseInt(hex.slice(3,5),16)/255;
  const b = parseInt(hex.slice(5,7),16)/255;
  return rgb(r,g,b);
}

// Sanitize: convertit tous les caracteres non-ASCII en ASCII
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
    .replace(/[\u2019\u2018\u0027]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[\u2026]/g, '...')
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

  page.drawText(s(title), { x:W-200, y:H-28, size:9, font:hB, color:C.muted });
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
    if (fs.existsSync(logoPath)) {
      logoImage = await pdfDoc.embedPng(fs.readFileSync(logoPath));
    }
  } catch(e) {}

  const results  = summaryData?.results  || [];
  const summary  = summaryData?.summary  || {};
  const aliasMap = summaryData?.aliasMap || {};

  const total     = summary.total     || results.length;
  const conformes = summary.conformes  || results.filter(r=>(r.statut||'').includes('Conforme')).length;
  const corriger  = summary.a_corriger || results.filter(r=>(r.statut||'').includes('corriger')).length;
  const bloquants = summary.bloquants  || results.filter(r=>(r.statut||'').includes('Bloquant')).length;
  const taux      = summary.taux       || (total > 0 ? Math.round(conformes/total*100) : 0);

  const tauxSiret = total > 0 ? Math.round(results.filter(r=>r.siret_ok).length/total*100) : 0;
  const tauxTva   = total > 0 ? Math.round(results.filter(r=>r.tva_ok).length/total*100) : 0;
  const tauxSiren = total > 0 ? Math.round(results.filter(r=>r.siren_coherent).length/total*100) : 0;

  const sirenMap = {};
  results.forEach(r => {
    const siret = String(r.siret||'').replace(/\s/g,'');
    if (siret.length >= 9) {
      const siren = siret.slice(0,9);
      if (!sirenMap[siren]) sirenMap[siren] = [];
      sirenMap[siren].push(r.nom_reel||r.alias);
    }
  });
  const doublons    = Object.values(sirenMap).filter(g=>g.length>1).length;
  const tauxDbl     = total > 0 ? Math.round((1 - doublons/total)*100) : 100;

  const TEMPS_TOT   = 3 + 2 + 1 + Math.round((bloquants+corriger)*0.1);
  const TAUX_H      = 60;
  const coutManuel  = TEMPS_TOT * TAUX_H;
  const coutAudit   = 490;
  const economie    = coutManuel - coutAudit;
  const scoreMoyen  = 65;

  const scoreColor  = taux >= 80 ? C.accent : taux >= 50 ? C.warn : C.danger;
  const scoreLabel  = taux >= 80 ? 'EXCELLENT' : taux >= 60 ? 'BON' : taux >= 40 ? 'MOYEN' : 'CRITIQUE';
  const niveauLabel = taux >= 92 ? 'FAIBLE' : taux >= 75 ? 'MODERE' : taux >= 50 ? 'ELEVE' : 'CRITIQUE';
  const niveauColor = taux >= 92 ? C.accent : taux >= 75 ? C.warn : C.danger;
  const readyLabel  = taux >= 90 ? 'OK - PRET' : taux >= 75 ? 'PARTIELLEMENT PRET' : 'X NON PRET';

  const W = 595, H = 842, TP = 4;

  //  PAGE 1 : SYNTHESE DIRIGEANT 
  const p1 = pdfDoc.addPage([W, H]);
  drawPageHeader(p1, hB, h, logoImage, 'SYNTHESE DIRIGEANT', 1, TP, W, H);

  let y = H - 75;
  p1.drawText('RAPPORT DE CONFORMITE e-INVOICING 2026', { x:30, y, size:15, font:hB, color:C.white });
  y -= 16;
  p1.drawText('Fichier : ' + t(fileName,55), { x:30, y, size:7.5, font:h, color:C.muted });
  y -= 12;
  p1.drawText('Entreprise : ' + t(companyName||'N/A',40) + '   Date : ' + new Date().toLocaleDateString('fr-FR',{day:'2-digit',month:'long',year:'numeric'}), { x:30, y, size:7.5, font:h, color:C.muted });
  y -= 20;

  // Bloc score + risque
  p1.drawRectangle({ x:20, y:y-90, width:W-40, height:95, color:C.surface });
  p1.drawRectangle({ x:20, y:y+3, width:W-40, height:3, color:scoreColor });

  p1.drawText('SCORE DE CONFORMITE', { x:36, y:y-14, size:7, font:hB, color:C.muted });
  p1.drawText(taux+'%', { x:36, y:y-54, size:40, font:hB, color:scoreColor });
  p1.drawText(scoreLabel, { x:36, y:y-68, size:9, font:hB, color:scoreColor });

  p1.drawRectangle({ x:158, y:y-82, width:1, height:80, color:C.muted, opacity:0.3 });

  p1.drawText('RISQUE OPERATIONNEL', { x:170, y:y-14, size:7, font:hB, color:C.muted });
  p1.drawText(bloquants + ' fournisseurs a risque de rejet', { x:170, y:y-28, size:8, font:h, color:C.text });
  p1.drawText(Math.round((bloquants/Math.max(total,1))*100) + '% du referentiel non conforme', { x:170, y:y-42, size:8, font:h, color:C.warn });
  p1.drawText('Niveau de risque : ' + niveauLabel, { x:170, y:y-58, size:8, font:hB, color:niveauColor });

  p1.drawRectangle({ x:378, y:y-82, width:1, height:80, color:C.muted, opacity:0.3 });

  p1.drawText('TEMPS ECONOMISE', { x:390, y:y-14, size:7, font:hB, color:C.muted });
  p1.drawText('Manuel estime : ' + TEMPS_TOT + ' heures', { x:390, y:y-30, size:8, font:h, color:C.warn });
  p1.drawText('DataRemediation : 5 minutes', { x:390, y:y-44, size:8, font:h, color:C.accent });
  p1.drawText('Gain : ' + TEMPS_TOT + 'h x ' + TAUX_H + 'EUR = ' + coutManuel + 'EUR', { x:390, y:y-60, size:7.5, font:hB, color:C.accent });

  y -= 106;

  // 4 KPIs
  const kpis = [
    { label:'TOTAL',      value:total,     color:'#3d8eff' },
    { label:'CONFORMES',  value:conformes, color:'#00e5a0' },
    { label:'A CORRIGER', value:corriger,  color:'#ffb340' },
    { label:'BLOQUANTS',  value:bloquants, color:'#ff4566' },
  ];
  const kW = (W-60)/4;
  kpis.forEach((k, i) => {
    const kx = 20 + i*(kW+6);
    const kC = hexToRgb(k.color);
    p1.drawRectangle({ x:kx, y:y-72, width:kW, height:75, color:C.surface });
    p1.drawRectangle({ x:kx, y:y+1, width:kW, height:2, color:kC });
    p1.drawText(k.label, { x:kx+8, y:y-14, size:6.5, font:hB, color:C.muted });
    p1.drawText(String(k.value), { x:kx+8, y:y-50, size:28, font:hB, color:kC });
  });
  y -= 84;

  // Indice preparation
  y -= 12;
  p1.drawRectangle({ x:20, y:y-72, width:W-40, height:76, color:C.surface });
  p1.drawRectangle({ x:20, y:y+2, width:W-40, height:3, color:C.blue });
  p1.drawText('INDICE DE PREPARATION FACTURATION ELECTRONIQUE 2026', { x:30, y:y-14, size:8, font:hB, color:C.blue });

  [
    { label:'Preparation globale', value:taux,         color:scoreColor },
    { label:'Objectif recommande', value:90,           color:C.accent   },
    { label:'Ecart a combler',     value:Math.max(0,90-taux), color:C.warn },
  ].forEach((j, i) => {
    const jx = 30 + i*180;
    p1.drawText(j.label.toUpperCase(), { x:jx, y:y-32, size:6, font:hB, color:C.muted });
    p1.drawText(j.value+'%', { x:jx, y:y-54, size:22, font:hB, color:j.color });
    const bw = 140;
    p1.drawRectangle({ x:jx, y:y-64, width:bw, height:4, color:C.card });
    p1.drawRectangle({ x:jx, y:y-64, width:Math.min(bw*(j.value/100),bw), height:4, color:j.color });
  });
  p1.drawText(readyLabel, { x:440, y:y-44, size:10, font:hB, color:niveauColor });
  y -= 86;

  // Benchmark
  y -= 12;
  p1.drawRectangle({ x:20, y:y-72, width:W-40, height:76, color:C.surface });
  p1.drawRectangle({ x:20, y:y+2, width:W-40, height:3, color:C.purple });
  p1.drawText('BENCHMARK - ENTREPRISES SIMILAIRES', { x:30, y:y-14, size:8, font:hB, color:C.purple });

  const bW2 = W-200;
  p1.drawText('Score moyen secteur', { x:30, y:y-32, size:7, font:h, color:C.muted });
  p1.drawRectangle({ x:170, y:y-36, width:bW2, height:8, color:C.card });
  p1.drawRectangle({ x:170, y:y-36, width:bW2*(scoreMoyen/100), height:8, color:C.purple, opacity:0.6 });
  p1.drawText(scoreMoyen+'%', { x:170+bW2+6, y:y-34, size:7.5, font:hB, color:C.purple });

  p1.drawText('Votre score', { x:30, y:y-50, size:7, font:h, color:C.muted });
  p1.drawRectangle({ x:170, y:y-54, width:bW2, height:8, color:C.card });
  p1.drawRectangle({ x:170, y:y-54, width:Math.max(bW2*(taux/100),2), height:8, color:scoreColor });
  p1.drawText(taux+'%', { x:170+bW2+6, y:y-52, size:7.5, font:hB, color:scoreColor });

  const ecart = taux - scoreMoyen;
  p1.drawText('Ecart vs benchmark : ' + (ecart>=0?'+':'') + ecart + ' points', { x:30, y:y-66, size:7.5, font:hB, color:ecart>=0?C.accent:C.danger });

  //  PAGE 2 : SCORES PAR CATEGORIE + ROI 
  const p2 = pdfDoc.addPage([W, H]);
  drawPageHeader(p2, hB, h, logoImage, 'ANALYSE DETAILLEE', 2, TP, W, H);

  y = H - 75;
  p2.drawText('SCORE PAR CATEGORIE', { x:30, y, size:11, font:hB, color:C.white });
  p2.drawText('Ou agir en priorite', { x:30, y:y-14, size:8, font:h, color:C.muted });
  y -= 26;

  [
    { label:'SIRET / SIREN',          value:tauxSiret, color:tauxSiret>=80?C.accent:tauxSiret>=50?C.warn:C.danger,  desc:tauxSiret<80?'Action prioritaire':'Satisfaisant' },
    { label:'TVA Intracommunautaire', value:tauxTva,   color:tauxTva>=80?C.accent:tauxTva>=50?C.warn:C.danger,      desc:tauxTva<80?'A verifier':'Satisfaisant' },
    { label:'Coherence SIREN/TVA',   value:tauxSiren, color:tauxSiren>=80?C.accent:tauxSiren>=50?C.warn:C.danger,   desc:tauxSiren<80?'Risque fiscal':'Satisfaisant' },
    { label:'Absence de doublons',   value:tauxDbl,   color:tauxDbl>=80?C.accent:tauxDbl>=50?C.warn:C.danger,       desc:tauxDbl<80?'Doublons detectes':'Satisfaisant' },
  ].forEach((cat, i) => {
    const cy = y - i*52;
    p2.drawRectangle({ x:20, y:cy-44, width:W-40, height:46, color:C.surface });
    p2.drawRectangle({ x:20, y:cy-44, width:3, height:46, color:cat.color });
    p2.drawText(cat.label, { x:32, y:cy-12, size:8.5, font:hB, color:C.text });
    p2.drawText(cat.desc, { x:32, y:cy-26, size:7, font:h, color:cat.color });
    p2.drawText(cat.value+'%', { x:W-88, y:cy-22, size:18, font:hB, color:cat.color });
    const barW = W-220;
    p2.drawRectangle({ x:160, y:cy-28, width:barW, height:8, color:C.card });
    p2.drawRectangle({ x:160, y:cy-28, width:Math.min(barW*(cat.value/100),barW), height:8, color:cat.color });
  });
  y -= 4*52 + 20;

  // Temps econom detail
  y -= 12;
  p2.drawText('DETAIL DU TEMPS ECONOMISE', { x:30, y, size:11, font:hB, color:C.white });
  y -= 24;

  p2.drawRectangle({ x:20, y:y-16, width:W-40, height:18, color:C.surface });
  p2.drawRectangle({ x:20, y:y, width:W-40, height:2, color:C.accent });
  p2.drawText('CONTROLE', { x:30, y:y-11, size:7, font:hB, color:C.muted });
  p2.drawText('TEMPS MANUEL', { x:W-120, y:y-11, size:7, font:hB, color:C.muted });
  y -= 20;

  [
    ['Verification SIRET / SIREN', '3 h'],
    ['Verification TVA', '2 h'],
    ['Recherche doublons', '1 h'],
    ['Corrections manuelles', Math.round((bloquants+corriger)*0.1) + ' h'],
  ].forEach(([label, temps], i) => {
    p2.drawRectangle({ x:20, y:y-16, width:W-40, height:18, color:i%2===0?C.surface:C.card });
    p2.drawText(label, { x:30, y:y-10, size:8, font:h, color:C.text });
    p2.drawText(temps, { x:W-100, y:y-10, size:8, font:hB, color:C.warn });
    y -= 18;
  });

  p2.drawRectangle({ x:20, y:y-18, width:W-40, height:20, color:C.surface });
  p2.drawRectangle({ x:20, y:y, width:W-40, height:2, color:C.accent });
  p2.drawText('TEMPS TOTAL ESTIME :', { x:30, y:y-13, size:8.5, font:hB, color:C.text });
  p2.drawText(TEMPS_TOT + ' heures', { x:W-120, y:y-13, size:9, font:hB, color:C.warn });
  y -= 30;

  p2.drawRectangle({ x:20, y:y-16, width:W-40, height:18, color:C.card });
  p2.drawText('Avec DataRemediation :', { x:30, y:y-10, size:8.5, font:hB, color:C.text });
  p2.drawText('5 minutes', { x:W-100, y:y-10, size:9, font:hB, color:C.accent });
  y -= 36;

  // Estimation financiere
  y -= 12;
  p2.drawText('ESTIMATION FINANCIERE', { x:30, y, size:11, font:hB, color:C.white });
  y -= 26;

  [
    { label:'Cout interne estime',    value:TEMPS_TOT+'h x '+TAUX_H+'EUR/h = '+coutManuel+'EUR', color:'#ffb340', desc:'Traitement manuel' },
    { label:'Audit DataRemediation',  value:coutAudit+'EUR', color:'#3d8eff', desc:'Tarif audit ponctuel' },
    { label:'Economie potentielle',   value:economie+'EUR',  color:'#00e5a0', desc:'+ securisation conformite 2026' },
  ].forEach((b, i) => {
    const bx = 20 + i*((W-50)/3 + 5);
    const bw = (W-50)/3;
    const bC = hexToRgb(b.color);
    p2.drawRectangle({ x:bx, y:y-72, width:bw, height:75, color:C.surface });
    p2.drawRectangle({ x:bx, y:y+1, width:bw, height:3, color:bC });
    p2.drawText(b.label.toUpperCase(), { x:bx+8, y:y-14, size:6, font:hB, color:C.muted });
    p2.drawText(b.value, { x:bx+8, y:y-40, size:12, font:hB, color:bC });
    p2.drawText(b.desc, { x:bx+8, y:y-60, size:6.5, font:h, color:C.muted });
  });

  //  PAGE 3 : TOP 10 + ANOMALIES 
  const p3 = pdfDoc.addPage([W, H]);
  drawPageHeader(p3, hB, h, logoImage, 'PLAN DE REMEDIATION', 3, TP, W, H);

  y = H - 75;
  p3.drawText('TOP 10 - FOURNISSEURS A TRAITER EN PRIORITE', { x:30, y, size:11, font:hB, color:C.white });
  y -= 26;

  const prior = results.filter(r=>(r.statut||'').includes('Bloquant')||(r.statut||'').includes('corriger')).slice(0,10);

  p3.drawRectangle({ x:20, y:y-16, width:W-40, height:18, color:C.surface });
  p3.drawRectangle({ x:20, y:y, width:W-40, height:2, color:C.accent });
  p3.drawText('#',           { x:26,  y:y-11, size:6.5, font:hB, color:C.muted });
  p3.drawText('FOURNISSEUR', { x:42,  y:y-11, size:6.5, font:hB, color:C.muted });
  p3.drawText('PRIORITE',    { x:230, y:y-11, size:6.5, font:hB, color:C.muted });
  p3.drawText('PROBLEME',    { x:300, y:y-11, size:6.5, font:hB, color:C.muted });
  p3.drawText('ACTION',      { x:440, y:y-11, size:6.5, font:hB, color:C.muted });
  y -= 20;

  prior.forEach((r, i) => {
    const isB   = (r.statut||'').includes('Bloquant');
    const sC    = isB ? C.danger : C.warn;
    const nom   = t(r.nom_reel || aliasMap[r.alias] || r.alias, 28);
    const prob  = t(!r.siret_ok ? 'SIRET invalide' : !r.tva_ok ? 'TVA manquante' : 'SIREN incoherent', 22);
    const act   = t(!r.siret_ok ? 'Contacter fournisseur' : !r.tva_ok ? 'Verifier TVA VIES' : 'Verifier coherence', 20);

    p3.drawRectangle({ x:20, y:y-16, width:W-40, height:18, color:i%2===0?C.surface:C.card });
    p3.drawRectangle({ x:20, y:y-16, width:2, height:18, color:sC });
    p3.drawText(String(i+1),          { x:26,  y:y-10, size:7,   font:hB, color:C.muted });
    p3.drawText(nom,                  { x:42,  y:y-10, size:7.5, font:hB, color:C.text });
    p3.drawText(isB?'CRITIQUE':'MODERE', { x:230, y:y-10, size:6.5, font:hB, color:sC });
    p3.drawText(prob,                 { x:300, y:y-10, size:6.5, font:h,  color:C.text });
    p3.drawText(act,                  { x:440, y:y-10, size:6.5, font:h,  color:C.accent });
    y -= 18;
  });

  y -= 16;

  const blList = results.filter(r=>(r.statut||'').includes('Bloquant')).slice(0,8);
  const crList = results.filter(r=>(r.statut||'').includes('corriger')).slice(0,5);

  if (blList.length > 0 && y > 200) {
    p3.drawRectangle({ x:20, y:y-22, width:W-40, height:24, color:C.surface });
    p3.drawRectangle({ x:20, y:y-22, width:3, height:24, color:C.danger });
    p3.drawText('FOURNISSEURS BLOQUANTS (' + bloquants + ')', { x:28, y:y-13, size:8.5, font:hB, color:C.danger });
    y -= 30;

    blList.forEach(r => {
      if (y < 80) return;
      const nom  = t(r.nom_reel || aliasMap[r.alias] || r.alias, 38);
      const err  = t((r.erreurs||[]).join(' - '), 60);
      const rH   = r.suggestion ? 40 : 26;
      p3.drawRectangle({ x:20, y:y-rH, width:W-40, height:rH, color:C.card });
      p3.drawRectangle({ x:20, y:y-rH, width:3, height:rH, color:C.danger });
      p3.drawText(nom, { x:28, y:y-10, size:8, font:hB, color:C.white });
      p3.drawText(err, { x:28, y:y-20, size:7, font:h,  color:C.muted });
      if (r.suggestion) p3.drawText('-> ' + t(r.suggestion, 80), { x:28, y:y-30, size:7, font:h, color:C.accent });
      y -= rH + 4;
    });
  }

  if (crList.length > 0 && y > 120) {
    y -= 8;
    p3.drawRectangle({ x:20, y:y-22, width:W-40, height:24, color:C.surface });
    p3.drawRectangle({ x:20, y:y-22, width:3, height:24, color:C.warn });
    p3.drawText('FOURNISSEURS A CORRIGER (' + corriger + ')', { x:28, y:y-13, size:8.5, font:hB, color:C.warn });
    y -= 30;

    crList.forEach(r => {
      if (y < 80) return;
      const nom = t(r.nom_reel || aliasMap[r.alias] || r.alias, 38);
      const err = t((r.erreurs||[]).join(' - '), 60);
      const rH  = r.suggestion ? 40 : 26;
      p3.drawRectangle({ x:20, y:y-rH, width:W-40, height:rH, color:C.card });
      p3.drawRectangle({ x:20, y:y-rH, width:3, height:rH, color:C.warn });
      p3.drawText(nom, { x:28, y:y-10, size:8, font:hB, color:C.white });
      p3.drawText(err, { x:28, y:y-20, size:7, font:h,  color:C.muted });
      if (r.suggestion) p3.drawText('-> ' + t(r.suggestion, 80), { x:28, y:y-30, size:7, font:h, color:C.accent });
      y -= rH + 4;
    });
  }

  //  PAGE 4 : LISTE COMPLETE 
  const p4 = pdfDoc.addPage([W, H]);
  drawPageHeader(p4, hB, h, logoImage, 'LISTE COMPLETE - ' + total + ' FOURNISSEURS', 4, TP, W, H);

  y = H - 72;
  p4.drawRectangle({ x:20, y:y-16, width:W-40, height:18, color:C.surface });
  p4.drawRectangle({ x:20, y:y, width:W-40, height:2, color:C.accent });
  p4.drawText('Fournisseur',    { x:26,  y:y-11, size:6.5, font:hB, color:C.muted });
  p4.drawText('Statut',         { x:220, y:y-11, size:6.5, font:hB, color:C.muted });
  p4.drawText('SIRET',          { x:275, y:y-11, size:6.5, font:hB, color:C.muted });
  p4.drawText('TVA',            { x:316, y:y-11, size:6.5, font:hB, color:C.muted });
  p4.drawText('SIREN OK',       { x:348, y:y-11, size:6.5, font:hB, color:C.muted });
  p4.drawText('Recommandation', { x:395, y:y-11, size:6.5, font:hB, color:C.muted });
  y -= 20;

  results.slice(0,44).forEach((r, i) => {
    if (y < 44) return;
    const isConf  = (r.statut||'').includes('Conforme');
    const isBlock = (r.statut||'').includes('Bloquant');
    const sC      = isConf ? C.accent : isBlock ? C.danger : C.warn;
    const statut  = isConf ? 'Conforme' : isBlock ? 'Bloquant' : 'Corriger';

    p4.drawRectangle({ x:20, y:y-14, width:W-40, height:16, color:i%2===0?C.surface:C.card });
    p4.drawRectangle({ x:20, y:y-14, width:2, height:16, color:sC });

    p4.drawText(t(r.nom_reel||aliasMap[r.alias]||r.alias, 30), { x:26,  y:y-9, size:6.5, font:h,  color:C.text });
    p4.drawText(statut,                                          { x:220, y:y-9, size:6.5, font:hB, color:sC });
    p4.drawText(r.siret_ok?'OUI':'NON', { x:275, y:y-9, size:6.5, font:hB, color:r.siret_ok?C.accent:C.danger });
    p4.drawText(r.tva_ok?'OUI':'NON',   { x:316, y:y-9, size:6.5, font:hB, color:r.tva_ok?C.accent:C.danger });
    p4.drawText(r.siren_coherent?'OUI':'NON', { x:348, y:y-9, size:6.5, font:hB, color:r.siren_coherent?C.accent:C.danger });
    p4.drawText(t(r.suggestion||'', 28), { x:395, y:y-9, size:5.5, font:h, color:C.muted });
    y -= 16;
  });

  if (results.length > 44) {
    p4.drawText('... et ' + (results.length-44) + ' autres fournisseurs - voir fichier Excel pour la liste complete', {
      x:26, y:y+2, size:7, font:h, color:C.muted
    });
  }

  return Buffer.from(await pdfDoc.save());
}

//  POST /api/reports/:fileId/link 
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
  } catch(err) { next(err); }
});

//  GET /api/reports/download/:token 
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

    // Excel
    if (decoded.type === 'csv') {
      try {
        const sd = typeof row.summary==='string' ? JSON.parse(row.summary) : row.summary;
        const results  = sd?.results  || [];
        const aliasMap = sd?.aliasMap || {};
        const summary  = sd?.summary  || {};
        const wb = XLSX.utils.book_new();

        const bl = summary.bloquants||0, cr2 = summary.a_corriger||0;
        const tT = 3+2+1+Math.round((bl+cr2)*0.1);

        const resumeData = [
          ['RAPPORT DE CONFORMITE e-INVOICING 2026'],['DataRemediation - Confidentiel'],[],
          ['Fichier', row.original_name],['Entreprise', companyName],['Date', new Date().toLocaleDateString('fr-FR')],[],
          ['RESUME'],
          ['Total',      summary.total||results.length],['Conformes', summary.conformes||0],
          ['A corriger', summary.a_corriger||0],['Bloquants', summary.bloquants||0],
          ['Taux',       (summary.taux||0)+'%'],[],
          ['INDICATEURS'],
          ['Temps manuel estime', tT+' heures'],['Avec DataRemediation','5 minutes'],
          ['Cout interne evite', tT*60+' EUR'],['Audit DataRemediation','490 EUR'],
          ['Economie potentielle', (tT*60-490)+' EUR'],
        ];
        const wsR = XLSX.utils.aoa_to_sheet(resumeData);
        wsR['!cols'] = [{wch:30},{wch:50}];
        XLSX.utils.book_append_sheet(wb, wsR, 'Resume');

        const headers = ['Nom fournisseur','Alias','Statut','SIRET valide','TVA valide','SIREN coherent','Erreurs','Recommandation'];
        const cols    = [{wch:35},{wch:12},{wch:15},{wch:14},{wch:12},{wch:16},{wch:40},{wch:60}];
        const toRow   = r => [r.nom_reel||aliasMap[r.alias]||r.alias, r.alias, r.statut||'', r.siret_ok?'OUI':'NON', r.tva_ok?'OUI':'NON', r.siren_coherent?'OUI':'NON', (r.erreurs||[]).join(' | '), r.suggestion||''];

        const wsD = XLSX.utils.aoa_to_sheet([headers, ...results.map(toRow)]);
        wsD['!cols'] = cols;
        XLSX.utils.book_append_sheet(wb, wsD, 'Tous les fournisseurs');

        const blList2 = results.filter(r=>(r.statut||'').includes('Bloquant'));
        if (blList2.length > 0) {
          const ws = XLSX.utils.aoa_to_sheet([headers, ...blList2.map(toRow)]);
          ws['!cols'] = cols;
          XLSX.utils.book_append_sheet(wb, ws, 'Bloquants');
        }
        const crList2 = results.filter(r=>(r.statut||'').includes('corriger'));
        if (crList2.length > 0) {
          const ws = XLSX.utils.aoa_to_sheet([headers, ...crList2.map(toRow)]);
          ws['!cols'] = cols;
          XLSX.utils.book_append_sheet(wb, ws, 'A corriger');
        }
        const cfList = results.filter(r=>(r.statut||'').includes('Conforme'));
        if (cfList.length > 0) {
          const ws = XLSX.utils.aoa_to_sheet([headers, ...cfList.map(toRow)]);
          ws['!cols'] = cols;
          XLSX.utils.book_append_sheet(wb, ws, 'Conformes');
        }

        const buf = XLSX.write(wb, {type:'buffer', bookType:'xlsx'});
        res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="rapport_' + baseName + '.xlsx"');
        res.setHeader('Cache-Control','no-store');
        return res.send(buf);
      } catch(e) {
        return res.status(500).json({ error:'Erreur Excel: '+e.message });
      }
    }

    // PDF
    if (decoded.type === 'pdf') {
      try {
        const sd = typeof row.summary==='string' ? JSON.parse(row.summary) : row.summary;
        const pdfBuffer = await generatePDF(sd, row.original_name, companyName);
        res.setHeader('Content-Type','application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename="rapport_conformite_' + baseName + '.pdf"');
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
