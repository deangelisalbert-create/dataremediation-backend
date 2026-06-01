// services/reportGenerator.js — Rapport structuré complet DataRemédiation
// Remplace buildTextReport() dans auditService.js
// Produit un objet JSON riche couvrant les 8 sections du modèle

'use strict';

// ─────────────────────────────────────────────────────────────
// 1. SCORE EXÉCUTIF
// ─────────────────────────────────────────────────────────────
function buildScoreExecutif(summary, results) {
  const { total, conformes, a_corriger, bloquants, taux } = summary;

  const doublons        = detectDoublons(results);
  const siretInvalides  = results.filter(r => !r.siret_ok).length;
  const tvaIncoherentes = results.filter(r => !r.tva_ok).length;
  const champsCritiques = results.filter(r =>
    r.erreurs?.some(e => e.toLowerCase().includes('manquant') || e.toLowerCase().includes('absent'))
  ).length;

  let niveauRisque;
  if (taux >= 92)      niveauRisque = 'Faible';
  else if (taux >= 75) niveauRisque = 'Modéré';
  else if (taux >= 50) niveauRisque = 'Élevé';
  else                 niveauRisque = 'Critique';

  return {
    score_global: taux,
    niveau_risque: niveauRisque,
    interpretation: getInterpretation(taux),
    resume: {
      fournisseurs_analyses:  total,
      fournisseurs_conformes: conformes,
      anomalies_detectees:    a_corriger + bloquants,
      doublons:               doublons.length,
      siret_invalides:        siretInvalides,
      tva_incoherentes:       tvaIncoherentes,
      fournisseurs_bloquants: bloquants,
      champs_critiques_manquants: champsCritiques,
    },
  };
}

function getInterpretation(taux) {
  if (taux >= 92) return 'Votre base fournisseurs est conforme aux exigences e-Invoicing 2026.';
  if (taux >= 75) return 'Des anomalies modérées nécessitent une correction avant l\'échéance e-Invoicing 2026.';
  if (taux >= 50) return 'Risque élevé de blocage à l\'échéance e-Invoicing 2026. Action correctrice urgente recommandée.';
  return 'Base fournisseurs non conforme. Intervention immédiate requise pour éviter tout blocage facturation.';
}

// ─────────────────────────────────────────────────────────────
// 2. TABLEAU DE BORD
// ─────────────────────────────────────────────────────────────
function buildTableauDeBord(summary, results) {
  const { total, conformes, a_corriger, bloquants } = summary;

  // Répartition anomalies par type
  const anomalies = {
    siret_invalide:     results.filter(r => !r.siret_ok).length,
    tva_invalide:       results.filter(r => !r.tva_ok).length,
    siren_incoherent:   results.filter(r => !r.siren_coherent).length,
    doublons:           detectDoublons(results).length,
    champs_manquants:   results.filter(r =>
      r.erreurs?.some(e => e.toLowerCase().includes('manquant') || e.toLowerCase().includes('absent'))
    ).length,
  };

  // Taux de conformité par catégorie
  const tauxParCategorie = {
    siret:  total > 0 ? Math.round((results.filter(r => r.siret_ok).length / total) * 100) : 0,
    tva:    total > 0 ? Math.round((results.filter(r => r.tva_ok).length / total) * 100) : 0,
    siren:  total > 0 ? Math.round((results.filter(r => r.siren_coherent).length / total) * 100) : 0,
  };

  // Répartition fournisseurs
  const repartition = {
    conformes:   { count: conformes,  pct: total > 0 ? Math.round((conformes  / total) * 100) : 0 },
    a_corriger:  { count: a_corriger, pct: total > 0 ? Math.round((a_corriger / total) * 100) : 0 },
    bloquants:   { count: bloquants,  pct: total > 0 ? Math.round((bloquants  / total) * 100) : 0 },
  };

  return {
    repartition_fournisseurs: repartition,
    repartition_anomalies:    anomalies,
    taux_conformite_par_categorie: tauxParCategorie,
    graphiques: buildGraphiquesSynthese(summary, anomalies),
  };
}

