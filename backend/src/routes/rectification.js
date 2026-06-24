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
    page.drawText('Agent IA Conformite Fournisseurs', { x:14+dims.width+8, y:H-hH/2-7, size:6.5, font:h, color:C.muted });
  } else {
    page.drawRectangle({ x:14, y:H-hH+6, width:34, height:34, color:C.accent });
    page.drawText('DR', { x:22, y:H-hH+16, size:13, font:hB, color:C.black });
    page.drawText('DataRemediation', { x:56, y:H-hH+22, size:11, font:hB, color:C.white });
  }
  page.drawText(s(title), { x:W-180, y:H-26, size:8, font:hB, color:C.muted });
  page.drawRectangle({ x:18, y:H-hH-1, width:W-36, height:1, color:C.accent, opacity:0.3 });
  page.drawRectangle({ x:0, y:0, width:W, height:28, color:C.surface });
  page.drawText('Confidentiel - DataRemediation 2026 - Conformite e-Invoicing', { x:28, y:9, size:6, font:h, color:C.muted });
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

  const stats      = rapport.statistiques        || {};
  const score      = rapport.score_qualite       || {};
  const scoreCateg = rapport.score_par_categorie || {};
  const risquePDP  = rapport.risque_pdp          || {};
  const roi        = rapport.roi                 || {};
  const planAction = rapport.plan_action         || [];
  const details    = rapport.details             || [];
  const exclus     = rapport.exclus              || [];
  const meta       = rapport.meta               || {};

  const niveauColor = risquePDP.niveau === 'CRITIQUE' ? C.danger :
                      risquePDP.niveau === 'ELEVE'    ? C.warn   :
                      risquePDP.niveau === 'MODERE'   ? C.blue   : C.green;
  const scoreColor  = score.valeur >= 70 ? C.green : score.valeur >= 40 ? C.warn : C.danger;

  const W = 595, H = 842, TP = 4;

  // ══════════════════════════════════════════════
  // PAGE 1 — SYNTHESE DIRIGEANT
  // ══════════════════════════════════════════════
  const p1 = pdfDoc.addPage([W, H]);
  drawHeader(p1, hB, h, logoImage, 'SYNTHESE DIRIGEANT', 1, TP, W, H);

  let y = H - 68;

  // Titre
  p1.drawText('RAPPORT DE CONFORMITE e-INVOICING 2026', { x:28, y, size:14, font:hB, color:C.white });
  y -= 14;
  p1.drawText('Fichier : ' + t(nomFichier,50), { x:28, y, size:7.5, font:h, color:C.muted });
  y -= 12;
  p1.drawText('Entreprise : ' + t(companyName||'N/A',30) + '   |   Date : ' + new Date().toLocaleDateString('fr-FR'), { x:28, y, size:7.5, font:h, color:C.muted });
  y -= 22;

  // ── Bloc score + risque + temps
  p1.drawRectangle({ x:18, y:y-88, width:W-36, height:92, color:C.surface });
  p1.drawRectangle({ x:18, y:y+2,  width:W-36, height:3,  color:scoreColor });

  // Score conformité
  p1.drawText('SCORE CONFORMITE', { x:32, y:y-14, size:7, font:hB, color:C.muted });
  p1.drawText(score.valeur + '%', { x:32, y:y-50, size:36, font:hB, color:scoreColor });
  p1.drawText(s(score.mention||''), { x:32, y:y-66, size:9, font:hB, color:scoreColor });

  p1.drawRectangle({ x:155, y:y-82, width:1, height:80, color:C.muted, opacity:0.3 });

  // Risque opérationnel
  p1.drawText('RISQUE OPERATIONNEL', { x:165, y:y-14, size:7, font:hB, color:C.muted });
  p1.drawText((risquePDP.fournisseurs_bloquants||0) + ' fournisseurs a risque de rejet', { x:165, y:y-28, size:7.5, font:h, color:C.text });
  p1.drawText((stats.taux_anomalies||0) + '% du referentiel non conforme', { x:165, y:y-40, size:7.5, font:h, color:C.text });
  p1.drawText('Niveau : ' + s(risquePDP.niveau||'N/A'), { x:165, y:y-54, size:8, font:hB, color:niveauColor });
  p1.drawText('Score financier risque : ' + (risquePDP.score_conformite_pdp >= 70 ? 'MODERE' : 'ELEVE'), { x:165, y:y-66, size:7.5, font:h, color:risquePDP.score_conformite_pdp >= 70 ? C.warn : C.danger });

  p1.drawRectangle({ x:376, y:y-82, width:1, height:80, color:C.muted, opacity:0.3 });

  // Temps économisé (SANS remédiation auto)
  p1.drawText('TEMPS ECONOMISE', { x:386, y:y-14, size:7, font:hB, color:C.muted });
  p1.drawText('Manuel estime : ' + (roi.temps_manuel_h||0) + ' heures', { x:386, y:y-28, size:7.5, font:h, color:C.warn });
  p1.drawText('DataRemediation : ' + (roi.temps_analyse_min||roi.temps_automatise_min||5) + ' minutes', { x:386, y:y-40, size:7.5, font:h, color:C.accent });
  p1.drawText('Gain : ~' + (roi.cout_manuel_eur||0) + ' EUR evites', { x:386, y:y-54, size:7.5, font:hB, color:C.accent });
  // SUPPRIME : "Remediation auto : X%" — remplacé par info exclus
  p1.drawText('Entrees exclues : ' + (meta.total_exclus||exclus.length||0), { x:386, y:y-68, size:7, font:h, color:C.muted });

  y -= 102;

  // ── Note sur les exclus (si > 0)
  if ((meta.total_exclus||0) > 0 || exclus.length > 0) {
    const nbExclus = meta.total_exclus || exclus.length || 0;
    const nbCat    = stats.nb_categories_depense || 0;
    const nbPonct  = stats.nb_ponctuels          || 0;
    p1.drawRectangle({ x:18, y:y-34, width:W-36, height:36, color:C.card });
    p1.drawRectangle({ x:18, y:y+2,  width:W-36, height:2,  color:C.blue });
    p1.drawText('NOTE : ' + nbExclus + ' entrees exclues du score (categories comptables : ' + nbCat + ', enseignes ponctuelles : ' + nbPonct + ')', { x:26, y:y-14, size:7.5, font:hB, color:C.blue });
    p1.drawText('Score fournisseurs reels : ' + score.valeur + '% (' + (meta.total_fournisseurs_reels||stats.total||0) + ' fournisseurs analyses)', { x:26, y:y-26, size:7, font:h, color:C.muted });
    y -= 44;
  }

  y -= 8;

  // ── KPIs (4 colonnes)
  const kpis = [
    { label:'TOTAL',      value: meta.total_lignes || stats.total || 0, color:'#3d8eff' },
    { label:'CONFORMES',  value: stats.valides  || 0,                   color:'#00e5a0' },
    { label:'A CORRIGER', value: stats.anomalies|| 0,                   color:'#ffb340' },
    { label:'BLOQUANTS',  value: (stats.sans_siret||0) + (stats.siret_invalide||0), color:'#ff4566' },
  ];
  const kW = (W-48)/4;
  kpis.forEach((k, i) => {
    const kx = 18 + i*(kW+5);
    const kC = rgb(parseInt(k.color.slice(1,3),16)/255, parseInt(k.color.slice(3,5),16)/255, parseInt(k.color.slice(5,7),16)/255);
    p1.drawRectangle({ x:kx, y:y-68, width:kW, height:70, color:C.surface });
    p1.drawRectangle({ x:kx, y:y+1,  width:kW, height:2,  color:kC });
    p1.drawText(k.label, { x:kx+8, y:y-14, size:6.5, font:hB, color:C.muted });
    p1.drawText(String(k.value), { x:kx+8, y:y-46, size:26, font:hB, color:kC });
  });
  y -= 80;

  // ── Matrice de criticité
  y -= 12;
  const critique = details.filter(d => d.anomalies?.some(a=>a.champ==='siret') && d.anomalies?.some(a=>a.champ==='tva')).length;
  const elevee   = details.filter(d => {
    const hasId  = d.anomalies?.some(a=>a.champ==='siret'||a.champ==='tva');
    const hasBoth= d.anomalies?.some(a=>a.champ==='siret') && d.anomalies?.some(a=>a.champ==='tva');
    return hasId && !hasBoth;
  }).length;
  const moyenne  = details.filter(d => d.anomalies?.some(a=>a.champ==='tva') && !d.anomalies?.some(a=>a.champ==='siret')).length;
  const faible   = details.filter(d => d.statut==='ANOMALIE' && !d.anomalies?.some(a=>a.champ==='siret') && !d.anomalies?.some(a=>a.champ==='tva')).length;

  p1.drawRectangle({ x:18, y:y-72, width:W-36, height:74, color:C.surface });
  p1.drawRectangle({ x:18, y:y+2,  width:W-36, height:2,  color:C.purple });
  p1.drawText('MATRICE DE CRITICITE', { x:28, y:y-14, size:8, font:hB, color:C.purple });

  const matW = (W-52)/4;
  const matItems = [
    { val: critique, label:'Critique (SIRET + TVA abs.)', color:C.danger },
    { val: elevee,   label:'Elevee (un identifiant abs.)', color:C.warn },
    { val: moyenne,  label:'Moyenne (TVA a corriger)',     color:C.blue },
    { val: faible,   label:'Faible (autres anomalies)',    color:C.muted },
  ];
  matItems.forEach((m, i) => {
    const mx = 22 + i*(matW+4);
    p1.drawText(String(m.val), { x:mx+6, y:y-40, size:22, font:hB, color:m.color });
    p1.drawRectangle({ x:mx, y:y-52, width:matW-4, height:3, color:m.color });
    p1.drawText(t(m.label,22), { x:mx, y:y-62, size:5.5, font:h, color:C.muted });
  });
  y -= 84;

  // ── Indice de préparation e-Invoicing
  y -= 12;
  p1.drawRectangle({ x:18, y:y-62, width:W-36, height:64, color:C.surface });
  p1.drawRectangle({ x:18, y:y+2,  width:W-36, height:2,  color:C.blue });
  p1.drawText('INDICE DE PREPARATION e-INVOICING 2026', { x:28, y:y-14, size:8, font:hB, color:C.blue });

  const bW = W - 200;
  const indice = [
    { label:'PREPARATION GLOBALE', val:score.valeur,  color:scoreColor },
    { label:'OBJECTIF CIBLE',      val:90,            color:C.green },
    { label:'ECART A COMBLER',     val:Math.max(0, 90-score.valeur), color:score.valeur>=90?C.green:C.danger, suffix: score.valeur>=90?' OK':' X NON PRET' },
  ];
  indice.forEach((b, i) => {
    const by = y - 28 - i*16;
    p1.drawText(b.label, { x:28, y:by, size:6.5, font:hB, color:C.muted });
    p1.drawRectangle({ x:178, y:by-4, width:bW, height:8, color:C.card });
    p1.drawRectangle({ x:178, y:by-4, width:Math.min(bW*(b.val/100),bW), height:8, color:b.color });
    p1.drawText(b.val+'%'+(b.suffix||''), { x:178+bW+6, y:by, size:7.5, font:hB, color:b.color });
  });

  // ══════════════════════════════════════════════
  // PAGE 2 — ANALYSE DETAILLEE
  // ══════════════════════════════════════════════
  const p2 = pdfDoc.addPage([W, H]);
  drawHeader(p2, hB, h, logoImage, 'ANALYSE DETAILLEE', 2, TP, W, H);

  y = H - 68;
  p2.drawText('SCORE PAR CATEGORIE', { x:28, y, size:11, font:hB, color:C.white });
  p2.drawText('Ou agir en priorite', { x:28, y:y-13, size:7.5, font:h, color:C.muted });
  y -= 28;

  Object.entries(scoreCateg).forEach(([key, cat]) => {
    if (y < 120) return;
    const cVal = cat.score || 0;
    const cC   = cVal >= 80 ? C.green : cVal >= 50 ? C.warn : C.danger;
    const sub  = cVal >= 80 ? 'Satisfaisant' : cVal >= 50 ? 'A verifier' : 'Action prioritaire';
    p2.drawRectangle({ x:18, y:y-38, width:W-36, height:40, color:C.surface });
    p2.drawRectangle({ x:18, y:y-38, width:3,    height:40, color:cC });
    p2.drawText(s(cat.libelle||key), { x:28, y:y-12, size:8.5, font:hB, color:C.text });
    p2.drawText(sub, { x:28, y:y-26, size:7, font:h, color:cC });
    p2.drawText(cVal+'%', { x:W-74, y:y-20, size:17, font:hB, color:cC });
    const bw2 = W-200;
    p2.drawRectangle({ x:155, y:y-24, width:bw2, height:8, color:C.card });
    p2.drawRectangle({ x:155, y:y-24, width:Math.min(bw2*(cVal/100),bw2), height:8, color:cC });
    y -= 46;
  });

  y -= 16;

  // Priorité business
  const bloquantsReels = (stats.sans_siret||0) + (stats.siret_invalide||0);
  const acorriger      = stats.anomalies - bloquantsReels;
  const surveillance   = stats.valides || 0;

  p2.drawRectangle({ x:18, y:y-72, width:W-36, height:74, color:C.surface });
  p2.drawRectangle({ x:18, y:y+2,  width:W-36, height:2,  color:C.purple });
  p2.drawText('PRIORITE BUSINESS', { x:28, y:y-14, size:8, font:hB, color:C.purple });

  const pW = (W-52)/3;
  const pItems = [
    { val:bloquantsReels, label:'CORRECTION IMMEDIATE', sub:'Fournisseurs bloquants reels', color:C.danger },
    { val:Math.max(0,acorriger), label:'CORRECTION SOUS 30J', sub:'A corriger manuellement', color:C.warn },
    { val:surveillance,   label:'SURVEILLANCE',         sub:'Conformes a surveiller',      color:C.green },
  ];
  pItems.forEach((p, i) => {
    const px = 22 + i*(pW+4);
    p2.drawText(String(p.val), { x:px+6, y:y-40, size:22, font:hB, color:p.color });
    p2.drawRectangle({ x:px, y:y-52, width:pW-4, height:3, color:p.color });
    p2.drawText(p.label,   { x:px, y:y-60, size:5.5, font:hB, color:p.color });
    p2.drawText(s(p.sub),  { x:px, y:y-70, size:5,   font:h,  color:C.muted });
  });
  y -= 84;

  // Estimation financière (SANS mention remédiation auto)
  y -= 16;
  p2.drawText('ESTIMATION FINANCIERE', { x:28, y, size:10, font:hB, color:C.white });
  y -= 20;

  p2.drawRectangle({ x:18, y:y-68, width:W-36, height:70, color:C.surface });
  p2.drawRectangle({ x:18, y:y+2,  width:W-36, height:2,  color:C.accent });

  const colW3 = (W-52)/3;
  // Col 1 : coût interne
  p2.drawText('COUT INTERNE ESTIME', { x:28, y:y-14, size:6.5, font:hB, color:C.muted });
  p2.drawText((roi.temps_manuel_h||0)+'h x 55 EUR/h = '+(roi.cout_manuel_eur||0)+' EUR', { x:28, y:y-34, size:8, font:hB, color:C.warn });
  p2.drawText('Traitement manuel', { x:28, y:y-48, size:7, font:h, color:C.muted });

  p2.drawRectangle({ x:22+colW3, y:y-62, width:1, height:60, color:C.muted, opacity:0.3 });

  // Col 2 : audit DataRemédiation
  const x2 = 28 + colW3;
  p2.drawText('AUDIT DATAREMEDIATION', { x:x2, y:y-14, size:6.5, font:hB, color:C.muted });
  p2.drawText('490 EUR', { x:x2, y:y-34, size:14, font:hB, color:C.blue });
  p2.drawText('Tarif audit ponctuel', { x:x2, y:y-48, size:7, font:h, color:C.muted });

  p2.drawRectangle({ x:22+colW3*2, y:y-62, width:1, height:60, color:C.muted, opacity:0.3 });

  // Col 3 : économie
  const x3 = 28 + colW3*2;
  const economie = Math.max(0, (roi.cout_manuel_eur||0) - 490);
  p2.drawText('ECONOMIE POTENTIELLE', { x:x3, y:y-14, size:6.5, font:hB, color:C.muted });
  p2.drawText(economie + ' EUR', { x:x3, y:y-34, size:14, font:hB, color:C.accent });
  p2.drawText('+ securisation conformite 2026', { x:x3, y:y-48, size:7, font:h, color:C.muted });

  y -= 82;

  // Benchmark
  y -= 16;
  p2.drawRectangle({ x:18, y:y-62, width:W-36, height:64, color:C.surface });
  p2.drawRectangle({ x:18, y:y+2,  width:W-36, height:2,  color:C.blue });
  p2.drawText('BENCHMARK - ENTREPRISES SIMILAIRES', { x:28, y:y-14, size:8, font:hB, color:C.blue });

  const bchW = W - 200;
  const bch = [
    { label:'Score moyen secteur', val:65, color:C.blue },
    { label:'Votre score',         val:score.valeur, color:scoreColor },
  ];
  bch.forEach((b, i) => {
    const by = y - 30 - i*18;
    p2.drawText(b.label, { x:28, y:by, size:7, font:h, color:C.muted });
    p2.drawRectangle({ x:155, y:by-4, width:bchW, height:10, color:C.card });
    p2.drawRectangle({ x:155, y:by-4, width:Math.min(bchW*(b.val/100),bchW), height:10, color:b.color });
    p2.drawText(b.val+'%', { x:155+bchW+6, y:by, size:8, font:hB, color:b.color });
  });
  const ecart = 65 - score.valeur;
  p2.drawText('Ecart vs benchmark : ' + (ecart > 0 ? '-' : '+') + Math.abs(ecart) + ' points', { x:28, y:y-68, size:7.5, font:hB, color:ecart > 0 ? C.danger : C.green });

  // ══════════════════════════════════════════════
  // PAGE 3 — PLAN DE REMEDIATION (anomalies + exclus)
  // ══════════════════════════════════════════════
  const p3 = pdfDoc.addPage([W, H]);
  drawHeader(p3, hB, h, logoImage, 'PLAN DE REMEDIATION', 3, TP, W, H);

  y = H - 68;

  // Top 10 fournisseurs à traiter
  const anomaliesReelles = details.filter(d => d.statut === 'ANOMALIE' || d.statut === 'ERREUR_RECTIFICATION');
  p3.drawText('TOP 10 - FOURNISSEURS A TRAITER EN PRIORITE', { x:28, y, size:10, font:hB, color:C.white });
  p3.drawText('Classement par niveau d\'urgence (categories de depenses exclues)', { x:28, y:y-13, size:7, font:h, color:C.muted });
  y -= 26;

  // Header tableau
  p3.drawRectangle({ x:18, y:y-14, width:W-36, height:16, color:C.surface });
  p3.drawRectangle({ x:18, y:y, width:W-36, height:2, color:C.danger });
  p3.drawText('#',              { x:24,  y:y-10, size:6.5, font:hB, color:C.muted });
  p3.drawText('FOURNISSEUR',   { x:40,  y:y-10, size:6.5, font:hB, color:C.muted });
  p3.drawText('PRIORITE',      { x:230, y:y-10, size:6.5, font:hB, color:C.muted });
  p3.drawText('PROBLEME',      { x:300, y:y-10, size:6.5, font:hB, color:C.muted });
  p3.drawText('ACTION',        { x:410, y:y-10, size:6.5, font:hB, color:C.muted });
  y -= 18;

  const actionsMap = {
    'siret_MANQUANT': 'Contacter / INSEE',
    'siret_INVALIDE': 'Verifier format SIRET',
    'tva_INVALIDE':   'Verifier VIES',
    'tva_MANQUANT':   'Verifier VIES',
  };

  const top10 = anomaliesReelles.slice(0, 10);
  top10.forEach((d, i) => {
    if (y < 50) return;
    const nom      = t(d.donnees_originales?.Denomination || d.donnees_originales?.denomination || 'Ligne '+(d.index+1), 26);
    const anom     = d.anomalies?.[0];
    const isCrit   = d.anomalies?.some(a=>a.champ==='siret');
    const pC       = isCrit ? C.danger : C.warn;
    const pLabel   = isCrit ? 'CRITIQUE' : 'MODERE';
    const prob     = anom ? s(anom.champ + ' ' + (anom.type==='MANQUANT'?'manquant':'invalide')) : 'Anomalie';
    const act      = anom ? (actionsMap[anom.champ+'_'+anom.type]||'Verification manuelle') : 'Verification manuelle';

    p3.drawRectangle({ x:18, y:y-14, width:W-36, height:16, color:i%2===0?C.surface:C.card });
    p3.drawText(String(i+1),       { x:24,  y:y-9, size:6.5, font:hB, color:C.muted });
    p3.drawText(nom,               { x:40,  y:y-9, size:6.5, font:hB, color:C.text });
    p3.drawText(pLabel,            { x:230, y:y-9, size:6.5, font:hB, color:pC });
    p3.drawText(t(prob,14),        { x:300, y:y-9, size:6.5, font:h,  color:C.muted });
    p3.drawText(t(act,18),         { x:410, y:y-9, size:6.5, font:h,  color:C.accent });
    y -= 16;
  });

  y -= 20;

  // Fournisseurs bloquants détail
  p3.drawRectangle({ x:18, y:y-14, width:W-36, height:16, color:C.danger, opacity:0.15 });
  p3.drawRectangle({ x:18, y:y,    width:W-36, height:2,  color:C.danger });
  p3.drawText('FOURNISSEURS BLOQUANTS (' + bloquantsReels + ')', { x:24, y:y-10, size:7.5, font:hB, color:C.danger });
  y -= 18;

  const bloquants = details.filter(d => d.anomalies?.some(a=>a.champ==='siret'));
  bloquants.slice(0,8).forEach(d => {
    if (y < 60) return;
    const nom  = t(d.donnees_originales?.Denomination || d.donnees_originales?.denomination || 'Ligne '+(d.index+1), 28);
    const anom = d.anomalies?.find(a=>a.champ==='siret');
    const type = anom?.type === 'MANQUANT' ? 'SIRET absent - TVA absente' : 'SIRET invalide : ' + t(anom?.valeur||'',12);
    p3.drawRectangle({ x:18, y:y-32, width:W-36, height:34, color:C.surface });
    p3.drawRectangle({ x:18, y:y-32, width:2, height:34, color:C.danger });
    p3.drawText(nom,  { x:26, y:y-10, size:7.5, font:hB, color:C.text });
    p3.drawText(s(type), { x:26, y:y-22, size:6.5, font:h, color:C.danger });
    const action = anom?.type==='MANQUANT'
      ? '-> Donnees obligatoires manquantes. Fournir SIRET 14 chiffres.'
      : '-> Remplacer la valeur par un SIRET 14 chiffres numerique valide.';
    p3.drawText(t(action,80), { x:26, y:y-30, size:6, font:h, color:C.muted });
    y -= 38;
  });

  y -= 12;

  // Fournisseurs à corriger (TVA seulement)
  const acorrigerList = details.filter(d => d.anomalies?.some(a=>a.champ==='tva') && !d.anomalies?.some(a=>a.champ==='siret'));
  if (acorrigerList.length > 0 && y > 100) {
    p3.drawRectangle({ x:18, y:y-14, width:W-36, height:16, color:C.warn, opacity:0.15 });
    p3.drawRectangle({ x:18, y:y,    width:W-36, height:2,  color:C.warn });
    p3.drawText('FOURNISSEURS A CORRIGER (' + acorrigerList.length + ')', { x:24, y:y-10, size:7.5, font:hB, color:C.warn });
    y -= 18;

    acorrigerList.slice(0,6).forEach(d => {
      if (y < 60) return;
      const nom  = t(d.donnees_originales?.Denomination || d.donnees_originales?.denomination || 'Ligne '+(d.index+1), 28);
      const anom = d.anomalies?.find(a=>a.champ==='tva');
      const siren = d.donnees_originales?.Siren || d.donnees_originales?.siren || '';
      p3.drawRectangle({ x:18, y:y-32, width:W-36, height:34, color:C.surface });
      p3.drawRectangle({ x:18, y:y-32, width:2, height:34, color:C.warn });
      p3.drawText(nom, { x:26, y:y-10, size:7.5, font:hB, color:C.text });
      p3.drawText(anom?.type==='MANQUANT' ? 'TVA absente' : 'TVA invalide : ' + t(anom?.valeur||'',12), { x:26, y:y-22, size:6.5, font:h, color:C.warn });
      p3.drawText(siren ? '-> SIREN ' + s(siren) + ' present. Ajouter TVA valide au format FR + 2 car. + 9 chiffres.' : '-> Contacter le fournisseur pour obtenir son numero de TVA intracommunautaire.', { x:26, y:y-30, size:6, font:h, color:C.muted });
      y -= 38;
    });
  }

  // ══════════════════════════════════════════════
  // PAGE 4 — LISTE COMPLETE + EXCLUS + PLAN D'ACTION
  // ══════════════════════════════════════════════
  const p4 = pdfDoc.addPage([W, H]);
  drawHeader(p4, hB, h, logoImage, 'LISTE COMPLETE & PLAN D\'ACTION', 4, TP, W, H);

  y = H - 68;

  // Titre liste complète
  const totalLignes = meta.total_lignes || (details.length + exclus.length);
  p4.drawText('LISTE COMPLETE - ' + totalLignes + ' ENTREES', { x:28, y, size:10, font:hB, color:C.white });
  y -= 20;

  // Header tableau
  p4.drawRectangle({ x:18, y:y-14, width:W-36, height:16, color:C.surface });
  p4.drawRectangle({ x:18, y:y, width:W-36, height:2, color:C.accent });
  p4.drawText('FOURNISSEUR',   { x:24,  y:y-10, size:6, font:hB, color:C.muted });
  p4.drawText('STATUT',        { x:190, y:y-10, size:6, font:hB, color:C.muted });
  p4.drawText('SIRET',         { x:255, y:y-10, size:6, font:hB, color:C.muted });
  p4.drawText('TVA',           { x:295, y:y-10, size:6, font:hB, color:C.muted });
  p4.drawText('SIREN OK',      { x:325, y:y-10, size:6, font:hB, color:C.muted });
  p4.drawText('CATEGORIE',     { x:370, y:y-10, size:6, font:hB, color:C.muted });
  p4.drawText('RECOMMANDATION',{ x:420, y:y-10, size:6, font:hB, color:C.muted });
  y -= 16;

  let rowCount = 0;

  // Lignes fournisseurs réels
  for (const d of details) {
    if (y < 120 || rowCount > 25) break;
    const nom    = t(d.donnees_originales?.Denomination || d.donnees_originales?.denomination || 'Ligne '+(d.index+1), 22);
    const hasSiret = !d.anomalies?.some(a=>a.champ==='siret');
    const hasTva   = !d.anomalies?.some(a=>a.champ==='tva');
    const hasSiren = hasSiret; // approximation
    const statut   = d.statut === 'VALIDE' ? 'Conforme' : 'Bloquant';
    const sC       = d.statut === 'VALIDE' ? C.green : C.danger;
    const reco     = d.statut === 'VALIDE'
      ? 'Conforme 2026. Surveiller.'
      : (d.anomalies?.[0]?.type==='MANQUANT' ? 'Donnees obligatoires manquantes.' : 'Donnee invalide a corriger.');

    p4.drawRectangle({ x:18, y:y-13, width:W-36, height:14, color:rowCount%2===0?C.surface:C.card });
    p4.drawText(nom,                           { x:24,  y:y-9, size:5.5, font:hB, color:C.text });
    p4.drawText(s(statut),                     { x:190, y:y-9, size:5.5, font:hB, color:sC });
    p4.drawText(hasSiret?'OUI':'NON',          { x:255, y:y-9, size:5.5, font:hB, color:hasSiret?C.green:C.danger });
    p4.drawText(hasTva?'OUI':'NON',            { x:295, y:y-9, size:5.5, font:hB, color:hasTva?C.green:C.danger });
    p4.drawText(hasSiren?'OUI':'NON',          { x:325, y:y-9, size:5.5, font:hB, color:hasSiren?C.green:C.danger });
    p4.drawText('NON',                         { x:370, y:y-9, size:5.5, font:h,  color:C.muted });
    p4.drawText(t(reco,22),                    { x:420, y:y-9, size:5.5, font:h,  color:C.muted });
    y -= 13;
    rowCount++;
  }

  // Lignes exclus (catégories + enseignes)
  for (const ex of exclus) {
    if (y < 120 || rowCount > 35) break;
    const isCat = ex.type?.includes('comptable');
    p4.drawRectangle({ x:18, y:y-13, width:W-36, height:14, color:rowCount%2===0?C.surface:C.card });
    p4.drawText(t(ex.nom||'—', 22),  { x:24,  y:y-9, size:5.5, font:h,  color:C.muted });
    p4.drawText(isCat?'Cat. depense':'Ponctuel', { x:190, y:y-9, size:5.5, font:h, color:C.muted });
    p4.drawText('—',                  { x:255, y:y-9, size:5.5, font:h, color:C.muted });
    p4.drawText('—',                  { x:295, y:y-9, size:5.5, font:h, color:C.muted });
    p4.drawText('—',                  { x:325, y:y-9, size:5.5, font:h, color:C.muted });
    p4.drawText('OUI',                { x:370, y:y-9, size:5.5, font:hB, color:C.blue });
    p4.drawText(t(ex.type||'Exclu',22),{ x:420, y:y-9, size:5.5, font:h, color:C.muted });
    y -= 13;
    rowCount++;
  }

  if (rowCount > 35) {
    p4.drawText('... et ' + (totalLignes - rowCount) + ' autres entrees - voir fichier Excel pour la liste complete', { x:24, y:y-10, size:6, font:h, color:C.muted });
    y -= 20;
  }

  y -= 16;

  // Plan d'action
  if (y > 80) {
    p4.drawText('PLAN D\'ACTION 30 JOURS', { x:28, y, size:10, font:hB, color:C.white });
    p4.drawText('Feuille de route pour atteindre 90% de conformite', { x:28, y:y-13, size:7, font:h, color:C.muted });
    y -= 26;

    const semaines = [
      { label:'SEMAINE 1', titre:'Corrections critiques',    detail:'Traiter les ' + bloquantsReels + ' fournisseurs bloquants. Contacter directement ou rechercher sur data.gouv.fr.', color:C.danger },
      { label:'SEMAINE 2', titre:'Validation TVA manquantes',detail:'Completer les ' + (stats.sans_tva||0) + ' TVA manquantes via le portail VIES. Verifier la coherence SIREN.', color:C.warn },
      { label:'SEMAINE 3', titre:'Verification finale',      detail:'Relancer un audit DataRemediation pour valider les corrections. Objectif : score > 90%.', color:C.blue },
      { label:'SEMAINE 4', titre:'Transmission a la PDP',    detail:'Transmettre le referentiel corrige a votre Plateforme de Dematerialisation Partenaire (PDP).', color:C.accent },
    ];

    const semW = (W-46)/2;
    semaines.forEach((sem, i) => {
      if (y < 60) return;
      const sx = 18 + (i%2)*(semW+5);
      if (i%2===0 && i>0) y -= 60;
      const sy = y - Math.floor(i/2)*0;
      p4.drawRectangle({ x:sx, y:sy-54, width:semW, height:56, color:C.surface });
      p4.drawRectangle({ x:sx, y:sy-54, width:semW, height:3,  color:sem.color });
      p4.drawText(sem.label,  { x:sx+8, y:sy-12, size:6.5, font:hB, color:sem.color });
      p4.drawText(s(sem.titre),{ x:sx+8, y:sy-24, size:8,   font:hB, color:C.text });
      p4.drawText(t(sem.detail,42),{ x:sx+8, y:sy-36, size:6.5, font:h, color:C.muted });
      if (i%2===1) y -= 62;
    });
  }

  return Buffer.from(await pdfDoc.save());
}

