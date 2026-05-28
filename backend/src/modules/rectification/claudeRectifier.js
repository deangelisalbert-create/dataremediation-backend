const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Rectifie les anomalies détectées via Claude API
 * @param {Array} validatedRecords - tableau issu du viesValidator
 * @returns {Promise<Array>} tableau avec corrections proposées
 */
async function rectifyWithClaude(validatedRecords) {
  const rectified = await Promise.all(
    validatedRecords.map(async (record) => {
      // Pas d'anomalies → rien à corriger
      if (record.anomalies.length === 0) {
        return {
          ...record,
          corrections: [],
          statut_final: 'VALIDE',
        };
      }

      try {
        const corrections = await askClaude(record);
        return {
          ...record,
          corrections,
          statut_final: 'CORRIGE',
          donnees_corrigees: applyCorrections(
            record.donnees_originales,
            corrections
          ),
        };
      } catch (err) {
        return {
          ...record,
          corrections: [],
          statut_final: 'ERREUR_RECTIFICATION',
          erreur_claude: err.message,
        };
      }
    })
  );

  return rectified;
}

async function askClaude(record) {
  const prompt = buildPrompt(record);

  const response = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
    system: `Tu es un expert en conformité des factures électroniques françaises (norme EN16931, Factur-X).
Tu reçois une ligne de facture avec ses anomalies détectées et les données enrichies depuis l'INSEE et VIES.
Tu dois proposer des corrections précises et justifiées.
Réponds UNIQUEMENT en JSON valide, sans texte autour, sans markdown.`,
  });

  const text = response.content[0].text;
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

function buildPrompt(record) {
  return `Voici une ligne de facture avec des anomalies à corriger :

DONNÉES ORIGINALES :
${JSON.stringify(record.donnees_originales, null, 2)}

ANOMALIES DÉTECTÉES :
${JSON.stringify(record.anomalies, null, 2)}

DONNÉES INSEE (si disponibles) :
${JSON.stringify(record.donnees_insee, null, 2)}

DONNÉES VIES (si disponibles) :
${JSON.stringify(record.donnees_vies, null, 2)}

Propose des corrections pour chaque anomalie. Réponds avec ce format JSON :
[
  {
    "champ": "nom_du_champ",
    "valeur_originale": "valeur avant correction",
    "valeur_corrigee": "valeur après correction",
    "confiance": 0.95,
    "justification": "raison de la correction"
  }
]

Si tu ne peux pas corriger un champ avec certitude, indique une confiance < 0.5 et explique pourquoi.`;
}

function applyCorrections(original, corrections) {
  const corrige = { ...original };
  for (const correction of corrections) {
    if (correction.confiance >= 0.7) {
      corrige[correction.champ] = correction.valeur_corrigee;
    }
  }
  return corrige;
}

module.exports = { rectifyWithClaude };