function buildGraphiquesSynthese(summary, anomalies) {
  // Données prêtes à consommer par recharts / chart.js côté frontend
  return {
    pie_statuts: [
      { name: 'Conformes',   value: summary.conformes,  color: '#22c55e' },
      { name: 'À corriger',  value: summary.a_corriger, color: '#f59e0b' },
      { name: 'Bloquants',   value: summary.bloquants,  color: '#ef4444' },
    ],
    bar_anomalies: [
      { name: 'SIRET invalide',    value: anomalies.siret_invalide,   color: '#ef4444' },
      { name: 'TVA invalide',      value: anomalies.tva_invalide,     color: '#f97316' },
      { name: 'SIREN incohérent',  value: anomalies.siren_incoherent, color: '#eab308' },
      { name: 'Doublons',          value: anomalies.doublons,         color: '#8b5cf6' },
      { name: 'Champs manquants',  value: anomalies.champs_manquants, color: '#6b7280' },
    ],
    jauge_score: {
      valeur: summary.taux,
      seuils: { vert: 92, orange: 75, rouge: 50 },
    },
  };
}

// ─────────────────────────────────────────────────────────────
// 3. DÉTAIL DES ANOMALIES
// ─────────────────────────────────────────────────────────────
function buildDetailAnomalies(results) {
  const doublonsMap = detectDoublonsMap(results);

  const anomalies = results
    .filter(r => !r.siret_ok || !r.tva_ok || !r.siren_coherent || r.statut !== 'Conforme')
    .map(r => {
      const types = [];
      if (!r.siret_ok)       types.push('SIRET invalide');
      if (!r.tva_ok)         types.push('TVA invalide ou incohérente');
      if (!r.siren_coherent) types.push('SIREN incohérent');
      if (doublonsMap[r.alias]) types.push(`Doublon de ${doublonsMap[r.alias]}`);
      if (r.erreurs?.some(e => e.toLowerCase().includes('manquant'))) types.push('Champs critiques manquants');

      return {
        alias:         r.alias,
        nom:           r.nom_reel || r.alias,
        statut:        r.statut,
        types_anomalie: types,
        erreurs:       r.erreurs || [],
        details: {
          siret_ok:       r.siret_ok,
          tva_ok:         r.tva_ok,
          siren_coherent: r.siren_coherent,
        },
      };
    });

  return {
    total_anomalies: anomalies.length,
    par_type: groupByType(anomalies),
    liste:    anomalies,
  };
}

function groupByType(anomalies) {
  const groups = {};
  anomalies.forEach(a => {
    a.types_anomalie.forEach(type => {
      if (!groups[type]) groups[type] = [];
      groups[type].push(a.nom);
    });
  });
  return groups;
}

