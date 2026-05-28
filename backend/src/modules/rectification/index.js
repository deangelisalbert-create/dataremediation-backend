const { parseFile } = require('./fileParser');
const { detectAnomalies } = require('./anomalyDetector');
const { enrichWithSirene } = require('./sireneEnricher');
const { validateWithVies } = require('./viesValidator');
const { rectifyWithClaude } = require('./claudeRectifier');
const { generateReport } = require('./reportGenerator');

/**
 * Pipeline complet de rectification
 * @param {Buffer} fileBuffer - contenu du fichier uploadé
 * @param {string} mimeType - type MIME du fichier
 * @param {string} nomFichier - nom original du fichier
 * @returns {Promise<Object>} rapport + données corrigées
 */
async function runRectificationPipeline(fileBuffer, mimeType, nomFichier) {
  console.log(`[Pipeline] Démarrage — ${nomFichier}`);

  // 1. Parse
  console.log('[Pipeline] Étape 1 : parsing...');
  const records = await parseFile(fileBuffer, mimeType);

  // 2. Détection anomalies
  console.log('[Pipeline] Étape 2 : détection anomalies...');
  const analyzed = detectAnomalies(records);

  // 3. Enrichissement INSEE (parallèle avec VIES)
  console.log('[Pipeline] Étapes 3 & 4 : enrichissement INSEE + validation VIES...');
  const [enriched] = await Promise.all([
    enrichWithSirene(analyzed),
  ]);
  const validated = await validateWithVies(enriched);

  // 4. Rectification Claude
  console.log('[Pipeline] Étape 5 : rectification Claude...');
  const rectified = await rectifyWithClaude(validated);

  // 5. Génération rapport
  console.log('[Pipeline] Étape 6 : génération rapport...');
  const rapport = generateReport(rectified, nomFichier);

  console.log(`[Pipeline] Terminé — Score : ${rapport.score_qualite.valeur}/100`);

  return {
    rapport,
    donnees_corrigees: rectified.map((r) => r.donnees_corrigees || r.donnees_originales),
  };
}

module.exports = { runRectificationPipeline };