// ─── POST /api/rectification/analyser ─────────────────────
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
      success:           true,
      rapport:           result.rapport,
      donnees_corrigees: result.donnees_corrigees,
    });
  } catch (err) {
    console.error('[Route rectification]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/rectification/export-pdf ───────────────────
router.post('/export-pdf', express.json({ limit: '20mb' }), async (req, res) => {
  try {
    const { rapport, donnees_corrigees, nomFichier, companyName } = req.body;
    if (!rapport) return res.status(400).json({ error: 'Donnees manquantes.' });

    const pdfBuffer = await generateRectificationPDF(
      rapport, donnees_corrigees || [], nomFichier || 'rectification', companyName || ''
    );

    const baseName = (nomFichier||'rectification').replace(/\.[^.]+$/,'');
    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="rapport_conformite_' + baseName + '.pdf"');
    res.setHeader('Cache-Control','no-store');
    return res.send(pdfBuffer);
  } catch (err) {
    console.error('[Export PDF rectification]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/rectification/export-excel ─────────────────
router.post('/export-excel', express.json({ limit: '20mb' }), async (req, res) => {
  try {
    const { rapport, donnees_corrigees, nomFichier } = req.body;
    if (!donnees_corrigees || !rapport) return res.status(400).json({ error: 'Donnees manquantes.' });

    const stats = rapport.statistiques  || {};
    const score = rapport.score_qualite || {};
    const meta  = rapport.meta          || {};
    const roi   = rapport.roi           || {};
    const exclus = rapport.exclus       || [];
    const wb    = XLSX.utils.book_new();

    const resumeData = [
      ['RAPPORT DE CONFORMITE FOURNISSEURS - DataRemediation'],
      ['Facturation Electronique 2026 - e-Invoicing PDP'],
      [],
      ['Fichier',      meta.fichier || nomFichier || ''],
      ['Date',         new Date(meta.date_analyse || Date.now()).toLocaleString('fr-FR')],
      ['Type',         meta.type_fichier || 'fournisseurs'],
      [],
      ['PERIMETRE'],
      ['Total lignes analysees',        meta.total_lignes || 0],
      ['Fournisseurs reels (score)',     meta.total_fournisseurs_reels || stats.total || 0],
      ['Entrees exclues (hors score)',   meta.total_exclus || exclus.length || 0],
      ['  dont categories comptables',  stats.nb_categories_depense || 0],
      ['  dont enseignes ponctuelles',  stats.nb_ponctuels || 0],
      [],
      ['SCORE QUALITE (fournisseurs reels)', (score.valeur||0) + '%', score.mention||''],
      [],
      ['STATISTIQUES (fournisseurs reels)'],
      ['Conformes',           stats.valides||0],
      ['Anomalies manuelles', stats.anomalies||0],
      ['Sans SIRET',          stats.sans_siret||0],
      ['SIRET invalide',      stats.siret_invalide||0],
      ['Sans TVA',            stats.sans_tva||0],
      [],
      ['VALORISATION'],
      ['Temps manuel estime',   (roi.temps_manuel_h||0) + ' heures'],
      ['Temps analyse DataRem', (roi.temps_analyse_min||roi.temps_automatise_min||5) + ' minutes'],
      ['Gain financier estime', (roi.cout_manuel_eur||0) + ' EUR'],
    ];
    const wsR = XLSX.utils.aoa_to_sheet(resumeData);
    wsR['!cols'] = [{wch:35},{wch:50}];
    XLSX.utils.book_append_sheet(wb, wsR, 'Resume');

    // Données corrigées
    if (donnees_corrigees.length > 0) {
      const headers = Object.keys(donnees_corrigees[0]);
      const rows    = donnees_corrigees.map(r => headers.map(h2 => r[h2]??''));
      const wsD     = XLSX.utils.aoa_to_sheet([headers, ...rows]);
      wsD['!cols']  = headers.map(()=>({wch:20}));
      XLSX.utils.book_append_sheet(wb, wsD, 'Donnees fournisseurs reels');
    }

    // Anomalies
    const details    = rapport.details || [];
    const anomalies  = details
      .filter(d=>d.anomalies&&d.anomalies.length>0)
      .flatMap(d=>d.anomalies.map(a=>({
        'Fournisseur': d.donnees_originales?.Denomination || d.donnees_originales?.denomination || 'Ligne '+(d.index+1),
        'Champ':a.champ,'Type':a.type,'Valeur':a.valeur||'','Statut':d.statut
      })));
    if (anomalies.length > 0) {
      const wsA = XLSX.utils.json_to_sheet(anomalies);
      wsA['!cols'] = [{wch:30},{wch:16},{wch:18},{wch:28},{wch:14}];
      XLSX.utils.book_append_sheet(wb, wsA, 'Anomalies a corriger');
    }

    // Exclus
    if (exclus.length > 0) {
      const wsE = XLSX.utils.json_to_sheet(exclus.map(e=>({
        'Nom':     e.nom || '—',
        'Type':    e.type || '',
        'Message': e.message || '',
      })));
      wsE['!cols'] = [{wch:30},{wch:35},{wch:60}];
      XLSX.utils.book_append_sheet(wb, wsE, 'Entrees exclues');
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

// ─── GET /api/rectification/ping ──────────────────────────
router.get('/ping', (req, res) => res.json({ status:'ok', module:'rectification' }));

module.exports = router;
