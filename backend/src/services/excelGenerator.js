// services/excelGenerator.js — Export Excel complet DataRemédiation
// Consomme la sortie de generateFullReport() (reportGenerator.js)
// Produit un Buffer XLSX à 4 onglets :
//   1. Synthèse          — score, résumé, ROI
//   2. Liste complète    — TOUTES les lignes analysées (aucune troncature)
//   3. Plan de remédiation — actions priorisées
//   4. Scoring           — score /100 par fournisseur
//
// Dépendance : npm install exceljs

'use strict';

const ExcelJS = require('exceljs');

// ─────────────────────────────────────────────────────────────
// Palette (alignée sur le thème sombre du PDF)
// ─────────────────────────────────────────────────────────────
const COLORS = {
  headerBg:   'FF0F172A', // bleu nuit
  headerText: 'FFFFFFFF',
  bandBg:     'FF1E293B',
  ok:         'FF22C55E', // vert
  warn:       'FFF59E0B', // orange
  crit:       'FFEF4444', // rouge
  info:       'FF3B82F6', // bleu
  muted:      'FF64748B', // gris
  zebra:      'FFF1F5F9', // gris très clair (lignes alternées)
};

const STATUT_COLOR = {
  'Conforme':     COLORS.ok,
  'À corriger':   COLORS.warn,
  'A corriger':   COLORS.warn,
  'Corriger':     COLORS.warn,
  'Bloquant':     COLORS.crit,
  'Cat. depense': COLORS.info,
  'Ponctuel':     COLORS.info,
};

// ─────────────────────────────────────────────────────────────
// Helpers de mise en forme
// ─────────────────────────────────────────────────────────────
function styleHeaderRow(row) {
  row.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.headerBg } };
    cell.font = { bold: true, color: { argb: COLORS.headerText }, size: 11 };
    cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    cell.border = { bottom: { style: 'medium', color: { argb: COLORS.info } } };
  });
  row.height = 22;
}

function zebra(row, index) {
  if (index % 2 === 0) {
    row.eachCell(cell => {
      if (!cell.fill || cell.fill.pattern !== 'solid') {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLORS.zebra } };
      }
    });
  }
}

function statutCell(cell, statut) {
  const color = STATUT_COLOR[statut] || COLORS.muted;
  cell.font = { bold: true, color: { argb: color } };
}

function boolCell(cell, value) {
  if (value === true)  { cell.value = 'OUI'; cell.font = { color: { argb: COLORS.ok },   bold: true }; }
  else if (value === false) { cell.value = 'NON'; cell.font = { color: { argb: COLORS.crit }, bold: true }; }
  else { cell.value = '—'; cell.font = { color: { argb: COLORS.muted } }; }
  cell.alignment = { horizontal: 'center' };
}

function sectionTitle(ws, rowIdx, text, color = COLORS.info) {
  const row = ws.getRow(rowIdx);
  row.getCell(1).value = text;
  row.getCell(1).font = { bold: true, size: 13, color: { argb: color } };
  row.height = 20;
  return rowIdx + 1;
}

