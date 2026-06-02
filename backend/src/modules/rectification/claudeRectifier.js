// modules/rectification/claudeRectifier.js
const Anthropic = require('@anthropic-ai/sdk');
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const BATCH_SIZE  = 5;   // 5 fournisseurs par lot
const DELAY_MS    = 800; // 800ms entre chaque lot pour eviter le rate limit

async function rectifyWithClaude(validatedRecords) {
  const results = [];

  for (let i = 0; i < validatedRecords.length; i += BATCH_SIZE) {
    const batch = validatedRecords.slice(i, i + BATCH_SIZE);

    // Traitement sequentiel dans chaque lot
    for (const record of batch) {
      results.push(await rectifyRecord(record));
    }

    // Pause entre les lots sauf pour le dernier
    if (i + BATCH_SIZE < validatedRecords.length) {
      await sleep(DELAY_MS);
    }
  }

  return results;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function rectifyRecord(record) {
  // Pas d'anomalies -> valide
  if (!record.anomalies || record.anomalies.length === 0) {
    return {
      ...record,
      corrections:      [],
      statut_final:     'VALIDE',
      donnees_corrigees: record.donnees_originales,
    };
  }

  try {
    const corrections = await askClaudeWithRetry(record);
    return {
      ...record,
      corrections,
      statut_final:     corrections.length > 0 ? 'CORRIGE' : 'ANOMALIE',
      donnees_corrigees: applyCorrections(record.donnees_originales, corrections),
    };
  } catch (err) {
    console.warn('[ClaudeRectifier] Erreur record', record.index, ':', err.message);
    return {
      ...record,
      corrections:  [],
      statut_final: 'ERREUR_RECTIFICATION',
      erreur_claude: err.message,
    };
  }
}

async function askClaudeWithRetry(record, attempt = 0) {
  try {
    return await askClaude(record);
  } catch (err) {
    // Rate limit -> attendre et reessayer (max 2 fois)
    if (err.status === 429 && attempt < 2) {
      console.warn('[ClaudeRectifier] Rate limit, retry dans 3s...');
      await sleep(3000 + attempt * 2000);
      return askClaudeWithRetry(record, attempt + 1);
    }
    throw err;
  }
}

async function askClaude(record) {
  const typeFichier  = record.type_fichier || 'fournisseurs';
  const systemPrompt = buildSystemPrompt(typeFichier);
  const prompt       = buildPrompt(record, typeFichier);

  const response = await client.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 800,
    system:     systemPrompt,
    messages:   [{ role: 'user', content: prompt }],
  });

  const text  = response.content[0].text;
  const clean = text.replace(/```json|```/g, '').trim();

  try {
    const parsed = JSON.parse(clean);
    return Array.isArray(parsed) ? parsed : [];
  } catch(e) {
    console.warn('[ClaudeRectifier] Parse JSON echoue:', clean.slice(0, 100));
    return [];
  }
}

function buildSystemPrompt(typeFichier) {
  if (typeFichier === 'fournisseurs') {
    return `Tu es un expert en conformite des bases fournisseurs pour la facturation electronique francaise 2026 (e-Invoicing PDP).
Tu reçois une ligne fournisseur avec ses anomalies et les donnees INSEE/VIES disponibles.
Propose des corrections precises. Utilise les donnees INSEE si disponibles pour corriger SIRET, raison sociale, adresse.
Reponds UNIQUEMENT avec un tableau JSON valide. Sans texte. Sans markdown.`;
  }
  return `Tu es un expert en conformite des factures electroniques françaises (EN16931, Factur-X, e-Invoicing 2026).
Tu reçois une ligne de facture avec ses anomalies.
Propose des corrections precises.
Reponds UNIQUEMENT avec un tableau JSON valide. Sans texte. Sans markdown.`;
}

function buildPrompt(record, typeFichier) {
  const type = typeFichier === 'fournisseurs' ? 'fournisseur' : 'facture';
  return `Anomalies sur ce ${type} :
DONNEES : ${JSON.stringify(record.donnees_originales)}
ANOMALIES : ${JSON.stringify(record.anomalies)}
INSEE : ${JSON.stringify(record.donnees_insee || null)}
VIES : ${JSON.stringify(record.donnees_vies || null)}

Format de reponse :
[{"champ":"nom","valeur_originale":"avant","valeur_corrigee":"apres","confiance":0.9,"justification":"raison"}]
Si impossible a corriger : []`;
}

function applyCorrections(original, corrections) {
  const corrige = { ...original };
  for (const c of corrections) {
    if (c.confiance >= 0.7 && c.valeur_corrigee) {
      corrige[c.champ] = c.valeur_corrigee;
    }
  }
  return corrige;
}

module.exports = { rectifyWithClaude };
