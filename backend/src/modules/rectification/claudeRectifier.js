// modules/rectification/claudeRectifier.js
const Anthropic = require('@anthropic-ai/sdk');
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const BATCH_SIZE = 5;
const DELAY_MS   = 800;

// Statuts qui ne nécessitent aucun traitement IA
const STATUTS_EXCLUS = new Set(['CATEGORIE_DEPENSE', 'ENSEIGNE_PONCTUELLE']);

async function rectifyWithClaude(validatedRecords) {
  const results = [];
  for (let i = 0; i < validatedRecords.length; i += BATCH_SIZE) {
    const batch = validatedRecords.slice(i, i + BATCH_SIZE);
    for (const record of batch) {
      results.push(await rectifyRecord(record));
    }
    if (i + BATCH_SIZE < validatedRecords.length) await sleep(DELAY_MS);
  }
  return results;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function rectifyRecord(record) {
  // ── Cas 1 : Valide — rien à faire
  if (!record.anomalies || record.anomalies.length === 0) {
    return {
      ...record,
      corrections:       [],
      statut_final:      'VALIDE',
      donnees_corrigees: record.donnees_originales,
    };
  }

  // ── Cas 2 : Catégorie de dépenses ou enseigne ponctuelle — exclu du pipeline IA
  if (STATUTS_EXCLUS.has(record.statut)) {
    const anomalie = record.anomalies[0]; // CATEGORIE_DEPENSE ou ENSEIGNE_PONCTUELLE
    return {
      ...record,
      corrections:       [],
      statut_final:      record.statut, // conserve le statut de classification
      donnees_corrigees: record.donnees_originales,
      message_exclusion: anomalie.message,
    };
  }

  // ── Cas 3 : Corrections INSEE déjà faites
  const correctionsInsee = [];
  if (record.correction_siret) {
    correctionsInsee.push({
      champ:         record.correction_siret.champ,
      avant:         record.correction_siret.valeur_originale,
      apres:         record.correction_siret.valeur_corrigee,
      confiance:     '98%',
      justification: record.correction_siret.justification,
    });
  }

  // Si plus d'anomalies après INSEE
  if (record.anomalies.length === 0 && correctionsInsee.length > 0) {
    return {
      ...record,
      corrections:       correctionsInsee,
      statut_final:      'CORRIGE',
      donnees_corrigees: record.donnees_originales,
    };
  }

  // ── Cas 4 : Anomalies réelles → IA
  try {
    const correctionsIa = await askClaudeWithRetry(record);
    const allCorrections = [...correctionsInsee, ...correctionsIa];

    return {
      ...record,
      corrections:       allCorrections,
      statut_final:      allCorrections.length > 0 ? 'CORRIGE' : 'ANOMALIE',
      donnees_corrigees: applyCorrections(record.donnees_originales, allCorrections),
    };
  } catch(err) {
    console.warn('[ClaudeRectifier] Erreur record', record.index, ':', err.message);
    if (correctionsInsee.length > 0) {
      return {
        ...record,
        corrections:       correctionsInsee,
        statut_final:      'CORRIGE',
        donnees_corrigees: record.donnees_originales,
      };
    }
    return {
      ...record,
      corrections:   [],
      statut_final:  'ERREUR_RECTIFICATION',
      erreur_claude: err.message,
    };
  }
}

async function askClaudeWithRetry(record, attempt = 0) {
  try {
    return await askClaude(record);
  } catch(err) {
    if (err.status === 429 && attempt < 2) {
      console.warn('[ClaudeRectifier] Rate limit, retry dans', 3 + attempt*2, 's');
      await sleep((3 + attempt * 2) * 1000);
      return askClaudeWithRetry(record, attempt + 1);
    }
    throw err;
  }
}

async function askClaude(record) {
  const typeFichier = record.type_fichier || 'fournisseurs';
  const response = await client.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 600,
    system: typeFichier === 'fournisseurs'
      ? `Tu es expert en conformite fournisseurs e-Invoicing 2026 France.
Propose des corrections pour les anomalies. Utilise les donnees INSEE si disponibles.
Reponds UNIQUEMENT avec un tableau JSON valide. Sans texte. Sans markdown.`
      : `Tu es expert en factures electroniques françaises (EN16931, e-Invoicing 2026).
Propose des corrections pour les anomalies.
Reponds UNIQUEMENT avec un tableau JSON valide. Sans texte. Sans markdown.`,
    messages: [{
      role: 'user',
      content: `Anomalies a corriger :
DONNEES: ${JSON.stringify(record.donnees_originales)}
ANOMALIES: ${JSON.stringify(record.anomalies)}
INSEE: ${JSON.stringify(record.donnees_insee || null)}
VIES: ${JSON.stringify(record.donnees_vies || null)}

Format: [{"champ":"nom","avant":"avant","apres":"apres","confiance":0.9,"justification":"raison"}]
Si impossible: []`,
    }],
  });

  const text  = response.content[0].text;
  const clean = text.replace(/```json|```/g,'').trim();
  try {
    const parsed = JSON.parse(clean);
    return Array.isArray(parsed) ? parsed.map(c => ({
      champ:         c.champ,
      avant:         c.valeur_originale || c.avant || '',
      apres:         c.valeur_corrigee  || c.apres || '',
      confiance:     c.confiance ? Math.round(c.confiance * 100) + '%' : '70%',
      justification: c.justification || '',
    })) : [];
  } catch(e) {
    return [];
  }
}

function applyCorrections(original, corrections) {
  const corrige = { ...original };
  for (const c of corrections) {
    const confVal = parseFloat(String(c.confiance).replace('%','')) || 0;
    if (confVal >= 70 && c.apres) {
      const key = Object.keys(corrige).find(k =>
        k.toLowerCase().replace(/[^a-z]/g,'') === c.champ.toLowerCase().replace(/[^a-z]/g,'')
      ) || c.champ;
      corrige[key] = c.apres;
    }
  }
  return corrige;
}

module.exports = { rectifyWithClaude };
