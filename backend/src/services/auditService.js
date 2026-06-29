// services/auditService.js — Cœur métier : pseudo + IA + rapport
const fs         = require('fs');
const path       = require('path');
const Anthropic  = require('@anthropic-ai/sdk');
const { queryWithTenant, pool } = require('../config/database');
const { safeLog } = require('../middleware/errorHandler');
const XLSX       = require('xlsx');
const { generateFullReport } = require('./reportGenerator');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Listes d'exclusion ────────────────────────────────────

const CATEGORIES_DEPENSES = new Set([
  'transport', 'frais kilometriques', 'fraiskilometriques', 'frais_kilometriques',
  'peage', 'péage', 'hotel', 'hôtel', 'hotels', 'hôtels',
  'taxi', 'vtc', 'parking', 'restaurants', 'restaurant',
  'repas', 'carburant', 'essence', 'gazole', 'gasoil',
  'autre', 'autres', 'divers', 'frais generaux', 'frais généraux',
  'note de frais', 'notedefrais', 'carte bancaire', 'cartebancaire',
  'abonnement', 'fournitures', 'telecom', 'telephone',
  'fournisseurs - achats de biens et pres', 'fournisseurs - achats de biens',
  'fournisseurs', 'achats de biens', 'achats',
  'bulletin', 'salaire', 'bulletins de salaire',
  'airbnb', 'booking', 'easyjet', 'easy-jet',
  'kilometrique', 'kilometriques',
]);

const ENSEIGNES_PONCTUELLES = new Set([
  'leroy merlin', 'leroymerlin', 'castorama', 'brico depot', 'bricodepot',
  'point p', 'pointp', 'mr bricolage', 'mrbricolage', 'weldom',
  'chausson materiaux', 'plateforme du batiment',
  'intermarche', 'intermarché', 'leclerc', 'carrefour', 'auchan', 'lidl',
  'aldi', 'super u', 'superu', 'casino', 'monoprix', 'franprix', 'cora',
  'metro', 'promocash',
  'mcdonald', 'mcdo', 'burger king', 'burgerking', 'kfc', 'subway',
  'flunch', 'buffalo grill', 'hippopotamus', 'courtepaille', 'paul',
  'boucherie', 'epicerie',
  'total', 'totalenergies', 'total energies', 'bp', 'shell', 'esso',
  'amazon', 'fnac', 'darty', 'boulanger', 'ikea', 'conforama',
]);

// Libellés comptables dans le champ SIRET
const LIBELLES_SIRET = new Set([
  'transport', 'peage', 'péage', 'hotel', 'hôtel', 'parking',
  'restaurant', 'restaurants', 'taxi', 'carburant', 'autre', 'autres',
  'frais', 'frais_kilometriques', 'fraiskilometriques',
  'note_de_frais', 'notedefrais', 'cartebancaire', 'carte_bancaire',
  'divers', 'fournitures', 'abonnement',
]);

