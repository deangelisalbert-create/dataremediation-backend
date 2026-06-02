// modules/rectification/reportGenerator.js
// Rapport enrichi : score par categorie, risque PDP, ROI, plan d'action

function generateReport(rectifiedRecords, nomFichier) {
  const typeFichier = detectType(rectifiedRecords);
  const stats       = computeStats(rectifiedRecords, typeFichier);
  const scoreCateg  = computeScoreParCategorie(rectifiedRecords, typeFichier);
  const risquePDP   = computeRisquePDP(stats, scoreCateg);
  const roi         = computeROI(stats);
  const planAction  = buildPlanAction(stats, scoreCateg, typeFichier);
  const scoreQualite = computeScore(stats);

  return {
    meta: {
      fichier:       nomFichier,
      date_analyse:  new Date().toISOString(),
      total_lignes:  rectifiedRecords.length,
      type_fichier:  typeFichier,
      version:       '2.0.0',
    },
    score_qualite:       scoreQualite,
    score_par_categorie: scoreCateg,
    risque_pdp:          risquePDP,
    roi:                 roi,
    statistiques:        stats,
    plan_action:         planAction,
    details:             buildDetails(rectifiedRecords),
    resume:              buildResume(stats, scoreQualite, risquePDP, roi, typeFichier),
  };
}

// ── Detection type fichier ────────────────────────────────
function detectType(records) {
  if (!records || records.length === 0) return 'fournisseurs';
  return records[0].type_fichier || 'fournisseurs';
}

// ── Stats globales ────────────────────────────────────────
function computeStats(records, typeFichier) {
  const total    = records.length;
  const valides  = records.filter(r => r.statut_final === 'VALIDE').length;
  const corriges = records.filter(r => r.statut_final === 'CORRIGE').length;
  const erreurs  = records.filter(r => r.statut_final === 'ERREUR_RECTIFICATION').length;
  const anomalies = records.filter(r => r.statut === 'ANOMALIE' || r.statut_final === 'ERREUR_RECTIFICATION').length;

  // Comptage par type d'anomalie
  const anomaliesParType = {};
  const correctionsParChamp = {};

  for (const record of records) {
    for (const anomalie of record.anomalies || []) {
      const key = anomalie.champ + '_' + anomalie.type;
      anomaliesParType[key] = (anomaliesParType[key] || 0) + 1;
    }
    for (const correction of record.corrections || []) {
      correctionsParChamp[correction.champ] = (correctionsParChamp[correction.champ] || 0) + 1;
    }
  }

  // Comptages specifiques fournisseurs
  const sansSimet   = records.filter(r => r.anomalies?.some(a => a.champ === 'siret' && a.type === 'MANQUANT')).length;
  const siretInvalide = records.filter(r => r.anomalies?.some(a => a.champ === 'siret' && a.type === 'INVALIDE')).length;
  const sansTva     = records.filter(r => r.anomalies?.some(a => a.champ === 'tva')).length;
  const sansAdresse = records.filter(r => r.anomalies?.some(a => a.champ === 'adresse')).length;
  const emailInvalide = records.filter(r => r.anomalies?.some(a => a.champ === 'email')).length;
  const ibanInvalide  = records.filter(r => r.anomalies?.some(a => a.champ === 'iban')).length;

  return {
    total,
    valides,
    corriges,
    erreurs,
    anomalies,
    non_traites:    total - valides - corriges - erreurs,
    taux_anomalies: total > 0 ? Math.round((anomalies / total) * 100) : 0,
    taux_correction: anomalies > 0 ? Math.round((corriges / anomalies) * 100) : 0,
    sans_siret:      sansSimet,
    siret_invalide:  siretInvalide,
    sans_tva:        sansTva,
    sans_adresse:    sansAdresse,
    email_invalide:  emailInvalide,
    iban_invalide:   ibanInvalide,
    anomalies_par_type:     anomaliesParType,
    corrections_par_champ:  correctionsParChamp,
  };
}