// ─────────────────────────────────────────────────────────────
// 4. PLAN DE REMÉDIATION
// ─────────────────────────────────────────────────────────────
function buildPlanRemediation(results) {
  const actions = [];

  results.forEach(r => {
    if (r.statut === 'Conforme') return;

    const priorite = r.statut === 'Bloquant' ? 'CRITIQUE' : 'MODÉRÉE';
    const impact   = r.statut === 'Bloquant'
      ? 'Factures rejetées à l\'échéance e-Invoicing 2026'
      : 'Risque de rejet ou délai de traitement accru';

    if (!r.siret_ok) {
      actions.push({
        fournisseur:         r.nom_reel || r.alias,
        probleme:            'SIRET/SIREN invalide ou absent',
        correction_proposee: 'Contacter le fournisseur pour obtenir et valider le SIRET complet (14 chiffres). Vérifier sur data.gouv.fr/api-sirene.',
        priorite,
        impact_metier:       impact,
        delai_recommande:    priorite === 'CRITIQUE' ? 'Immédiat (< 1 semaine)' : 'Court terme (< 1 mois)',
      });
    }

    if (!r.tva_ok) {
      actions.push({
        fournisseur:         r.nom_reel || r.alias,
        probleme:            'Numéro TVA invalide ou incohérent avec le SIREN',
        correction_proposee: 'Vérifier le N° TVA intracommunautaire : format FR + 2 caractères + 9 chiffres. Valider sur ec.europa.eu/taxation_customs/vies.',
        priorite,
        impact_metier:       'Risque de rejet par la plateforme e-Invoicing. Possible fraude fiscale si TVA erronée.',
        delai_recommande:    priorite === 'CRITIQUE' ? 'Immédiat (< 1 semaine)' : 'Court terme (< 1 mois)',
      });
    }

    if (!r.siren_coherent) {
      actions.push({
        fournisseur:         r.nom_reel || r.alias,
        probleme:            'Incohérence entre SIREN et TVA',
        correction_proposee: 'Vérifier que les 9 derniers chiffres de la TVA correspondent au SIREN. Corriger l\'un ou l\'autre selon la source fiable.',
        priorite:            'MODÉRÉE',
        impact_metier:       'Rejet possible lors des contrôles automatiques de la plateforme de dématérialisation.',
        delai_recommande:    'Court terme (< 1 mois)',
      });
    }
  });

  // Dédupliquer par fournisseur + problème
  const unique = actions.filter((a, i, arr) =>
    arr.findIndex(b => b.fournisseur === a.fournisseur && b.probleme === a.probleme) === i
  );

  const critiques = unique.filter(a => a.priorite === 'CRITIQUE');
  const moderees  = unique.filter(a => a.priorite === 'MODÉRÉE');

  return {
    total_actions: unique.length,
    actions_critiques: critiques.length,
    actions_moderees:  moderees.length,
    par_priorite: { CRITIQUE: critiques, MODÉRÉE: moderees },
    liste_complete: unique,
  };
}

// ─────────────────────────────────────────────────────────────
// 5. SCORING FOURNISSEUR
// ─────────────────────────────────────────────────────────────
function buildScoringFournisseurs(results) {
  const doublonsMap = detectDoublonsMap(results);

  const scored = results.map(r => {
    let score = 100;
    const penalites = [];

    if (!r.siret_ok)       { score -= 40; penalites.push('SIRET invalide (-40)'); }
    if (!r.tva_ok)         { score -= 30; penalites.push('TVA invalide (-30)'); }
    if (!r.siren_coherent) { score -= 20; penalites.push('SIREN incohérent (-20)'); }
    if (doublonsMap[r.alias]) { score -= 10; penalites.push('Doublon détecté (-10)'); }

    score = Math.max(0, score);

    let categorie;
    if (score >= 80)      categorie = 'Conforme';
    else if (score >= 50) categorie = 'À surveiller';
    else                  categorie = 'Action immédiate';

    return {
      alias:     r.alias,
      nom:       r.nom_reel || r.alias,
      score,
      categorie,
      penalites,
      statut_ia: r.statut,
      suggestion: r.suggestion || '',
    };
  });

  // Tri par score croissant (les plus urgents en premier)
  scored.sort((a, b) => a.score - b.score);

  const distribution = {
    conformes:        scored.filter(s => s.categorie === 'Conforme').length,
    a_surveiller:     scored.filter(s => s.categorie === 'À surveiller').length,
    action_immediate: scored.filter(s => s.categorie === 'Action immédiate').length,
  };

  return {
    distribution,
    score_moyen: scored.length > 0
      ? Math.round(scored.reduce((acc, s) => acc + s.score, 0) / scored.length)
      : 0,
    fournisseurs: scored,
  };
}

