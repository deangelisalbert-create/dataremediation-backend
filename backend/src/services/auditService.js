// services/auditService.js — Cœur métier : pseudo + IA + rapport
const fs         = require('fs');
const path       = require('path');
const Anthropic  = require('@anthropic-ai/sdk');
const { queryWithTenant, pool } = require('../config/database');
const { safeLog } = require('../middleware/errorHandler');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `Tu es un Expert Conformité e-Invoicing France 2026.
Tu reçois des données fournisseurs PSEUDONYMISÉES (alias FOURN_XXX — jamais de vrais noms).
RÈGLES DE VALIDATION :
- SIRET : exactement 14 chiffres numériques
- TVA FR : format "FR" + 2 caractères alphanumériques + 9 chiffres (SIREN). Ex: FR83352600820
- Cohérence SIREN : les 9 premiers chiffres du SIRET doivent correspondre aux 9 derniers chiffres de la TVA
- Doublon : même SIREN sous deux alias différents

STATUTS : "✅ Conforme" | "⚠️ À corriger" | "❌ Bloquant"

Réponds UNIQUEMENT avec un objet JSON valide, sans markdown, sans texte avant ou après :
{
  "summary": { "total": N, "conformes": N, "a_corriger": N, "bloquants": N, "taux": N },
  "results": [{
    "alias": "FOURN_001",
    "statut": "✅ Conforme",
    "siret_ok": true,
    "tva_ok": true,
    "siren_coherent": true,
    "erreurs": [],
    "suggestion": ""
  }]
}`;