// ── Score par categorie ───────────────────────────────────
function computeScoreParCategorie(records, typeFichier) {
  const total = records.length;
  if (total === 0) return {};

  if (typeFichier === 'fournisseurs') {
    const okSiret   = records.filter(r => !r.anomalies?.some(a => a.champ === 'siret')).length;
    const okTva     = records.filter(r => !r.anomalies?.some(a => a.champ === 'tva')).length;
    const okEmail   = records.filter(r => !r.anomalies?.some(a => a.champ === 'email')).length;
    const okAdresse = records.filter(r => !r.anomalies?.some(a => a.champ === 'adresse')).length;
    const okIban    = records.filter(r => !r.anomalies?.some(a => a.champ === 'iban')).length;
    const okDenom   = records.filter(r => !r.anomalies?.some(a => a.champ === 'denomination')).length;

    return {
      siret:       { score: Math.round((okSiret / total) * 100),   libelle: 'SIRET / SIREN',           priorite: okSiret < total * 0.8 ? 'CRITIQUE' : 'OK' },
      tva:         { score: Math.round((okTva / total) * 100),     libelle: 'TVA Intracommunautaire',   priorite: okTva < total * 0.8 ? 'ELEVE' : 'OK' },
      denomination:{ score: Math.round((okDenom / total) * 100),   libelle: 'Denomination / Nom',       priorite: okDenom < total * 0.9 ? 'ELEVE' : 'OK' },
      adresse:     { score: Math.round((okAdresse / total) * 100), libelle: 'Adresse',                  priorite: okAdresse < total * 0.7 ? 'MODERE' : 'OK' },
      email:       { score: Math.round((okEmail / total) * 100),   libelle: 'Email',                    priorite: 'OK' },
      iban:        { score: Math.round((okIban / total) * 100),    libelle: 'IBAN / Coordonnees banc.', priorite: 'OK' },
    };
  }

  // Factures
  const okSiret = records.filter(r => !r.anomalies?.some(a => a.champ === 'siret')).length;
  const okTva   = records.filter(r => !r.anomalies?.some(a => a.champ === 'tva')).length;
  const okMontants = records.filter(r => !r.anomalies?.some(a => ['montant_ht','montant_ttc','montants'].includes(a.champ))).length;
  const okDate  = records.filter(r => !r.anomalies?.some(a => a.champ === 'date_facture')).length;

  return {
    siret:    { score: Math.round((okSiret/total)*100),    libelle: 'SIRET Fournisseur', priorite: okSiret < total*0.8 ? 'CRITIQUE' : 'OK' },
    tva:      { score: Math.round((okTva/total)*100),      libelle: 'TVA',               priorite: okTva < total*0.8 ? 'ELEVE' : 'OK' },
    montants: { score: Math.round((okMontants/total)*100), libelle: 'Montants HT/TTC',   priorite: 'OK' },
    dates:    { score: Math.round((okDate/total)*100),     libelle: 'Dates',             priorite: 'OK' },
  };
}

// ── Risque PDP ────────────────────────────────────────────
function computeRisquePDP(stats, scoreCateg) {
  const siretScore = scoreCateg.siret?.score || 100;
  const tvaScore   = scoreCateg.tva?.score   || 100;

  let niveau, description, impact;

  if (siretScore < 50 || stats.sans_siret > stats.total * 0.3) {
    niveau      = 'CRITIQUE';
    description = 'Risque majeur de rejet par la PDP. Plus de 30% des fournisseurs sans SIRET valide.';
    impact      = 'Blocage total de la facturation electronique a l\'echeance 2026.';
  } else if (siretScore < 80 || tvaScore < 70) {
    niveau      = 'ELEVE';
    description = 'Risque eleve de rejets partiels par la PDP. Corrections urgentes necessaires.';
    impact      = 'Rejets de factures, retards de paiement, contentieux potentiels.';
  } else if (siretScore < 95 || tvaScore < 90) {
    niveau      = 'MODERE';
    description = 'Quelques fournisseurs necessitent une correction avant l\'echeance 2026.';
    impact      = 'Risque limite si corrections effectuees dans les 3 prochains mois.';
  } else {
    niveau      = 'FAIBLE';
    description = 'Base fournisseurs globalement conforme pour la facturation electronique 2026.';
    impact      = 'Surveillance recommandee pour les nouveaux fournisseurs.';
  }

  return {
    niveau,
    description,
    impact,
    fournisseurs_bloquants: stats.sans_siret + stats.siret_invalide,
    fournisseurs_a_risque:  stats.sans_tva,
    score_conformite_pdp:   Math.round((siretScore * 0.6 + tvaScore * 0.4)),
  };
}

// ── ROI ───────────────────────────────────────────────────
function computeROI(stats) {
  const TEMPS_PAR_FOURNISSEUR_MIN = 8;   // 8 min par fournisseur en manuel
  const TAUX_HORAIRE_EUR          = 55;  // EUR/h comptable
  const COUT_REJET_EUR            = 35;  // cout d'un rejet PDP

  const tempsManuelMin  = stats.anomalies * TEMPS_PAR_FOURNISSEUR_MIN;
  const tempsManuelH    = Math.round(tempsManuelMin / 60 * 10) / 10;
  const coutManuelEUR   = Math.round(tempsManuelH * TAUX_HORAIRE_EUR);
  const gainRejetsEUR   = Math.round(stats.sans_siret * COUT_REJET_EUR);
  const gainTotalEUR    = coutManuelEUR + gainRejetsEUR;
  const tempsAutoMin    = Math.max(1, Math.round(stats.total * 0.05));

  return {
    temps_manuel_h:       tempsManuelH,
    temps_automatise_min: tempsAutoMin,
    cout_manuel_eur:      coutManuelEUR,
    gain_rejets_eur:      gainRejetsEUR,
    gain_total_eur:       gainTotalEUR,
    taux_correction_auto: stats.taux_correction,
    message: `${stats.anomalies} fournisseurs necessitent une intervention. Temps manuel estime : ${tempsManuelH}h (${coutManuelEUR} EUR). Remediation automatique : ${tempsAutoMin} min.`,
  };
}

