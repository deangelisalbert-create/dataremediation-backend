/**
 * Génère un rapport de rectification complet
 * @param {Array} rectifiedRecords - tableau issu du claudeRectifier
 * @param {string} nomFichier - nom du fichier original
 * @returns {Object} rapport complet
 */
function generateReport(rectifiedRecords, nomFichier) {
  const stats = computeStats(rectifiedRecords);
  const details = buildDetails(rectifiedRecords);
  const scoreQualite = computeScore(stats);

  return {
    meta: {
      fichier: nomFichier,
      date_analyse: new Date().toISOString(),
      total_lignes: rectifiedRecords.length,
      version: '1.0.0',
    },
    score_qualite: scoreQualite,
    statistiques: stats,
    details,
    resume: buildResume(stats, scoreQualite),
  };
}

function computeStats(records) {
  const total = records.length;
  const valides = records.filter((r) => r.statut === 'VALIDE').length;
  const corriges = records.filter((r) => r.statut_final === 'CORRIGE').length;
  const erreurs = records.filter(
    (r) => r.statut_final === 'ERREUR_RECTIFICATION'
  ).length;

  // Compte par type d'anomalie
  const anomaliesParType = {};
  for (const record of records) {
    for (const anomalie of record.anomalies || []) {
      const key = `${anomalie.champ}_${anomalie.type}`;
      anomaliesParType[key] = (anomaliesParType[key] || 0) + 1;
    }
  }

  // Compte corrections par champ
  const correctionsParChamp = {};
  for (const record of records) {
    for (const correction of record.corrections || []) {
      correctionsParChamp[correction.champ] =
        (correctionsParChamp[correction.champ] || 0) + 1;
    }
  }

  return {
    total,
    valides,
    corriges,
    erreurs,
    non_traites: total - valides - corriges - erreurs,
    taux_anomalies: Math.round(((total - valides) / total) * 100),
    taux_correction: corriges > 0
      ? Math.round((corriges / (total - valides)) * 100)
      : 0,
    anomalies_par_type: anomaliesParType,
    corrections_par_champ: correctionsParChamp,
  };
}

function buildDetails(records) {
  return records.map((record) => {
    const detail = {
      index: record.index,
      statut: record.statut_final || record.statut,
      anomalies: record.anomalies || [],
    };

    if (record.corrections && record.corrections.length > 0) {
      detail.corrections = record.corrections.map((c) => ({
        champ: c.champ,
        avant: c.valeur_originale,
        apres: c.valeur_corrigee,
        confiance: Math.round(c.confiance * 100) + '%',
        justification: c.justification,
      }));
    }

    if (record.donnees_insee) {
      detail.enrichissement_insee = {
        raison_sociale: record.donnees_insee.raison_sociale,
        adresse: record.donnees_insee.adresse,
        statut_entreprise:
          record.donnees_insee.statut === 'A' ? 'Active' : 'Cessée',
      };
    }

    if (record.donnees_vies) {
      detail.validation_tva = {
        tva: record.donnees_vies.tva,
        valide: record.donnees_vies.valide,
      };
    }

    return detail;
  });
}

function computeScore(stats) {
  // Score sur 100 basé sur le taux de lignes valides ou corrigées
  const lignesOk = stats.valides + stats.corriges;
  const score = Math.round((lignesOk / stats.total) * 100);
  return {
    valeur: score,
   mention: score >= 90 ? 'Excellent' :
         score >= 70 ? 'Bon' :
         score >= 50 ? 'Moyen' : 'Insuffisant',