// ─────────────────────────────────────────────────────────────
// 6. SUIVI MENSUEL (structure pour abonnement)
// ─────────────────────────────────────────────────────────────
function buildSuiviMensuel(summary, previousReport = null) {
  const suivi = {
    periode: new Date().toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' }),
    score_actuel: summary.taux,
    score_precedent: previousReport?.score_global ?? null,
    evolution: previousReport
      ? summary.taux - previousReport.score_global
      : null,
    nouvelles_anomalies: previousReport
      ? Math.max(0, (summary.a_corriger + summary.bloquants) - previousReport.anomalies_total)
      : null,
    fournisseurs_ajoutes: previousReport
      ? Math.max(0, summary.total - previousReport.total_fournisseurs)
      : null,
    message: previousReport
      ? buildMessageEvolution(summary.taux, previousReport.score_global)
      : 'Premier audit — référence établie pour le suivi mensuel.',
    historique_disponible: !!previousReport,
  };

  return suivi;
}

function buildMessageEvolution(scoreCourant, scorePrecedent) {
  const delta = scoreCourant - scorePrecedent;
  if (delta > 5)  return `Progression de +${delta}% par rapport au mois précédent. Continuez les corrections.`;
  if (delta < -5) return `Régression de ${delta}% — de nouvelles anomalies ont été détectées.`;
  return 'Score stable par rapport au mois précédent.';
}

// ─────────────────────────────────────────────────────────────
// 7. INDICATEURS DE VALEUR (ROI)
// ─────────────────────────────────────────────────────────────
function buildIndicateursValeur(summary) {
  const { total, a_corriger, bloquants } = summary;
  const anomaliesTotal = a_corriger + bloquants;

  // Hypothèses métier conservatrices
  const TEMPS_MANUEL_PAR_ANOMALIE_H = 0.5;   // 30 min par anomalie en manuel
  const TAUX_HORAIRE_COMPTABLE      = 45;    // €/h chargé
  const COUT_REJET_FACTURE          = 35;    // € par facture rejetée estimé

  const tempsManutelEconomise = anomaliesTotal * TEMPS_MANUEL_PAR_ANOMALIE_H;
  const coutInterneEstime     = tempsManutelEconomise * TAUX_HORAIRE_COMPTABLE;
  const gainEvitementRejets   = bloquants * COUT_REJET_FACTURE;
  const gainTotal             = coutInterneEstime + gainEvitementRejets;

  return {
    anomalies_detectees:      anomaliesTotal,
    temps_manuel_economise_h: Math.round(tempsManutelEconomise * 10) / 10,
    cout_interne_estime_eur:  Math.round(coutInterneEstime),
    gain_evitement_rejets_eur: Math.round(gainEvitementRejets),
    gain_total_estime_eur:    Math.round(gainTotal),
    ratio_fournisseurs_traites: total,
    hypotheses: {
      temps_par_anomalie_h:  TEMPS_MANUEL_PAR_ANOMALIE_H,
      taux_horaire_eur:      TAUX_HORAIRE_COMPTABLE,
      cout_rejet_facture_eur: COUT_REJET_FACTURE,
    },
    message_valeur: `DataRemédiation vous a économisé environ ${Math.round(tempsManutelEconomise)} heures de travail manuel, soit ~${Math.round(gainTotal)} € de coût interne évité.`,
  };
}

// ─────────────────────────────────────────────────────────────
// 8. CONTRÔLES PREMIUM
// ─────────────────────────────────────────────────────────────
function buildControlesPremium(results) {
  const doublons = detectDoublons(results);

  // Correspondance SIRET / raison sociale (signaux d'alerte)
  const alertesFraude = results.filter(r => {
    // Heuristique : statut Bloquant + ni SIRET ni TVA valides = profil suspect
    return r.statut === 'Bloquant' && !r.siret_ok && !r.tva_ok;
  }).map(r => ({
    nom:    r.nom_reel || r.alias,
    alerte: 'Fournisseur sans identifiants valides — vérification manuelle recommandée',
    niveau: 'ÉLEVÉ',
  }));

  // Cohérence avancée SIRET / TVA
  const incoherencesAvancees = results.filter(r =>
    r.siret_ok && r.tva_ok && !r.siren_coherent
  ).map(r => ({
    nom:    r.nom_reel || r.alias,
    alerte: 'SIRET et TVA valides individuellement mais SIREN incohérent entre les deux',
    niveau: 'MODÉRÉ',
  }));

  return {
    disponible: true,
    doublons_detectes: {
      count: doublons.length,
      liste: doublons,
    },
    alertes_fraude_potentielle: {
      count: alertesFraude.length,
      liste: alertesFraude,
    },
    incoherences_avancees: {
      count: incoherencesAvancees.length,
      liste: incoherencesAvancees,
    },
    note: 'Les contrôles premium incluront prochainement : vérification INPI, détection fournisseurs inactifs >3 ans, score de risque fraude avancé.',
  };
}