// ── Plan d'action ─────────────────────────────────────────
function buildPlanAction(stats, scoreCateg, typeFichier) {
  const actions = [];

  if (typeFichier === 'fournisseurs') {
    if (stats.sans_siret > 0) {
      actions.push({
        priorite:  'CRITIQUE',
        action:    'Completer les SIRET manquants',
        detail:    `${stats.sans_siret} fournisseurs sans SIRET. Contacter directement ou rechercher sur data.gouv.fr/api-sirene.`,
        impact:    'Blocage PDP si non corrige avant 2026.',
        delai:     'Immediat (< 2 semaines)',
      });
    }
    if (stats.siret_invalide > 0) {
      actions.push({
        priorite:  'CRITIQUE',
        action:    'Corriger les SIRET invalides',
        detail:    `${stats.siret_invalide} SIRET ne passent pas la validation. Verifier le format 14 chiffres.`,
        impact:    'Rejet automatique par la PDP.',
        delai:     'Immediat (< 2 semaines)',
      });
    }
    if (stats.sans_tva > 0) {
      actions.push({
        priorite:  'ELEVE',
        action:    'Completer les numeros TVA',
        detail:    `${stats.sans_tva} fournisseurs sans TVA intracommunautaire. Format : FR + 2 caracteres + 9 chiffres.`,
        impact:    'Risque de deductibilite TVA.',
        delai:     'Court terme (< 1 mois)',
      });
    }
    if (stats.sans_adresse > 0) {
      actions.push({
        priorite:  'MODERE',
        action:    'Completer les adresses manquantes',
        detail:    `${stats.sans_adresse} fournisseurs sans adresse complete.`,
        impact:    'Donnees incompletes pour la PDP.',
        delai:     'Moyen terme (< 3 mois)',
      });
    }
    if (stats.email_invalide > 0) {
      actions.push({
        priorite:  'FAIBLE',
        action:    'Corriger les emails invalides',
        detail:    `${stats.email_invalide} emails au format invalide.`,
        impact:    'Communication fournisseur impossible.',
        delai:     'Moyen terme (< 3 mois)',
      });
    }
  } else {
    if (stats.sans_siret > 0) {
      actions.push({
        priorite: 'CRITIQUE',
        action:   'Completer les SIRET fournisseurs',
        detail:   `${stats.sans_siret} factures sans SIRET fournisseur valide.`,
        impact:   'Rejet EN16931 / Factur-X.',
        delai:    'Immediat',
      });
    }
  }

  // Action finale
  actions.push({
    priorite: 'INFO',
    action:   'Relancer un audit de verification',
    detail:   'Apres corrections, relancer DataRemediation pour valider la conformite finale.',
    impact:   'Garantir la conformite avant l\'echeance.',
    delai:    'Apres corrections',
  });

  return actions;
}

// ── Details par ligne ─────────────────────────────────────
function buildDetails(records) {
  return records.map(record => {
    const detail = {
      index:  record.index,
      statut: record.statut_final || record.statut,
      anomalies: record.anomalies || [],
    };

    if (record.corrections && record.corrections.length > 0) {
      detail.corrections = record.corrections.map(c => ({
        champ:         c.champ,
        avant:         c.valeur_originale,
        apres:         c.valeur_corrigee,
        confiance:     Math.round((c.confiance || 0) * 100) + '%',
        justification: c.justification,
      }));
    }

    if (record.donnees_insee) {
      detail.enrichissement_insee = {
        raison_sociale:    record.donnees_insee.raison_sociale,
        adresse:           record.donnees_insee.adresse,
        statut_entreprise: record.donnees_insee.statut === 'A' ? 'Active' : 'Cessee',
        code_naf:          record.donnees_insee.code_naf,
      };
    }

    if (record.donnees_vies) {
      detail.validation_tva = {
        tva:    record.donnees_vies.tva,
        valide: record.donnees_vies.valide,
      };
    }

    return detail;
  });
}

// ── Score qualite global ──────────────────────────────────
function computeScore(stats) {
  const lignesOk = stats.valides + stats.corriges;
  const score    = stats.total > 0 ? Math.round((lignesOk / stats.total) * 100) : 0;

  let mention;
  if (score >= 90)      mention = 'Excellent';
  else if (score >= 70) mention = 'Bon';
  else if (score >= 50) mention = 'Moyen';
  else                  mention = 'Insuffisant';

  return { valeur: score, mention };
}

// ── Resume textuel ────────────────────────────────────────
function buildResume(stats, score, risquePDP, roi, typeFichier) {
  const type = typeFichier === 'fournisseurs' ? 'fournisseurs' : 'factures';
  const lignes = [
    `Analyse de ${stats.total} ${type} - Score : ${score.valeur}/100 (${score.mention})`,
    `${stats.valides} valides, ${stats.corriges} corriges, ${stats.erreurs} en erreur.`,
    `Risque PDP : ${risquePDP.niveau} - ${risquePDP.description}`,
    roi.message,
  ];
  return lignes.join(' | ');
}

module.exports = { generateReport };
