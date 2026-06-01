// routes/reports.js ? Rapport PDF enrichi DataRemediation
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

function truncate(str, max) {
  if (!str) return '';
  str = String(str);
  return str.length > max ? str.slice(0, max) + '...' : str;
}

function drawPageHeader(page, helveticaBold, helvetica, logoImage, title, pageNum, totalPages, W, H) {
  page.drawRectangle({ x:0, y:0, width:W, height:H, color:C.dark });
  page.drawRectangle({ x:0, y:H-5, width:W, height:5, color:C.accent });
  page.drawRectangle({ x:0, y:0, width:4, height:H, color:C.accent });

  const headerH = 50;
  page.drawRectangle({ x:0, y:H-headerH, width:W, height:headerH, color:C.surface });

  if (logoImage) {
    const dims = logoImage.scaleToFit(38, 38);
    page.drawImage(logoImage, { x:16, y:H-headerH/2-dims.height/2, width:dims.width, height:dims.height });
    page.drawText('DataRemediation', { x:16+dims.width+8, y:H-headerH/2+5, size:12, font:helveticaBold, color:C.white });
    page.drawText('Agent IA Conformite Fournisseurs', { x:16+dims.width+8, y:H-headerH/2-7, size:7, font:helvetica, color:C.muted });
  } else {
    page.drawRectangle({ x:16, y:H-headerH+6, width:36, height:36, color:C.accent });
    page.drawText('DR', { x:24, y:H-headerH+18, size:14, font:helveticaBold, color:C.black });
    page.drawText('DataRemediation', { x:60, y:H-headerH+24, size:12, font:helveticaBold, color:C.white });
  }

  page.drawText(title, { x:W-200, y:H-28, size:9, font:helveticaBold, color:C.muted });
  page.drawRectangle({ x:20, y:H-headerH-1, width:W-40, height:1, color:C.accent, opacity:0.3 });

  // Footer
  page.drawRectangle({ x:0, y:0, width:W, height:30, color:C.surface });
  page.drawText('Confidentiel - DataRemediation 2026 - Conformite e-Invoicing', { x:30, y:10, size:6.5, font:helvetica, color:C.muted });
  page.drawText(`Page ${pageNum} / ${totalPages}`, { x:W-54, y:10, size:6.5, font:helvetica, color:C.muted });
}

