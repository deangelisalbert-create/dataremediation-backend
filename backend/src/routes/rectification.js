// routes/rectification.js — Support CSV + XLSX + JSON + XML
const express = require('express');
const multer  = require('multer');
const XLSX    = require('xlsx');
const { runRectificationPipeline } = require('../modules/rectification');

const router = express.Router();

// Multer sans fileFilter — validation par extension dans la route
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 },
});

// ── POST /api/rectification/analyser ─────────────────────
router.post('/analyser', upload.single('fichier'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Aucun fichier fourni.' });
    }

    const { buffer, mimetype, originalname } = req.file;
    const ext = (originalname.split('.').pop() || '').toLowerCase();

    // Valider le format
    if (!['csv','xlsx','xls','json','xml'].includes(ext)) {
      return res.status(400).json({
        error: 'Format non supporte : .' + ext + '. Utilisez CSV, XLSX, JSON ou XML.'
      });
    }

    // Forcer le bon MIME selon l'extension
    let effectiveMime = mimetype;
    if (ext === 'xlsx' || ext === 'xls') effectiveMime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    else if (ext === 'csv')  effectiveMime = 'text/csv';
    else if (ext === 'json') effectiveMime = 'application/json';
    else if (ext === 'xml')  effectiveMime = 'application/xml';

    const result = await runRectificationPipeline(buffer, effectiveMime, originalname);

    return res.status(200).json({
      success: true,
      rapport: result.rapport,
      donnees_corrigees: result.donnees_corrigees,
    });

  } catch (err) {
    console.error('[Route rectification]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/rectification/export-excel ─────────────────
router.post('/export-excel', express.json({ limit: '20mb' }), async (req, res) => {
  try {
    const { rapport, donnees_corrigees, nomFichier } = req.body;
    if (!donnees_corrigees || !rapport) {
      return res.status(400).json({ error: 'Donnees manquantes.' });
    }

    const stats = rapport.statistiques  || {};
    const score = rapport.score_qualite || {};
    const meta  = rapport.meta          || {};
    const wb    = XLSX.utils.book_new();

    const resumeData = [
      ['RAPPORT DE RECTIFICATION - DataRemediation'],
      ['Fichier', meta.fichier || nomFichier || ''],
      ['Date',    new Date(meta.date_analyse || Date.now()).toLocaleString('fr-FR')],
      [],
      ['SCORE QUALITE', (score.valeur||0) + '/100', score.mention||''],
      [],
      ['STATISTIQUES'],
      ['Total',         stats.total||0],
      ['Valides',       stats.valides||0],
      ['Corriges',      stats.corriges||0],
      ['Erreurs',       stats.erreurs||0],
      ['Taux anomalies',(stats.taux_anomalies||0)+'%'],
      ['Taux correction auto',(stats.taux_correction||0)+'%'],
      [],
      ['RESUME', rapport.resume||''],
    ];
    const wsR = XLSX.utils.aoa_to_sheet(resumeData);
    wsR['!cols'] = [{wch:28},{wch:50},{wch:20}];
    XLSX.utils.book_append_sheet(wb, wsR, 'Resume');

    if (donnees_corrigees.length > 0) {
      const headers = Object.keys(donnees_corrigees[0]);
      const rows    = donnees_corrigees.map(r => headers.map(h => r[h]??''));
      const wsD     = XLSX.utils.aoa_to_sheet([headers, ...rows]);
      wsD['!cols']  = headers.map(()=>({wch:20}));
      XLSX.utils.book_append_sheet(wb, wsD, 'Donnees corrigees');
    }

    const details     = rapport.details || [];
    const corrDetails = details
      .filter(d=>d.corrections&&d.corrections.length>0)
      .flatMap(d=>d.corrections.map(c=>({
        'Ligne':d.index+1,'Champ':c.champ,'Avant':c.avant,
        'Apres':c.apres,'Confiance':c.confiance,'Justification':c.justification||''
      })));
    if (corrDetails.length > 0) {
      const wsC = XLSX.utils.json_to_sheet(corrDetails);
      wsC['!cols'] = [{wch:8},{wch:18},{wch:30},{wch:30},{wch:12},{wch:50}];
      XLSX.utils.book_append_sheet(wb, wsC, 'Corrections');
    }

    const anomalies = details
      .filter(d=>d.anomalies&&d.anomalies.length>0)
      .flatMap(d=>d.anomalies.map(a=>({
        'Ligne':d.index+1,'Champ':a.champ,'Type':a.type,'Valeur':a.valeur||'','Statut':d.statut
      })));
    if (anomalies.length > 0) {
      const wsA = XLSX.utils.json_to_sheet(anomalies);
      wsA['!cols'] = [{wch:8},{wch:18},{wch:20},{wch:30},{wch:15}];
      XLSX.utils.book_append_sheet(wb, wsA, 'Anomalies');
    }

    const buf      = XLSX.write(wb, {type:'buffer', bookType:'xlsx'});
    const baseName = (nomFichier||'rectification').replace(/\.[^.]+$/,'');
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition','attachment; filename="rectifie_'+baseName+'.xlsx"');
    res.setHeader('Cache-Control','no-store');
    return res.send(buf);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/rectification/ping ──────────────────────────
router.get('/ping', (req, res) => res.json({ status:'ok', module:'rectification' }));

module.exports = router;