// ─────────────────────────────────────────────────────────────
// Onglet 1 — Synthèse
// ─────────────────────────────────────────────────────────────
function buildSheetSynthese(wb, report) {
  const ws = wb.addWorksheet('Synthèse', { properties: { defaultRowHeight: 16 } });
  ws.columns = [{ width: 38 }, { width: 30 }, { width: 6 }, { width: 38 }, { width: 22 }];

  const se  = report.score_executif || {};
  const res = se.resume || {};
  const roi = report.indicateurs_valeur || {};
  const meta = report.meta || {};

  let r = 1;
  ws.getRow(r).getCell(1).value = 'RAPPORT DE CONFORMITÉ e-INVOICING 2026';
  ws.getRow(r).getCell(1).font = { bold: true, size: 16 };
  r++;
  ws.getRow(r).getCell(1).value = `Fichier : ${meta.fichier || ''}`;
  ws.getRow(r).getCell(1).font = { color: { argb: COLORS.muted } };
  r++;
  ws.getRow(r).getCell(1).value = `Généré le : ${meta.genere_le || ''} — ${meta.genere_par || 'DataRemédiation'}`;
  ws.getRow(r).getCell(1).font = { color: { argb: COLORS.muted } };
  r += 2;

  // Score global
  r = sectionTitle(ws, r, 'SCORE EXÉCUTIF');
  const scoreColor = se.score_global >= 92 ? COLORS.ok : se.score_global >= 75 ? COLORS.warn : COLORS.crit;
  const rows1 = [
    ['Score de conformité global', `${se.score_global ?? 0}%`, scoreColor],
    ['Niveau de risque', se.niveau_risque || '', scoreColor],
    ['Interprétation', se.interpretation || '', null],
  ];
  rows1.forEach(([label, value, color]) => {
    ws.getRow(r).getCell(1).value = label;
    const c = ws.getRow(r).getCell(2);
    c.value = value;
    if (color) c.font = { bold: true, color: { argb: color }, size: 12 };
    r++;
  });
  r++;

  // Résumé chiffré
  r = sectionTitle(ws, r, 'RÉSUMÉ');
  const rows2 = [
    ['Fournisseurs analysés',        res.fournisseurs_analyses],
    ['Fournisseurs conformes',       res.fournisseurs_conformes],
    ['Anomalies détectées',          res.anomalies_detectees],
    ['Fournisseurs bloquants',       res.fournisseurs_bloquants],
    ['SIRET invalides',              res.siret_invalides],
    ['TVA incohérentes',             res.tva_incoherentes],
    ['Doublons',                     res.doublons],
    ['Champs critiques manquants',   res.champs_critiques_manquants],
  ];
  rows2.forEach(([label, value]) => {
    ws.getRow(r).getCell(1).value = label;
    ws.getRow(r).getCell(2).value = value ?? 0;
    ws.getRow(r).getCell(2).font = { bold: true };
    r++;
  });
  r++;

  // ROI
  r = sectionTitle(ws, r, 'INDICATEURS DE VALEUR', COLORS.ok);
  const rows3 = [
    ['Temps manuel économisé (h)',   roi.temps_manuel_economise_h],
    ['Coût interne estimé (€)',      roi.cout_interne_estime_eur],
    ['Gain évitement rejets (€)',    roi.gain_evitement_rejets_eur],
    ['Gain total estimé (€)',        roi.gain_total_estime_eur],
  ];
  rows3.forEach(([label, value]) => {
    ws.getRow(r).getCell(1).value = label;
    ws.getRow(r).getCell(2).value = value ?? 0;
    ws.getRow(r).getCell(2).font = { bold: true, color: { argb: COLORS.ok } };
    r++;
  });

  return ws;
}

// ─────────────────────────────────────────────────────────────
// Onglet 2 — Liste complète (AUCUNE troncature)
// ─────────────────────────────────────────────────────────────
function buildSheetListeComplete(wb, results) {
  const ws = wb.addWorksheet('Liste complète');

  ws.columns = [
    { header: '#',              key: 'idx',        width: 6 },
    { header: 'Fournisseur',    key: 'nom',        width: 40 },
    { header: 'Statut',         key: 'statut',     width: 14 },
    { header: 'SIRET',          key: 'siret',      width: 18 },
    { header: 'SIRET valide',   key: 'siret_ok',   width: 13 },
    { header: 'N° TVA',         key: 'tva',        width: 18 },
    { header: 'TVA valide',     key: 'tva_ok',     width: 12 },
    { header: 'SIREN cohérent', key: 'siren_ok',   width: 15 },
    { header: 'Erreurs détectées', key: 'erreurs', width: 50 },
    { header: 'Recommandation', key: 'suggestion', width: 60 },
  ];
  styleHeaderRow(ws.getRow(1));
  ws.autoFilter = 'A1:J1';
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  results.forEach((res, i) => {
    const row = ws.addRow({
      idx:        i + 1,
      nom:        res.nom_reel || res.alias || '',
      statut:     res.statut || '',
      siret:      String(res.siret || res.siret_reel || '').trim() || '—',
      tva:        String(res.tva || res.numero_tva || res.tva_reel || '').trim() || '—',
      erreurs:    Array.isArray(res.erreurs) ? res.erreurs.join(' ; ') : (res.erreurs || ''),
      suggestion: res.suggestion || '',
    });
    statutCell(row.getCell('statut'), res.statut);
    boolCell(row.getCell('siret_ok'), typeof res.siret_ok === 'boolean' ? res.siret_ok : null);
    boolCell(row.getCell('tva_ok'),   typeof res.tva_ok   === 'boolean' ? res.tva_ok   : null);
    boolCell(row.getCell('siren_ok'), typeof res.siren_coherent === 'boolean' ? res.siren_coherent : null);
    row.getCell('erreurs').alignment    = { wrapText: true, vertical: 'top' };
    row.getCell('suggestion').alignment = { wrapText: true, vertical: 'top' };
    zebra(row, i);
  });

  return ws;
}