// ── Parser CSV simple ─────────────────────────────────────
function parseCSV(content) {
  const lines = content.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  const sep = lines[0].split(';').length > lines[0].split(',').length ? ';' : ',';
  const headers = lines[0].split(sep).map(h =>
    h.trim().toLowerCase().replace(/['"]/g, '')
  );

  return lines.slice(1, 1001).map(line => {
    const cols = line.split(sep).map(c => c.trim().replace(/^["']|["']$/g, ''));
    const obj = {};
    headers.forEach((h, i) => { obj[h] = cols[i] || ''; });
    return obj;
  });
}

// ── Pseudonymisation ─────────────────────────────────────
// Remplace les noms réels par des alias opaques avant envoi à l'IA
function pseudonymize(rows) {
  const aliasMap = {}; // alias → nom réel
  const pseudoRows = rows.map((row, i) => {
    const alias = `FOURN_${String(i + 1).padStart(3, '0')}`;

    // Trouver la colonne nom
    const nomKey = Object.keys(row).find(k =>
      ['nom', 'name', 'raison', 'soci', 'libelle', 'fournisseur'].some(t => k.includes(t))
    ) || Object.keys(row)[0];

    aliasMap[alias] = row[nomKey] || alias;

    return {
      alias,
      siret: (row.siret || row.SIRET || row['n° siret'] || '').replace(/[\s.]/g, ''),
      tva:   (row.tva   || row.TVA   || row['n° tva']   || '').replace(/[\s]/g, '').toUpperCase(),
    };
  });

  return { pseudoRows, aliasMap };
}

// ── Génération CSV rapport ────────────────────────────────
function buildCSVReport(results, aliasMap) {
  const BOM = '\uFEFF'; // Pour Excel France
  const header = [
    'Nom d\'origine', 'Alias', 'Statut', 'SIRET valide', 'TVA valide',
    'Cohérence SIREN', 'Erreurs', 'Suggestion'
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

// ── Génération rapport texte (à remplacer par pdfkit en prod) ─
function buildTextReport(fileInfo, aiResult, aliasMap) {
  const sep = '═'.repeat(60);
  const sub = '─'.repeat(40);
  const date = new Date().toLocaleDateString('fr-FR', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });

  const lines = [
    sep,
    '  RAPPORT DE CONFORMITÉ e-INVOICING 2026',
    '  DataRemédiation — Confidentiel',
    sep,
    '',
    `  Fichier    : ${fileInfo.originalName}`,
    `  Généré le  : ${date}`,
    `  Tenant     : ${fileInfo.tenantId}`,
    '',
    sub,
    '  RÉSUMÉ EXÉCUTIF',
    sub,
    `  Total analysé     : ${aiResult.summary.total} fournisseurs`,
    `  Conformes         : ${aiResult.summary.conformes} (${aiResult.summary.taux}%)`,
    `  À corriger        : ${aiResult.summary.a_corriger}`,
    `  Bloquants         : ${aiResult.summary.bloquants}`,
    '',
    sub,
    '  DÉTAIL PAR FOURNISSEUR',
    sub,
    '',
    ...(aiResult.results || []).flatMap(r => [
      `  ${r.statut}  ${aliasMap[r.alias] || r.alias}`,
      `    SIRET    : ${r.siret_ok    ? '✓ Valide'   : '✗ Invalide/Manquant'}`,
      `    TVA      : ${r.tva_ok      ? '✓ Valide'   : '✗ Invalide/Manquant'}`,
      `    SIREN    : ${r.siren_coherent ? '✓ Cohérent' : '✗ Incohérent'}`,
      ...(r.erreurs?.length ? [`    Erreurs  : ${r.erreurs.join(', ')}`] : []),
      ...(r.suggestion     ? [`    Conseil  : ${r.suggestion}`]          : []),
      '',
    ]),
    sep,
    '  Généré automatiquement par DataRemédiation',
    '  Ce document est confidentiel — Usage interne uniquement',
    sep,
  ];

  return lines.join('\n');
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
    // ── Étape 1 : Passage en "analyzing" ─────────────────
    await updateStatus('analyzing', { analysis_started_at: new Date() });
    safeLog('info', 'AUDIT_STARTED', { userId: user.id, tenantId: user.tenant_id });

    // ── Étape 2 : Lire le fichier ─────────────────────────
    const fileResult = await pool.query(
      'SELECT file_path, mime_type, original_name FROM audit_files WHERE id = $1',
      [fileId]
    );

    if (fileResult.rows.length === 0) throw new Error('Fichier introuvable en base');

    const { file_path, mime_type, original_name } = fileResult.rows[0];

    // Fichiers PDF : pas d'analyse SIRET/TVA possible
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

    const rawContent = fs.readFileSync(file_path, 'utf-8');
    const rows = parseCSV(rawContent);

    if (rows.length === 0) throw new Error('Aucune donnée exploitable dans le fichier');

    // ── Étape 3 : Pseudonymisation ────────────────────────
    const { pseudoRows, aliasMap } = pseudonymize(rows);
    safeLog('info', 'DATA_PSEUDONYMIZED', {
      userId: user.id, tenantId: user.tenant_id, rowCount: pseudoRows.length
    });

    // ── Étape 4 : Appel Claude (données pseudo uniquement) ─
    const message = await anthropic.messages.create({
      model:      'claude-3-haiku-20240307',
      max_tokens: 2000,
      system:     SYSTEM_PROMPT,
      messages: [{
        role:    'user',
        content: `Audite ces ${pseudoRows.length} fournisseurs pseudonymisés :\n${JSON.stringify(pseudoRows)}`,
      }],
    });

    const rawText = message.content
      .map(b => b.type === 'text' ? b.text : '')
      .join('')
      .trim()
      .replace(/```json|```/g, '')
      .trim();

    const aiResult = JSON.parse(rawText);

    // Réassociation alias → noms réels (jamais envoyé à l'IA)
    aiResult.results = aiResult.results.map(r => ({
      ...r,
      nom_reel: aliasMap[r.alias] || r.alias,
    }));
    aiResult.aliasMap = aliasMap;

    // ── Étape 5 : Générer les rapports ────────────────────
    const csvContent  = buildCSVReport(aiResult.results, aliasMap);
    const textReport  = buildTextReport(
      { originalName: original_name, tenantId: user.tenant_id },
      aiResult, aliasMap
    );

    // ── Étape 6 : Sauvegarder en base ────────────────────
    await pool.query(
      `INSERT INTO audit_reports (file_id, tenant_id, csv_content, pdf_content, summary, alias_map)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (file_id) DO UPDATE
         SET csv_content=$3, pdf_content=$4, summary=$5, alias_map=$6, updated_at=NOW()`,
      [
        fileId, user.tenant_id,
        csvContent, textReport,
        JSON.stringify(aiResult.summary),
        JSON.stringify(aliasMap),
      ]
    );

    // Supprimer le fichier source (données plus nécessaires après analyse)
    if (fs.existsSync(file_path)) {
      fs.unlinkSync(file_path);
      safeLog('info', 'SOURCE_FILE_PURGED', { userId: user.id, tenantId: user.tenant_id });
    }

    // Mettre à jour le statut final
    await updateStatus('done', {
      completed_at:    new Date(),
      row_count:       aiResult.summary.total,
      conformes:       aiResult.summary.conformes,
      a_corriger:      aiResult.summary.a_corriger,
      bloquants:       aiResult.summary.bloquants,
      taux_conformite: aiResult.summary.taux,
    });

    const duration = Date.now() - startTime;
    safeLog('info', 'AUDIT_COMPLETED', {
      userId: user.id, tenantId: user.tenant_id,
      rowCount: aiResult.summary.total, durationMs: duration,
    });

  } catch (err) {
    safeLog('error', 'AUDIT_FAILED', {
      userId: user.id, tenantId: user.tenant_id,
      errorType: err.name || 'UnknownError',
    });
    await updateStatus('error', {
      error_message: err.message.slice(0, 500),
    });
    throw err;
  }
}

module.exports = { runAuditAnalysis };