async function generatePDF(summaryData, fileName, companyName) {
  const pdfDoc        = await PDFDocument.create();
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const helvetica     = await pdfDoc.embedFont(StandardFonts.Helvetica);

  let logoImage = null;
  try {
    const logoPath = path.join(__dirname, '../logo.png');
    if (fs.existsSync(logoPath)) {
      const logoBytes = fs.readFileSync(logoPath);
      logoImage = await pdfDoc.embedPng(logoBytes);
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

  // Calculs enrichis
  const tauxSiret  = total > 0 ? Math.round(results.filter(r=>r.siret_ok).length/total*100) : 0;
  const tauxTva    = total > 0 ? Math.round(results.filter(r=>r.tva_ok).length/total*100) : 0;
  const tauxSiren  = total > 0 ? Math.round(results.filter(r=>r.siren_coherent).length/total*100) : 0;

  // Doublons detectes
  const sirenMap = {};
  results.forEach(r => {
    const siret = String(r.siret||'').replace(/\s/g,'');
    if (siret.length >= 9) {
      const siren = siret.slice(0,9);
      if (!sirenMap[siren]) sirenMap[siren] = [];
      sirenMap[siren].push(r.nom_reel||r.alias);
    }
  });
  const doublons = Object.values(sirenMap).filter(g=>g.length>1).length;
  const tauxDoublons = total > 0 ? Math.round((1-doublons/total)*100) : 100;

  // ROI
  const TEMPS_SIRET_H    = 3;
  const TEMPS_TVA_H      = 2;
  const TEMPS_DOUBLONS_H = 1;
  const TEMPS_CORRECTIONS_H = Math.round((bloquants + corriger) * 0.1);
  const tempsTotal       = TEMPS_SIRET_H + TEMPS_TVA_H + TEMPS_DOUBLONS_H + TEMPS_CORRECTIONS_H;
  const TAUX_HORAIRE     = 60;
  const coutManuel       = tempsTotal * TAUX_HORAIRE;
  const coutAudit        = 490;
  const economie         = coutManuel - coutAudit;

  // Benchmark (simule)
  const scoreMoyen = 65;

  const scoreColor  = taux >= 80 ? C.accent : taux >= 50 ? C.warn : C.danger;
  const scoreLabel  = taux >= 80 ? 'EXCELLENT' : taux >= 60 ? 'BON' : taux >= 40 ? 'MOYEN' : 'CRITIQUE';
  const niveauRisque = taux >= 92 ? 'FAIBLE' : taux >= 75 ? 'MODERE' : taux >= 50 ? 'ELEVE' : 'CRITIQUE';
  const niveauColor  = taux >= 92 ? C.accent : taux >= 75 ? C.warn : C.danger;

  const W = 595, H = 842;
  const TOTAL_PAGES = 4;

  // ??????????????????????????????????????????????????????
  // PAGE 1 ? SYNTHESE DIRIGEANT
  // ??????????????????????????????????????????????????????
  const page1 = pdfDoc.addPage([W, H]);
  drawPageHeader(page1, helveticaBold, helvetica, logoImage, 'SYNTHESE DIRIGEANT', 1, TOTAL_PAGES, W, H);

  // Titre + infos fichier
  let y = H - 75;
  page1.drawText('RAPPORT DE CONFORMITE e-INVOICING 2026', { x:30, y, size:16, font:helveticaBold, color:C.white });
  y -= 18;
  page1.drawText(`Fichier : ${truncate(fileName,55)}`, { x:30, y, size:7.5, font:helvetica, color:C.muted });
  y -= 12;
  page1.drawText(`Entreprise : ${truncate(companyName||'N/A',55)}   |   Date : ${new Date().toLocaleDateString('fr-FR',{day:'2-digit',month:'long',year:'numeric'})}`, { x:30, y, size:7.5, font:helvetica, color:C.muted });
  y -= 20;

  // ?? Bloc score + risque ???????????????????????????????
  page1.drawRectangle({ x:20, y:y-90, width:W-40, height:95, color:C.surface });
  page1.drawRectangle({ x:20, y:y+3, width:W-40, height:3, color:scoreColor });

  // Score
  page1.drawText('SCORE DE CONFORMITE', { x:36, y:y-14, size:7, font:helveticaBold, color:C.muted });
  page1.drawText(taux+'%', { x:36, y:y-54, size:42, font:helveticaBold, color:scoreColor });
  page1.drawText(scoreLabel, { x:36, y:y-70, size:9, font:helveticaBold, color:scoreColor });

  // Separateur vertical
  page1.drawRectangle({ x:160, y:y-82, width:1, height:80, color:C.muted, opacity:0.3 });

  // Risque operationnel
  page1.drawText('RISQUE OPERATIONNEL', { x:172, y:y-14, size:7, font:helveticaBold, color:C.muted });
  page1.drawText(`${bloquants} fournisseurs susceptibles de provoquer`, { x:172, y:y-28, size:8, font:helvetica, color:C.text });
  page1.drawText('un rejet de facture electronique', { x:172, y:y-40, size:8, font:helvetica, color:C.text });
  page1.drawText(`${Math.round((bloquants/total)*100)}% du referentiel fournisseurs non conforme`, { x:172, y:y-54, size:8, font:helvetica, color:C.warn });
  page1.drawText('Niveau de risque :', { x:172, y:y-68, size:7.5, font:helvetica, color:C.muted });
  page1.drawText(niveauRisque, { x:248, y:y-68, size:8, font:helveticaBold, color:niveauColor });

  // Separateur vertical 2
  page1.drawRectangle({ x:380, y:y-82, width:1, height:80, color:C.muted, opacity:0.3 });

  // Temps economise
  page1.drawText('TEMPS ECONOMISE', { x:392, y:y-14, size:7, font:helveticaBold, color:C.muted });
  page1.drawText('Manuel estime :', { x:392, y:y-28, size:7.5, font:helvetica, color:C.muted });
  page1.drawText(`${tempsTotal} heures`, { x:470, y:y-28, size:8, font:helveticaBold, color:C.warn });
  page1.drawText('Avec DataRemediation :', { x:392, y:y-42, size:7.5, font:helvetica, color:C.muted });
  page1.drawText('5 minutes', { x:470, y:y-42, size:8, font:helveticaBold, color:C.accent });
  page1.drawText('Gain :', { x:392, y:y-58, size:7.5, font:helvetica, color:C.muted });
  page1.drawText(`${tempsTotal}h x ${TAUX_HORAIRE}? = ${coutManuel}?`, { x:418, y:y-58, size:8, font:helveticaBold, color:C.accent });

  y -= 106;

  // ?? 4 KPIs ????????????????????????????????????????????
  const kpis = [
    { label:'TOTAL',      value:total,     color:'#3d8eff' },
    { label:'CONFORMES',  value:conformes, color:'#00e5a0' },
    { label:'A CORRIGER', value:corriger,  color:'#ffb340' },
    { label:'BLOQUANTS',  value:bloquants, color:'#ff4566' },
  ];
  const kpiW = (W-60)/4;
  kpis.forEach((k, i) => {
    const kx = 20 + i*(kpiW+6);
    const kColor = hexToRgb(k.color);
    page1.drawRectangle({ x:kx, y:y-72, width:kpiW, height:75, color:C.surface });
    page1.drawRectangle({ x:kx, y:y+1, width:kpiW, height:2, color:kColor });
    page1.drawText(k.label, { x:kx+8, y:y-14, size:6.5, font:helveticaBold, color:C.muted });
    page1.drawText(String(k.value), { x:kx+8, y:y-50, size:28, font:helveticaBold, color:kColor });
  });
  y -= 84;

  // ?? Indice preparation e-Invoicing 2026 ???????????????
  y -= 12;
  page1.drawRectangle({ x:20, y:y-72, width:W-40, height:76, color:C.surface });
  page1.drawRectangle({ x:20, y:y+2, width:W-40, height:3, color:C.blue });
  page1.drawText('INDICE DE PREPARATION FACTURATION ELECTRONIQUE 2026', { x:30, y:y-14, size:8, font:helveticaBold, color:C.blue });

  const jauge = [
    { label:'Preparation globale', value:taux,    color:scoreColor },
    { label:'Objectif recommande', value:90,       color:C.accent   },
    { label:'Ecart a combler',     value:Math.max(0,90-taux), color:C.warn },
  ];
  jauge.forEach((j, i) => {
    const jx = 30 + i*180;
    page1.drawText(j.label.toUpperCase(), { x:jx, y:y-32, size:6, font:helveticaBold, color:C.muted });
    page1.drawText(j.value+'%', { x:jx, y:y-54, size:22, font:helveticaBold, color:j.color });
    // Mini barre
    const bw = 140;
    page1.drawRectangle({ x:jx, y:y-64, width:bw, height:4, color:C.card });
    page1.drawRectangle({ x:jx, y:y-64, width:Math.min(bw*(j.value/100),bw), height:4, color:j.color });
  });

  const readyLabel = taux >= 90 ? 'OK PRET' : taux >= 75 ? '/!\ PARTIELLEMENT PRET' : 'NON NON PRET';
  page1.drawText(readyLabel, { x:440, y:y-44, size:11, font:helveticaBold, color:niveauColor });
  y -= 86;

  // ?? Benchmark ?????????????????????????????????????????
  y -= 12;
  page1.drawRectangle({ x:20, y:y-72, width:W-40, height:76, color:C.surface });
  page1.drawRectangle({ x:20, y:y+2, width:W-40, height:3, color:C.purple });
  page1.drawText('BENCHMARK ? ENTREPRISES SIMILAIRES', { x:30, y:y-14, size:8, font:helveticaBold, color:C.purple });

  // Barre benchmark
  const benchW = W - 100;
  page1.drawText('Score moyen secteur', { x:30, y:y-32, size:7, font:helvetica, color:C.muted });
  page1.drawRectangle({ x:170, y:y-36, width:benchW, height:8, color:C.card });
  page1.drawRectangle({ x:170, y:y-36, width:benchW*(scoreMoyen/100), height:8, color:C.purple, opacity:0.6 });
  page1.drawText(scoreMoyen+'%', { x:170+benchW+6, y:y-34, size:7.5, font:helveticaBold, color:C.purple });

  page1.drawText('Votre score', { x:30, y:y-50, size:7, font:helvetica, color:C.muted });
  page1.drawRectangle({ x:170, y:y-54, width:benchW, height:8, color:C.card });
  page1.drawRectangle({ x:170, y:y-54, width:Math.max(benchW*(taux/100),2), height:8, color:scoreColor });
  page1.drawText(taux+'%', { x:170+benchW+6, y:y-52, size:7.5, font:helveticaBold, color:scoreColor });

  const ecartBench = taux - scoreMoyen;
  page1.drawText(`Ecart vs benchmark : ${ecartBench >= 0 ? '+' : ''}${ecartBench} points`, {
    x:30, y:y-66, size:7.5, font:helveticaBold,
    color: ecartBench >= 0 ? C.accent : C.danger
  });

  // ??????????????????????????????????????????????????????
  // PAGE 2 ? SCORES PAR CATEGORIE + ESTIMATION FINANCIERE
  // ??????????????????????????????????????????????????????
  const page2 = pdfDoc.addPage([W, H]);
  drawPageHeader(page2, helveticaBold, helvetica, logoImage, 'ANALYSE DETAILLEE', 2, TOTAL_PAGES, W, H);

  y = H - 75;

  // ?? Score par categorie ???????????????????????????????
  page2.drawText('SCORE PAR CATEGORIE', { x:30, y, size:11, font:helveticaBold, color:C.white });
  page2.drawText('Ou agir en priorite', { x:30, y:y-14, size:8, font:helvetica, color:C.muted });
  y -= 26;

  const categories = [
    { label:'SIRET / SIREN',       value:tauxSiret,   color:tauxSiret>=80?C.accent:tauxSiret>=50?C.warn:C.danger,   desc: tauxSiret < 80 ? 'Action prioritaire' : 'Satisfaisant' },
    { label:'TVA Intracommunautaire', value:tauxTva,  color:tauxTva>=80?C.accent:tauxTva>=50?C.warn:C.danger,       desc: tauxTva < 80 ? 'A verifier' : 'Satisfaisant' },
    { label:'Coherence SIREN/TVA',  value:tauxSiren,  color:tauxSiren>=80?C.accent:tauxSiren>=50?C.warn:C.danger,   desc: tauxSiren < 80 ? 'Risque fiscal' : 'Satisfaisant' },
    { label:'Absence de doublons',  value:tauxDoublons, color:tauxDoublons>=80?C.accent:tauxDoublons>=50?C.warn:C.danger, desc: tauxDoublons < 80 ? 'Doublons detectes' : 'Satisfaisant' },
  ];

  categories.forEach((cat, i) => {
    const cx = 20;
    const cy = y - i*52;
    page2.drawRectangle({ x:cx, y:cy-44, width:W-40, height:46, color:C.surface });
    page2.drawRectangle({ x:cx, y:cy-44, width:3, height:46, color:cat.color });

    // Label
    page2.drawText(cat.label, { x:cx+12, y:cy-12, size:8.5, font:helveticaBold, color:C.text });
    page2.drawText(cat.desc, { x:cx+12, y:cy-26, size:7, font:helvetica, color:cat.color });

    // Score
    page2.drawText(cat.value+'%', { x:W-90, y:cy-22, size:18, font:helveticaBold, color:cat.color });

    // Barre de progression
    const barW = W - 220;
    page2.drawRectangle({ x:cx+160, y:cy-28, width:barW, height:8, color:C.card });
    page2.drawRectangle({ x:cx+160, y:cy-28, width:Math.min(barW*(cat.value/100), barW), height:8, color:cat.color });
  });

  y -= 4*52 + 20;

  // ?? Temps economise detaille ??????????????????????????
  y -= 12;
  page2.drawText('DETAIL DU TEMPS ECONOMISE', { x:30, y, size:11, font:helveticaBold, color:C.white });
  page2.drawText('Estimation de traitement manuel vs DataRemediation', { x:30, y:y-14, size:8, font:helvetica, color:C.muted });
  y -= 26;

  const timeRows = [
    { label:'Verification SIRET / SIREN',    temps:`${TEMPS_SIRET_H} h` },
    { label:'Verification TVA',               temps:`${TEMPS_TVA_H} h` },
    { label:'Recherche doublons',             temps:`${TEMPS_DOUBLONS_H} h` },
    { label:'Corrections manuelles (estimees)', temps:`${TEMPS_CORRECTIONS_H} h` },
  ];

  // Header tableau
  page2.drawRectangle({ x:20, y:y-16, width:W-40, height:18, color:C.surface });
  page2.drawRectangle({ x:20, y:y, width:W-40, height:2, color:C.accent });
  page2.drawText('CONTROLE', { x:30, y:y-11, size:7, font:helveticaBold, color:C.muted });
  page2.drawText('TEMPS MANUEL', { x:W-120, y:y-11, size:7, font:helveticaBold, color:C.muted });
  y -= 20;

  timeRows.forEach((row, i) => {
    page2.drawRectangle({ x:20, y:y-16, width:W-40, height:18, color: i%2===0 ? C.surface : C.card });
    page2.drawText(row.label, { x:30, y:y-10, size:8, font:helvetica, color:C.text });
    page2.drawText(row.temps, { x:W-100, y:y-10, size:8, font:helveticaBold, color:C.warn });
    y -= 18;
  });

  // Total
  page2.drawRectangle({ x:20, y:y-18, width:W-40, height:20, color:C.surface });
  page2.drawRectangle({ x:20, y:y, width:W-40, height:2, color:C.accent });
  page2.drawText('TEMPS TOTAL ESTIME :', { x:30, y:y-13, size:8.5, font:helveticaBold, color:C.text });
  page2.drawText(`${tempsTotal} heures`, { x:W-120, y:y-13, size:9, font:helveticaBold, color:C.warn });
  y -= 30;

  page2.drawRectangle({ x:20, y:y-16, width:W-40, height:18, color:C.card });
  page2.drawText('Avec DataRemediation :', { x:30, y:y-10, size:8.5, font:helveticaBold, color:C.text });
  page2.drawText('5 minutes', { x:W-100, y:y-10, size:9, font:helveticaBold, color:C.accent });
  y -= 30;

  // ?? Estimation financiere ??????????????????????????????
  y -= 16;
  page2.drawText('ESTIMATION FINANCIERE', { x:30, y, size:11, font:helveticaBold, color:C.white });
  page2.drawText('Valeur generee par DataRemediation', { x:30, y:y-14, size:8, font:helvetica, color:C.muted });
  y -= 26;

  const finBlocs = [
    { label:'Cout interne estime',         value:`${tempsTotal}h x ${TAUX_HORAIRE}?/h = ${coutManuel}?`, color:'#ffb340', desc:'Traitement manuel' },
    { label:'Audit DataRemediation',       value:`${coutAudit}?`, color:'#3d8eff', desc:'Tarif audit ponctuel' },
    { label:'Economie potentielle',        value:`${economie}?`, color:'#00e5a0', desc:'+ securisation conformite 2026' },
  ];

  finBlocs.forEach((b, i) => {
    const bx = 20 + i * ((W-50)/3 + 5);
    const bw = (W-50)/3;
    const bColor = hexToRgb(b.color);
    page2.drawRectangle({ x:bx, y:y-72, width:bw, height:75, color:C.surface });
    page2.drawRectangle({ x:bx, y:y+1, width:bw, height:3, color:bColor });
    page2.drawText(b.label.toUpperCase(), { x:bx+8, y:y-14, size:6, font:helveticaBold, color:C.muted });
    page2.drawText(b.value, { x:bx+8, y:y-40, size:13, font:helveticaBold, color:bColor });
    page2.drawText(b.desc, { x:bx+8, y:y-60, size:6.5, font:helvetica, color:C.muted });
  });

  // ??????????????????????????????????????????????????????
  // PAGE 3 ? TOP 10 PRIORITAIRES + ANOMALIES
  // ??????????????????????????????????????????????????????
  const page3 = pdfDoc.addPage([W, H]);
  drawPageHeader(page3, helveticaBold, helvetica, logoImage, 'PLAN DE REMEDIATION', 3, TOTAL_PAGES, W, H);

  y = H - 75;

  // ?? Top 10 prioritaires ???????????????????????????????
  page3.drawText('TOP 10 ? FOURNISSEURS A TRAITER EN PRIORITE', { x:30, y, size:11, font:helveticaBold, color:C.white });
  page3.drawText('Classement par niveau d\'urgence', { x:30, y:y-14, size:8, font:helvetica, color:C.muted });
  y -= 26;

  const prioritaires = results
    .filter(r => (r.statut||'').includes('Bloquant') || (r.statut||'').includes('corriger'))
    .slice(0, 10);

  if (prioritaires.length === 0) {
    page3.drawRectangle({ x:20, y:y-40, width:W-40, height:44, color:C.surface });
    page3.drawText('Aucun fournisseur bloquant ou a corriger detecte.', { x:30, y:y-22, size:9, font:helvetica, color:C.accent });
    y -= 56;
  } else {
    // Header
    page3.drawRectangle({ x:20, y:y-16, width:W-40, height:18, color:C.surface });
    page3.drawRectangle({ x:20, y:y, width:W-40, height:2, color:C.accent });
    page3.drawText('#',          { x:26,  y:y-11, size:6.5, font:helveticaBold, color:C.muted });
    page3.drawText('FOURNISSEUR',{ x:42,  y:y-11, size:6.5, font:helveticaBold, color:C.muted });
    page3.drawText('PRIORITE',   { x:230, y:y-11, size:6.5, font:helveticaBold, color:C.muted });
    page3.drawText('PROBLEME',   { x:300, y:y-11, size:6.5, font:helveticaBold, color:C.muted });
    page3.drawText('ACTION',     { x:440, y:y-11, size:6.5, font:helveticaBold, color:C.muted });
    y -= 20;

    prioritaires.forEach((r, i) => {
      const isBlock = (r.statut||'').includes('Bloquant');
      const sColor  = isBlock ? C.danger : C.warn;
      const prioLabel = isBlock ? 'CRITIQUE' : 'MODEREE';
      const nom = truncate(r.nom_reel || aliasMap[r.alias] || r.alias, 28);
      const probleme = truncate(!r.siret_ok ? 'SIRET manquant/invalide' : !r.tva_ok ? 'TVA manquante/invalide' : 'SIREN incoherent', 22);
      const action = truncate(!r.siret_ok ? 'Contacter fournisseur' : !r.tva_ok ? 'Verifier TVA VIES' : 'Verifier coherence', 20);

      page3.drawRectangle({ x:20, y:y-16, width:W-40, height:18, color:i%2===0?C.surface:C.card });
      page3.drawRectangle({ x:20, y:y-16, width:2, height:18, color:sColor });

      page3.drawText(String(i+1), { x:26, y:y-10, size:7, font:helveticaBold, color:C.muted });
      page3.drawText(nom, { x:42, y:y-10, size:7.5, font:helveticaBold, color:C.text });
      page3.drawText(prioLabel, { x:230, y:y-10, size:6.5, font:helveticaBold, color:sColor });
      page3.drawText(probleme, { x:300, y:y-10, size:6.5, font:helvetica, color:C.text });
      page3.drawText(action, { x:440, y:y-10, size:6.5, font:helvetica, color:C.accent });
      y -= 18;
    });
  }

  y -= 20;

  // ?? Anomalies detaillees ??????????????????????????????
  const bloquantsList = results.filter(r => (r.statut||'').includes('Bloquant')).slice(0, 8);
  const corrigerList  = results.filter(r => (r.statut||'').includes('corriger')).slice(0, 5);

  if (bloquantsList.length > 0 && y > 200) {
    page3.drawRectangle({ x:20, y:y-22, width:W-40, height:24, color:C.surface });
    page3.drawRectangle({ x:20, y:y-22, width:3, height:24, color:C.danger });
    page3.drawText(`FOURNISSEURS BLOQUANTS (${bloquants})`, { x:28, y:y-13, size:8.5, font:helveticaBold, color:C.danger });
    y -= 30;

    bloquantsList.forEach(r => {
      if (y < 80) return;
      const nom = truncate(r.nom_reel || aliasMap[r.alias] || r.alias, 38);
      const err = truncate((r.erreurs||[]).join(' - '), 60);
      const hasRec = !!r.suggestion;
      const rowH = hasRec ? 40 : 26;
      page3.drawRectangle({ x:20, y:y-rowH, width:W-40, height:rowH, color:C.card });
      page3.drawRectangle({ x:20, y:y-rowH, width:3, height:rowH, color:C.danger });
      page3.drawText(nom, { x:28, y:y-10, size:8, font:helveticaBold, color:C.white });
      page3.drawText(err, { x:28, y:y-20, size:7, font:helvetica, color:C.muted });
      if (hasRec) page3.drawText('-> '+truncate(r.suggestion,80), { x:28, y:y-30, size:7, font:helvetica, color:C.accent });
      y -= rowH + 4;
    });
  }

  if (corrigerList.length > 0 && y > 120) {
    y -= 8;
    page3.drawRectangle({ x:20, y:y-22, width:W-40, height:24, color:C.surface });
    page3.drawRectangle({ x:20, y:y-22, width:3, height:24, color:C.warn });
    page3.drawText(`FOURNISSEURS A CORRIGER (${corriger})`, { x:28, y:y-13, size:8.5, font:helveticaBold, color:C.warn });
    y -= 30;

    corrigerList.forEach(r => {
      if (y < 80) return;
      const nom = truncate(r.nom_reel || aliasMap[r.alias] || r.alias, 38);
      const err = truncate((r.erreurs||[]).join(' - '), 60);
      const hasRec = !!r.suggestion;
      const rowH = hasRec ? 40 : 26;
      page3.drawRectangle({ x:20, y:y-rowH, width:W-40, height:rowH, color:C.card });
      page3.drawRectangle({ x:20, y:y-rowH, width:3, height:rowH, color:C.warn });
      page3.drawText(nom, { x:28, y:y-10, size:8, font:helveticaBold, color:C.white });
      page3.drawText(err, { x:28, y:y-20, size:7, font:helvetica, color:C.muted });
      if (hasRec) page3.drawText('-> '+truncate(r.suggestion,80), { x:28, y:y-30, size:7, font:helvetica, color:C.accent });
      y -= rowH + 4;
    });
  }

  // ??????????????????????????????????????????????????????
  // PAGE 4 ? LISTE COMPLETE
  // ??????????????????????????????????????????????????????
  const page4 = pdfDoc.addPage([W, H]);
  drawPageHeader(page4, helveticaBold, helvetica, logoImage, `LISTE COMPLETE ? ${total} FOURNISSEURS`, 4, TOTAL_PAGES, W, H);

  y = H - 72;

  // En-tete tableau
  page4.drawRectangle({ x:20, y:y-16, width:W-40, height:18, color:C.surface });
  page4.drawRectangle({ x:20, y:y, width:W-40, height:2, color:C.accent });
  page4.drawText('Fournisseur',    { x:26,  y:y-11, size:6.5, font:helveticaBold, color:C.muted });
  page4.drawText('Statut',         { x:220, y:y-11, size:6.5, font:helveticaBold, color:C.muted });
  page4.drawText('SIRET',          { x:275, y:y-11, size:6.5, font:helveticaBold, color:C.muted });
  page4.drawText('TVA',            { x:316, y:y-11, size:6.5, font:helveticaBold, color:C.muted });
  page4.drawText('SIREN OK',       { x:348, y:y-11, size:6.5, font:helveticaBold, color:C.muted });
  page4.drawText('Recommandation', { x:395, y:y-11, size:6.5, font:helveticaBold, color:C.muted });
  y -= 20;

  results.slice(0, 44).forEach((r, i) => {
    if (y < 44) return;
    const isConf  = (r.statut||'').includes('Conforme');
    const isBlock = (r.statut||'').includes('Bloquant');
    const sColor  = isConf ? C.accent : isBlock ? C.danger : C.warn;
    const statut  = isConf ? 'Conforme' : isBlock ? 'Bloquant' : 'Corriger';

    page4.drawRectangle({ x:20, y:y-14, width:W-40, height:16, color:i%2===0?C.surface:C.card });
    page4.drawRectangle({ x:20, y:y-14, width:2, height:16, color:sColor });

    page4.drawText(truncate(r.nom_reel||aliasMap[r.alias]||r.alias, 30), { x:26,  y:y-9, size:6.5, font:helvetica,     color:C.text });
    page4.drawText(statut,                                                 { x:220, y:y-9, size:6.5, font:helveticaBold, color:sColor });
    page4.drawText(r.siret_ok?'OUI':'NON', { x:275, y:y-9, size:6.5, font:helveticaBold, color:r.siret_ok?C.accent:C.danger });
    page4.drawText(r.tva_ok?'OUI':'NON',   { x:316, y:y-9, size:6.5, font:helveticaBold, color:r.tva_ok?C.accent:C.danger });
    page4.drawText(r.siren_coherent?'OUI':'NON', { x:348, y:y-9, size:6.5, font:helveticaBold, color:r.siren_coherent?C.accent:C.danger });
    page4.drawText(truncate(r.suggestion||'',28), { x:395, y:y-9, size:5.5, font:helvetica, color:C.muted });
    y -= 16;
  });

  if (results.length > 44) {
    page4.drawText(`... et ${results.length-44} autres fournisseurs ? voir fichier Excel pour la liste complete`, {
      x:26, y:y+2, size:7, font:helvetica, color:C.muted
    });
  }

  return Buffer.from(await pdfDoc.save());
}

// ?? POST /api/reports/:fileId/link ????????????????????????????????????????????
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

// ?? GET /api/reports/download/:token ?????????????????????????????????????????
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

    // ?? Export Excel ??????????????????????????????????????
    if (decoded.type === 'csv') {
      try {
        const summaryData = typeof row.summary === 'string' ? JSON.parse(row.summary) : row.summary;
        const results  = summaryData?.results  || [];
        const aliasMap = summaryData?.aliasMap  || {};
        const summary  = summaryData?.summary   || {};
        const wb = XLSX.utils.book_new();

        const total     = summary.total || results.length;
        const conformes = summary.conformes || 0;
        const corriger  = summary.a_corriger || 0;
        const bloquants = summary.bloquants || 0;
        const taux      = summary.taux || 0;
        const tempsTotal = 3 + 2 + 1 + Math.round((bloquants+corriger)*0.1);

        const resumeData = [
          ['RAPPORT DE CONFORMITE e-INVOICING 2026'],
          ['DataRemediation - Confidentiel'],[],
          ['Fichier analyse', row.original_name],
          ['Entreprise', companyName],
          ['Date', new Date().toLocaleDateString('fr-FR')],[],
          ['RESUME EXECUTIF'],
          ['Total fournisseurs', total],
          ['Conformes', conformes],
          ['A corriger', corriger],
          ['Bloquants', bloquants],
          ['Taux de conformite', taux+'%'],[],
          ['INDICATEURS DE VALEUR'],
          ['Temps manuel estime', tempsTotal+' heures'],
          ['Avec DataRemediation', '5 minutes'],
          ['Cout interne evite', tempsTotal*60+' ?'],
          ['Cout audit DataRemediation', '490 ?'],
          ['Economie potentielle', (tempsTotal*60-490)+' ?'],
        ];
        const wsR = XLSX.utils.aoa_to_sheet(resumeData);
        wsR['!cols'] = [{ wch:35 },{ wch:50 }];
        XLSX.utils.book_append_sheet(wb, wsR, 'Resume');

        const headers = ['Nom fournisseur','Alias','Statut','SIRET valide','TVA valide','SIREN coherent','Erreurs','Recommandation'];
        const cols = [{ wch:35 },{ wch:12 },{ wch:15 },{ wch:14 },{ wch:12 },{ wch:16 },{ wch:40 },{ wch:60 }];
        const toRow = r => [r.nom_reel||aliasMap[r.alias]||r.alias, r.alias, r.statut||'', r.siret_ok?'OUI':'NON', r.tva_ok?'OUI':'NON', r.siren_coherent?'OUI':'NON', (r.erreurs||[]).join(' | '), r.suggestion||''];

        const wsD = XLSX.utils.aoa_to_sheet([headers, ...results.map(toRow)]);
        wsD['!cols'] = cols;
        XLSX.utils.book_append_sheet(wb, wsD, 'Tous les fournisseurs');

        const bloquantsList = results.filter(r => (r.statut||'').includes('Bloquant'));
        if (bloquantsList.length > 0) {
          const ws = XLSX.utils.aoa_to_sheet([headers, ...bloquantsList.map(toRow)]);
          ws['!cols'] = cols;
          XLSX.utils.book_append_sheet(wb, ws, 'Bloquants');
        }

        const corrigerList = results.filter(r => (r.statut||'').includes('corriger'));
        if (corrigerList.length > 0) {
          const ws = XLSX.utils.aoa_to_sheet([headers, ...corrigerList.map(toRow)]);
          ws['!cols'] = cols;
          XLSX.utils.book_append_sheet(wb, ws, 'A corriger');
        }

        const conformesList = results.filter(r => (r.statut||'').includes('Conforme'));
        if (conformesList.length > 0) {
          const ws = XLSX.utils.aoa_to_sheet([headers, ...conformesList.map(toRow)]);
          ws['!cols'] = cols;
          XLSX.utils.book_append_sheet(wb, ws, 'Conformes');
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

    // ?? Export PDF ????????????????????????????????????????
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