// ─────────────────────────────────────────────────────────────
// Onglet 3 — Plan de remédiation
// ─────────────────────────────────────────────────────────────
function buildSheetPlanRemediation(wb, report) {
  const ws = wb.addWorksheet('Plan de remédiation');
  const plan = report.plan_remediation || {};
  const actions = plan.liste_complete || [];

  ws.columns = [
    { header: '#',                   key: 'idx',        width: 6 },
    { header: 'Fournisseur',         key: 'fournisseur', width: 40 },
    { header: 'Priorité',            key: 'priorite',   width: 12 },
    { header: 'Problème',            key: 'probleme',   width: 40 },
    { header: 'Correction proposée', key: 'correction', width: 60 },
    { header: 'Impact métier',       key: 'impact',     width: 45 },
    { header: 'Délai recommandé',    key: 'delai',      width: 22 },
  ];
  styleHeaderRow(ws.getRow(1));
  ws.autoFilter = 'A1:G1';
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  // CRITIQUE d'abord, puis MODÉRÉE
  const sorted = [...actions].sort((a, b) => {
    const rank = p => (p === 'CRITIQUE' ? 0 : 1);
    return rank(a.priorite) - rank(b.priorite);
  });

  sorted.forEach((a, i) => {
    const row = ws.addRow({
      idx:         i + 1,
      fournisseur: a.fournisseur,
      priorite:    a.priorite,
      probleme:    a.probleme,
      correction:  a.correction_proposee,
      impact:      a.impact_metier,
      delai:       a.delai_recommande,
    });
    row.getCell('priorite').font = {
      bold: true,
      color: { argb: a.priorite === 'CRITIQUE' ? COLORS.crit : COLORS.warn },
    };
    ['probleme', 'correction', 'impact'].forEach(k =>
      row.getCell(k).alignment = { wrapText: true, vertical: 'top' }
    );
    zebra(row, i);
  });

  return ws;
}

// ─────────────────────────────────────────────────────────────
// Onglet 4 — Scoring fournisseurs
// ─────────────────────────────────────────────────────────────
function buildSheetScoring(wb, report) {
  const ws = wb.addWorksheet('Scoring');
  const scoring = report.scoring_fournisseurs || {};
  const fournisseurs = scoring.fournisseurs || [];

  ws.columns = [
    { header: '#',           key: 'idx',       width: 6 },
    { header: 'Fournisseur', key: 'nom',       width: 40 },
    { header: 'Score /100',  key: 'score',     width: 12 },
    { header: 'Catégorie',   key: 'categorie', width: 18 },
    { header: 'Pénalités',   key: 'penalites', width: 55 },
    { header: 'Statut IA',   key: 'statut',    width: 14 },
  ];
  styleHeaderRow(ws.getRow(1));
  ws.autoFilter = 'A1:F1';
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  fournisseurs.forEach((f, i) => {
    const row = ws.addRow({
      idx:       i + 1,
      nom:       f.nom,
      score:     f.score,
      categorie: f.categorie,
      penalites: (f.penalites || []).join(' ; '),
      statut:    f.statut_ia || '',
    });
    const scoreColor = f.score >= 80 ? COLORS.ok : f.score >= 50 ? COLORS.warn : COLORS.crit;
    row.getCell('score').font = { bold: true, color: { argb: scoreColor } };
    row.getCell('score').alignment = { horizontal: 'center' };
    row.getCell('categorie').font = { color: { argb: scoreColor } };
    row.getCell('penalites').alignment = { wrapText: true, vertical: 'top' };
    statutCell(row.getCell('statut'), f.statut_ia);
    zebra(row, i);
  });

  return ws;
}

// ─────────────────────────────────────────────────────────────
// EXPORT PRINCIPAL
// ─────────────────────────────────────────────────────────────

/**
 * generateExcelBuffer()
 *
 * @param {Object} report  — sortie de generateFullReport() (reportGenerator.js)
 * @param {Array}  results — tableau de résultats complet (avec nom_reel) — la
 *                           source de vérité pour l'onglet "Liste complète"
 * @returns {Promise<Buffer>} buffer XLSX prêt à écrire / streamer / attacher
 */
async function generateExcelBuffer(report, results) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'DataRemédiation';
  wb.created = new Date();

  buildSheetSynthese(wb, report);
  buildSheetListeComplete(wb, results || []);
  buildSheetPlanRemediation(wb, report);
  buildSheetScoring(wb, report);

  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { generateExcelBuffer };
