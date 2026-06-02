// modules/rectification/claudeRectifier.js
const Anthropic = require('@anthropic-ai/sdk');
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Traitement par lots pour eviter les timeouts
const BATCH_SIZE = 10;

async function rectifyWithClaude(validatedRecords) {
  const results = [];

  for (let i = 0; i < validatedRecords.length; i += BATCH_SIZE) {
    const batch = validatedRecords.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(record => rectifyRecord(record)));
    results.push(...batchResults);
  }

  return results;
}

async function rectifyRecord(record) {
  // Pas d'anomalies → rien a corriger
  if (!record.anomalies || record.anomalies.length === 0) {
    return {
      ...record,
      corrections: [],
      statut_final: 'VALIDE',
      donnees_corrigees: record.donnees_originales,
    };
  }

  try {
    const corrections = await askClaude(record);
    return {
      ...record,
      corrections,
      statut_final: corrections.length > 0 ? 'CORRIGE' : 'ANOMALIE',
      donnees_corrigees: applyCorrections(record.donnees_originales, corrections),
    };
  } catch (err) {
    console.warn('[ClaudeRectifier] Erreur sur record', record.index, ':', err.message);
    return {
      ...record,
      corrections: [],
      statut_final: 'ERREUR_RECTIFICATION',
      erreur_claude: err.message,
    };
  }
}

async function askClaude(record) {
  const typeFichier = record.type_fichier || 'fournisseurs';
  const prompt      = buildPrompt(record, typeFichier);
  const systemPrompt = buildSystemPrompt(typeFichier);

  const response = await client.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    system:     systemPrompt,
    messages:   [{ role: 'user', content: prompt }],
  });

  const text  = response.content[0].text;
  const clean = text.replace(/```json|```/g, '').trim();

  try {
    const parsed = JSON.parse(clean);
    return Array.isArray(parsed) ? parsed : [];
  } catch(e) {
    console.warn('[ClaudeRectifier] Parse JSON echoue:', clean.slice(0, 200));
    return [];
  }
}

function buildSystemPrompt(typeFichier) {
  if (typeFichier === 'fournisseurs') {
    return `Tu es un expert en conformite des bases fournisseurs pour la facturation electronique française 2026 (e-Invoicing, PDP).
Tu reçois une ligne fournisseur avec ses anomalies detectees et les donnees enrichies depuis l'INSEE et VIES.
Tu dois proposer des corrections precises et justifiees pour preparer la conformite e-Invoicing 2026.

Regles :
- SIRET : 14 chiffres numeriques obligatoires pour 2026 (SIREN 9 chiffres = a completer)
- TVA : format FR + 2 caracteres + 9 chiffres (ex: FR83352600820)
- Si donnees INSEE disponibles : utilise-les pour corriger raison_sociale, adresse, siret
- Si donnees VIES disponibles : utilise-les pour valider/corriger la TVA
- Ne propose pas de correction si confiance < 0.5
- Reponds UNIQUEMENT en JSON valide, sans texte autour, sans markdown.`;
  }

  return `Tu es un expert en conformite des factures electroniques françaises (norme EN16931, Factur-X, e-Invoicing 2026).
Tu reçois une ligne de facture avec ses anomalies detectees et les donnees enrichies depuis l'INSEE et VIES.
Tu dois proposer des corrections precises et justifiees.
Reponds UNIQUEMENT en JSON valide, sans texte autour, sans markdown.`;
}

function buildPrompt(record, typeFichier) {
  const contexte = typeFichier === 'fournisseurs'
    ? 'fournisseur (base fournisseurs pour e-Invoicing 2026)'
    : 'facture electronique';

  return `Voici une ligne de ${contexte} avec des anomalies a corriger :

DONNEES ORIGINALES :
${JSON.stringify(record.donnees_originales, null, 2)}

ANOMALIES DETECTEES :
${JSON.stringify(record.anomalies, null, 2)}

DONNEES INSEE (si disponibles) :
${JSON.stringify(record.donnees_insee || null, null, 2)}

DONNEES VIES (si disponibles) :
${JSON.stringify(record.donnees_vies || null, null, 2)}

Propose des corrections pour chaque anomalie. Reponds avec ce format JSON exactement :
[
  {
    "champ": "nom_du_champ",
    "valeur_originale": "valeur avant correction",
    "valeur_corrigee": "valeur apres correction",
    "confiance": 0.95,
    "justification": "raison de la correction"
  }
]

Si tu ne peux pas corriger un champ avec certitude, indique une confiance < 0.5 et explique pourquoi.
Si aucune correction possible, reponds avec un tableau vide : []`;
}

function applyCorrections(original, corrections) {
  const corrige = { ...original };
  for (const correction of corrections) {
    if (correction.confiance >= 0.7 && correction.valeur_corrigee) {
      corrige[correction.champ] = correction.valeur_corrigee;
    }
  }
  return corrige;
}

module.exports = { rectifyWithClaude };