// ─────────────────────────────────────────────────────────────
// UTILITAIRES — Détection doublons
// ─────────────────────────────────────────────────────────────
function detectDoublons(results) {
  // Doublon = même SIREN (extrait du SIRET) sous deux alias différents
  const sirenMap = {};
  results.forEach(r => {
    const siret = String(r.siret || '').replace(/\s/g, '');
    if (siret.length >= 9) {
      const siren = siret.slice(0, 9);
      if (!sirenMap[siren]) sirenMap[siren] = [];
      sirenMap[siren].push(r.nom_reel || r.alias);
    }
  });

  const doublons = [];
  Object.entries(sirenMap).forEach(([siren, noms]) => {
    if (noms.length > 1) {
      doublons.push({ siren, fournisseurs: noms });
    }
  });
  return doublons;
}

function detectDoublonsMap(results) {
  // Retourne { alias: "nom du doublon" } pour les doublons
  const sirenMap = {};
  results.forEach(r => {
    const siret = String(r.siret || '').replace(/\s/g, '');
    if (siret.length >= 9) {
      const siren = siret.slice(0, 9);
      if (!sirenMap[siren]) sirenMap[siren] = [];
      sirenMap[siren].push({ alias: r.alias, nom: r.nom_reel || r.alias });
    }
  });

  const map = {};
  Object.values(sirenMap).forEach(group => {
    if (group.length > 1) {
      group.forEach((item, i) => {
        const others = group.filter((_, j) => j !== i).map(g => g.nom).join(', ');
        map[item.alias] = others;
      });
    }
  });
  return map;
}

// ─────────────────────────────────────────────────────────────
// EXPORT PRINCIPAL
// ─────────────────────────────────────────────────────────────

/**
 * generateFullReport()
 *
 * @param {Object} fileInfo       — { originalName, tenantId }
 * @param {Array}  results        — tableau de résultats Claude (avec nom_reel)
 * @param {Object} summary        — { total, conformes, a_corriger, bloquants, taux }
 * @param {Object} previousReport — (optionnel) dernier rapport du tenant pour suivi mensuel
 *
 * @returns {Object} rapport JSON complet couvrant les 8 sections du modèle
 */
function generateFullReport(fileInfo, results, summary, previousReport = null) {
  const date = new Date().toLocaleDateString('fr-FR', {
    year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  return {
    meta: {
      version:       '2.0',
      fichier:       fileInfo.originalName,
      tenant_id:     fileInfo.tenantId,
      genere_le:     date,
      genere_par:    'DataRemédiation — Confidentiel',
    },

    // Section 1
    score_executif: buildScoreExecutif(summary, results),

    // Section 2
    tableau_de_bord: buildTableauDeBord(summary, results),

    // Section 3
    detail_anomalies: buildDetailAnomalies(results),

    // Section 4
    plan_remediation: buildPlanRemediation(results),

    // Section 5
    scoring_fournisseurs: buildScoringFournisseurs(results),

    // Section 6
    suivi_mensuel: buildSuiviMensuel(summary, previousReport),

    // Section 7
    indicateurs_valeur: buildIndicateursValeur(summary),

    // Section 8
    controles_premium: buildControlesPremium(results),
  };
}

module.exports = { generateFullReport };