function normalizeName(name) {
  if (!name) return '';
  return String(name)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isCategorieDep(nom) {
  const n = normalizeName(nom);
  if (CATEGORIES_DEPENSES.has(n)) return true;
  for (const c of CATEGORIES_DEPENSES) {
    if (n === c || n.startsWith(c + ' ')) return true;
  }
  return false;
}

function isEnseignePonctuelle(nom) {
  const n = normalizeName(nom);
  for (const e of ENSEIGNES_PONCTUELLES) {
    if (n === e || n.startsWith(e)) return true;
  }
  return false;
}

function isLibelleComptable(siret) {
  if (!siret) return false;
  const n = normalizeName(siret);
  if (/[a-z_]/.test(n.replace(/ /g, ''))) {
    return LIBELLES_SIRET.has(n) || /[a-zA-Z_]{3,}/.test(siret);
  }
  return false;
}

// ─────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Tu es un Expert Conformité e-Invoicing France 2026.
Tu reçois des données fournisseurs PSEUDONYMISÉES (alias FOURN_XXX — jamais de vrais noms).
Ces fournisseurs sont des fournisseurs réels (catégories comptables et enseignes ponctuelles déjà exclues en amont).

RÈGLES DE VALIDATION :
- SIREN/SIRET : accepter 9 chiffres numériques (SIREN) OU 14 chiffres numériques (SIRET complet)
- TVA FR : format "FR" + 2 caractères alphanumériques + 9 chiffres. Ex: FR83352600820
- Cohérence SIREN : le SIREN (9 chiffres) doit correspondre aux 9 derniers chiffres de la TVA
- Doublon : même SIREN sous deux alias différents
- Si siret/siren contient du texte non numérique → invalide

STATUTS - REGLES STRICTES :
- "Conforme" : identifiant NUMERIQUE present (9 OU 14 chiffres) ET TVA valide ET coherence OK. SIREN 9 chiffres + TVA valide = Conforme. Ne JAMAIS mettre A corriger si TVA valide.
- "A corriger" : identifiant numerique present (9 ou 14 chiffres) MAIS TVA absente ou invalide UNIQUEMENT.
- "Bloquant" : SEULEMENT si identifiant totalement absent OU contient du texte non numerique. SIREN ou SIRET numerique present = jamais Bloquant.

EXEMPLES A SUIVRE ABSOLUMENT :
- siret="880265921" (9 chiffres), tva="FR12880265921" -> statut="Conforme", siret_ok=true, tva_ok=true
- siret="880265921" (9 chiffres), tva="" -> statut="A corriger", siret_ok=true, tva_ok=false
- siret="88026592100011" (14 chiffres), tva="FR12880265921" -> statut="Conforme", siret_ok=true
- siret="" ET tva="" -> statut="Bloquant", siret_ok=false
- siret="TRANSPORT" -> statut="Bloquant", siret_ok=false

RECOMMANDATIONS OBLIGATOIRES :
- Conforme SIREN 9 chiffres : "Conforme 2024. Pour e-Invoicing 2026 : completer en SIRET 14 chiffres"
- Conforme SIRET 14 chiffres : "Conforme e-Invoicing 2026"
- A corriger TVA manquante : indiquer le SIREN present et demander TVA format FR + 2 car. + 9 chiffres
- Bloquant : expliquer le probleme et comment corriger

Réponds UNIQUEMENT avec un objet JSON valide, sans markdown, sans texte avant ou après :
{
  "results": [{
    "alias": "FOURN_001",
    "statut": "Conforme",
    "siret_ok": true,
    "tva_ok": true,
    "siren_coherent": true,
    "erreurs": [],
    "suggestion": "Conforme 2024. Pour e-Invoicing 2026 : compléter en SIRET 14 chiffres (ajouter le code NIC 5 chiffres)"
  }]
}
Le JSON doit commencer par { et finir par }.
Aucun texte avant. Aucun texte après. Pas de markdown. Pas de backticks.`;

const BATCH_SIZE = 50;

// ── Parser CSV simple ─────────────────────────────────────
function parseCSV(content) {
  const lines = content.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  const sep = lines[0].split(';').length > lines[0].split(',').length ? ';' : ',';
  const headers = lines[0].split(sep).map(h =>
    h.trim().toLowerCase().replace(/['"]/g, '')
  );

  return lines.slice(1, 10001).map(line => {
    const cols = line.split(sep).map(c => c.trim().replace(/^["']|["']$/g, ''));
    const obj = {};
    headers.forEach((h, i) => { obj[h] = cols[i] || ''; });
    return obj;
  });
}

// ── Pseudonymisation ──────────────────────────────────────
function pseudonymize(rows) {
  const aliasMap = {};
  const pseudoRows = rows.map((row, i) => {
    const alias = `FOURN_${String(i + 1).padStart(3, '0')}`;

    const nomKey =
      Object.keys(row).find(k => k.toLowerCase().trim() === 'dénomination') ||
      Object.keys(row).find(k => k.toLowerCase().trim() === 'denomination') ||
      Object.keys(row).find(k => k.toLowerCase().includes('dénom')) ||
      Object.keys(row).find(k => k.toLowerCase().includes('denom')) ||
      Object.keys(row).find(k => ['nom', 'name', 'raison', 'libelle'].some(t => k.toLowerCase().includes(t))) ||
      Object.keys(row)[2] ||
      Object.keys(row)[0];

    aliasMap[alias] = String(row[nomKey] || alias).trim();

    const sirenKey = Object.keys(row).find(k =>
      ['siren', 'siret'].some(t => k.toLowerCase().includes(t))
    );
    const sirenVal = sirenKey ? String(row[sirenKey] || '').replace(/[\s.]/g, '') : '';

    const tvaKey = Object.keys(row).find(k =>
      ['tva', 'vat'].some(t => k.toLowerCase().includes(t))
    );
    const tvaVal = tvaKey ? String(row[tvaKey] || '').replace(/[\s]/g, '').toUpperCase() : '';

    return { alias, siret: sirenVal, tva: tvaVal };
  });

  return { pseudoRows, aliasMap };
}

// ── Classification des exclus AVANT Claude ────────────────
function classifyExclus(pseudoRows, aliasMap) {
  const aAnalyser = [];
  const exclus    = [];

  for (const row of pseudoRows) {
    const nomReel = aliasMap[row.alias] || row.alias;
    const siret   = row.siret || '';

    const categorie = isCategorieDep(nomReel) || isLibelleComptable(siret);
    const ponctuel  = !categorie && isEnseignePonctuelle(nomReel);

    if (categorie) {
      exclus.push({
        alias:          row.alias,
        statut:         'CATEGORIE_DEPENSE',
        siret_ok:       false,
        tva_ok:         false,
        siren_coherent: false,
        erreurs:        ['Libelle comptable — exclu du score e-Invoicing'],
        suggestion:     'Categorie de depenses comptables. Non concerne par la facturation electronique.',
        nom_reel:       nomReel,
        _exclu:         true,
        _type_exclu:    'categorie',
      });
    } else if (ponctuel) {
      exclus.push({
        alias:          row.alias,
        statut:         'ENSEIGNE_PONCTUELLE',
        siret_ok:       false,
        tva_ok:         false,
        siren_coherent: false,
        erreurs:        ['Enseigne ponctuelle — achat en caisse probable'],
        suggestion:     'Enseigne B2C ponctuelle. Achat en caisse sans flux e-Invoicing attendu.',
        nom_reel:       nomReel,
        _exclu:         true,
        _type_exclu:    'ponctuel',
      });
    } else {
      aAnalyser.push(row);
    }
  }

  console.log(`[AUDIT] Classification : ${aAnalyser.length} reels, ${exclus.length} exclus`);
  return { aAnalyser, exclus };
}

// ── Appel Claude pour un lot ──────────────────────────────
async function analyzeWithClaude(batch, batchIndex) {
  const message = await anthropic.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 8000,
    system:     SYSTEM_PROMPT,
    messages: [{
      role:    'user',
      content: `Audite ces ${batch.length} fournisseurs pseudonymisés (lot ${batchIndex + 1}) :\n${JSON.stringify(batch)}`,
    }],
  });

  const rawText = message.content
    .map(b => b.type === 'text' ? b.text : '')
    .join('')
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  console.log(`[BATCH ${batchIndex + 1}] RAW:`, rawText.slice(0, 300));

  try {
    const parsed = JSON.parse(rawText);
    return parsed.results || [];
  } catch (err) {
    console.error(`[BATCH ${batchIndex + 1}] Erreur parsing:`, err.message);
    return batch.map(r => ({
      alias:          r.alias,
      statut:         'Bloquant',
      siret_ok:       false,
      tva_ok:         false,
      siren_coherent: false,
      erreurs:        ['Erreur analyse IA pour ce lot'],
      suggestion:     'Réessayer l\'analyse',
    }));
  }
}

// ── Génération CSV rapport ────────────────────────────────
function buildCSVReport(results, aliasMap) {
  const BOM = '\uFEFF';
  const header = [
    'Nom d\'origine', 'Alias', 'Statut', 'SIRET/SIREN valide', 'TVA valide',
    'Cohérence SIREN', 'Cat. depense', 'Erreurs', 'Recommandation e-Invoicing 2026'
  ].join(';');

  const rows = results.map(r => {
    const isExclu = r._exclu || r.statut === 'CATEGORIE_DEPENSE' || r.statut === 'ENSEIGNE_PONCTUELLE';
    return [
      `"${(aliasMap[r.alias] || r.nom_reel || r.alias).replace(/"/g, '""')}"`,
      r.alias,
      isExclu ? (r._type_exclu === 'categorie' ? 'Cat. depense' : 'Ponctuel') : r.statut,
      isExclu ? '—' : (r.siret_ok ? 'OUI' : 'NON'),
      isExclu ? '—' : (r.tva_ok   ? 'OUI' : 'NON'),
      isExclu ? '—' : (r.siren_coherent ? 'OUI' : 'NON'),
      isExclu ? 'OUI' : 'NON',
      `"${(r.erreurs || []).join(' | ')}"`,
      `"${(r.suggestion || '').replace(/"/g, '""')}"`,
    ].join(';');
  });

  return BOM + header + '\n' + rows.join('\n');
}

