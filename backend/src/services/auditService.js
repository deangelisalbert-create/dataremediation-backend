// services/auditService.js — Cœur métier : pseudo + IA + rapport
const fs         = require('fs');
const path       = require('path');
const Anthropic  = require('@anthropic-ai/sdk');
const { queryWithTenant, pool } = require('../config/database');
const { safeLog } = require('../middleware/errorHandler');
const XLSX       = require('xlsx');
const { generateFullReport } = require('./reportGenerator');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `Tu es un Expert Conformité e-Invoicing France 2026.
Tu reçois des données fournisseurs PSEUDONYMISÉES (alias FOURN_XXX — jamais de vrais noms).

RÈGLES DE VALIDATION :
- SIREN/SIRET : accepter 9 chiffres numériques (SIREN) OU 14 chiffres numériques (SIRET complet)
- TVA FR : format "FR" + 2 caractères alphanumériques + 9 chiffres. Ex: FR83352600820
- Cohérence SIREN : le SIREN (9 chiffres) doit correspondre aux 9 derniers chiffres de la TVA
- Doublon : même SIREN sous deux alias différents
- Si siret/siren contient du texte non numérique (ex: "TRANSPORT", "HOTEL") → invalide

STATUTS :
- "Conforme" : SIREN ou SIRET valide (9 ou 14 chiffres) ET TVA valide ET cohérence OK
- "A corriger" : SIREN valide (9 chiffres) mais SIRET incomplet OU TVA manquante/incorrecte
- "Bloquant" : données absentes ou texte non numérique

RECOMMANDATIONS OBLIGATOIRES :
- Si statut "Conforme" avec SIREN 9 chiffres : suggestion = "Conforme 2024. Pour e-Invoicing 2026 : compléter en SIRET 14 chiffres (ajouter le code NIC 5 chiffres)"
- Si statut "Conforme" avec SIRET 14 chiffres : suggestion = "Conforme e-Invoicing 2026"
- Si statut "A corriger" : expliquer ce qui manque
- Si statut "Bloquant" : expliquer le problème et comment le corriger

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
    'Cohérence SIREN', 'Erreurs', 'Recommandation e-Invoicing 2026'
  ].join(';');

  const rows = results.map(r => [
    `"${(aliasMap[r.alias] || r.alias).replace(/"/g, '""')}"`,
    r.alias,
    r.statut,
    r.siret_ok ? 'OUI' : 'NON',
    r.tva_ok   ? 'OUI' : 'NON',
    r.siren_coherent ? 'OUI' : 'NON',
    `"${(r.erreurs || []).join(' | ')}"`,
    `"${(r.suggestion || '').replace(/"/g, '""')}"`,
  ].join(';'));

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

    // Traitement par lots
    const allResults = [];
    const totalBatches = Math.ceil(pseudoRows.length / BATCH_SIZE);
    console.log(`[AUDIT] ${pseudoRows.length} fournisseurs → ${totalBatches} lot(s)`);

    for (let i = 0; i < pseudoRows.length; i += BATCH_SIZE) {
      const batch = pseudoRows.slice(i, i + BATCH_SIZE);
      const batchIndex = Math.floor(i / BATCH_SIZE);
      console.log(`[AUDIT] Lot ${batchIndex + 1}/${totalBatches}`);
      const batchResults = await analyzeWithClaude(batch, batchIndex);
      allResults.push(...batchResults);
    }

    // Calcul summary global
    const conformes  = allResults.filter(r => (r.statut||'').includes('Conforme')).length;
    const a_corriger = allResults.filter(r => (r.statut||'').includes('corriger')).length;
    const bloquants  = allResults.filter(r => (r.statut||'').includes('Bloquant')).length;
    const taux       = allResults.length > 0 ? Math.round((conformes / allResults.length) * 100) : 0;

    const summary = { total: allResults.length, conformes, a_corriger, bloquants, taux };

    const resultsWithNoms = allResults.map(r => ({
      ...r,
      nom_reel: aliasMap[r.alias] || r.alias,
    }));

    // ── Récupérer le rapport précédent pour le suivi mensuel ──
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

    // ── Générer le rapport complet structuré (8 sections) ──
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
      rowCount: summary.total, batches: totalBatches, durationMs: duration,
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