// ── Service principal d'analyse ───────────────────────────
async function runAuditAnalysis(fileId, user) {
  const startTime = Date.now();

  const updateStatus = async (status, extra = {}) => {
    const setClauses = ['status = $2'];
    const values     = [fileId, status];
    let idx = 3;
    for (const [key, val] of Object.entries(extra)) {
      setClauses.push(`${key} = $${idx++}`);
      values.push(val);
    }
    await pool.query(
      `UPDATE audit_files SET ${setClauses.join(', ')} WHERE id = $1`,
      values
    );
  };

  try {
    await updateStatus('analyzing', { analysis_started_at: new Date() });
    safeLog('info', 'AUDIT_STARTED', { userId: user.id, tenantId: user.tenant_id });

    const fileResult = await pool.query(
      'SELECT file_path, mime_type, original_name FROM audit_files WHERE id = $1',
      [fileId]
    );
    if (fileResult.rows.length === 0) throw new Error('Fichier introuvable en base');

    const { file_path, mime_type, original_name } = fileResult.rows[0];

    if (mime_type === 'application/pdf') {
      await updateStatus('done', {
        completed_at: new Date(),
        row_count: 0, conformes: 0, a_corriger: 0, bloquants: 0, taux_conformite: 100,
      });
      await pool.query(
        `INSERT INTO audit_reports (file_id, tenant_id, pdf_content, summary)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (file_id) DO UPDATE SET pdf_content = $3`,
        [fileId, user.tenant_id, 'Fichier PDF — analyse structurelle non applicable', JSON.stringify({ isPDF: true })]
      );
      return;
    }

    if (!fs.existsSync(file_path)) throw new Error('Fichier physique introuvable');

    let rows;
    if (
      mime_type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      mime_type === 'application/vnd.ms-excel' ||
      file_path.endsWith('.xlsx') || file_path.endsWith('.xls')
    ) {
      const workbook = XLSX.readFile(file_path);
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      rows = rows.map(row => {
        const normalized = {};
        Object.keys(row).forEach(k => { normalized[k.toLowerCase().trim()] = String(row[k] || ''); });
        return normalized;
      });
    } else {
      const rawContent = fs.readFileSync(file_path, 'utf-8');
      rows = parseCSV(rawContent);
    }

    if (rows.length === 0) throw new Error('Aucune donnée exploitable dans le fichier');

    const { pseudoRows, aliasMap } = pseudonymize(rows);
    safeLog('info', 'DATA_PSEUDONYMIZED', {
      userId: user.id, tenantId: user.tenant_id, rowCount: pseudoRows.length
    });

    // ── Classification AVANT Claude ───────────────────────
    const { aAnalyser, exclus } = classifyExclus(pseudoRows, aliasMap);

    // ── Traitement par lots (fournisseurs réels uniquement) ─
    const allResultsReels = [];
    const totalBatches = Math.ceil(aAnalyser.length / BATCH_SIZE);
    console.log(`[AUDIT] ${aAnalyser.length} fournisseurs reels → ${totalBatches} lot(s), ${exclus.length} exclus`);

    for (let i = 0; i < aAnalyser.length; i += BATCH_SIZE) {
      const batch = aAnalyser.slice(i, i + BATCH_SIZE);
      const batchIndex = Math.floor(i / BATCH_SIZE);
      console.log(`[AUDIT] Lot ${batchIndex + 1}/${totalBatches}`);
      const batchResults = await analyzeWithClaude(batch, batchIndex);
      allResultsReels.push(...batchResults);
    }

    // ── Fusionner résultats réels + exclus (ordre original) ─
    // Reconstruire dans l'ordre du fichier original
    const aliasToResult = {};
    allResultsReels.forEach(r => { aliasToResult[r.alias] = r; });
    exclus.forEach(r => { aliasToResult[r.alias] = r; });

    const allResults = pseudoRows.map(p => {
      const r = aliasToResult[p.alias];
      if (!r) return { alias: p.alias, statut: 'Bloquant', siret_ok: false, tva_ok: false, siren_coherent: false, erreurs: ['Non analysé'], suggestion: '' };
      return r;
    });

    // ── Summary sur fournisseurs réels uniquement ──────────
    const reels    = allResults.filter(r => !r._exclu);
    const conformes  = reels.filter(r => (r.statut||'').includes('Conforme')).length;
    const a_corriger = reels.filter(r => (r.statut||'').includes('corriger')).length;
    const bloquants  = reels.filter(r => (r.statut||'').includes('Bloquant')).length;
    const taux       = reels.length > 0 ? Math.round((conformes / reels.length) * 100) : 0;

    const summary = {
      total:           allResults.length,
      total_reels:     reels.length,
      total_exclus:    exclus.length,
      nb_categories:   exclus.filter(r => r._type_exclu === 'categorie').length,
      nb_ponctuels:    exclus.filter(r => r._type_exclu === 'ponctuel').length,
      conformes,
      a_corriger,
      bloquants,
      taux,
    };

    const resultsWithNoms = allResults.map(r => ({
      ...r,
      nom_reel: r.nom_reel || aliasMap[r.alias] || r.alias,
    }));

    // ── Rapport précédent pour suivi mensuel ──────────────
    let previousReport = null;
    try {
      const prevResult = await pool.query(
        `SELECT summary FROM audit_reports
         WHERE tenant_id = $1 AND file_id != $2
         ORDER BY updated_at DESC LIMIT 1`,
        [user.tenant_id, fileId]
      );
      if (prevResult.rows.length > 0) {
        const prevSummary = prevResult.rows[0].summary;
        const parsed = typeof prevSummary === 'string' ? JSON.parse(prevSummary) : prevSummary;
        previousReport = parsed?.score_executif
          ? {
              score_global:       parsed.score_executif.score_global,
              anomalies_total:    parsed.score_executif.resume.anomalies_detectees,
              total_fournisseurs: parsed.score_executif.resume.fournisseurs_analyses,
            }
          : null;
      }
    } catch (e) {
      safeLog('warn', 'PREV_REPORT_FETCH_FAILED', { message: e.message });
    }

    // ── Rapport complet structuré ─────────────────────────
    const fullReport = generateFullReport(
      { originalName: original_name, tenantId: user.tenant_id },
      resultsWithNoms,
      summary,
      previousReport
    );

    const csvContent = buildCSVReport(resultsWithNoms, aliasMap);
    const aiResult   = { summary, results: resultsWithNoms, aliasMap, rapport: fullReport };

    await pool.query(
      `INSERT INTO audit_reports (file_id, tenant_id, csv_content, pdf_content, summary, alias_map)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (file_id) DO UPDATE
         SET csv_content=$3, pdf_content=$4, summary=$5, alias_map=$6, updated_at=NOW()`,
      [
        fileId, user.tenant_id,
        csvContent,
        JSON.stringify(fullReport),
        JSON.stringify(aiResult),
        JSON.stringify(aliasMap),
      ]
    );

    if (fs.existsSync(file_path)) {
      fs.unlinkSync(file_path);
      safeLog('info', 'SOURCE_FILE_PURGED', { userId: user.id, tenantId: user.tenant_id });
    }

    await updateStatus('done', {
      completed_at:    new Date(),
      row_count:       summary.total,
      conformes:       summary.conformes,
      a_corriger:      summary.a_corriger,
      bloquants:       summary.bloquants,
      taux_conformite: summary.taux,
    });

    const duration = Date.now() - startTime;
    safeLog('info', 'AUDIT_COMPLETED', {
      userId: user.id, tenantId: user.tenant_id,
      rowCount: summary.total, totalReels: reels.length,
      exclus: exclus.length, batches: totalBatches, durationMs: duration,
    });

  } catch (err) {
    safeLog('error', 'AUDIT_FAILED', {
      userId: user.id, tenantId: user.tenant_id,
      errorType: err.name || 'UnknownError',
      message: err.message,
    });
    await updateStatus('error', {
      error_message: err.message.slice(0, 500),
    });
    throw err;
  }
}

module.exports = { runAuditAnalysis };
