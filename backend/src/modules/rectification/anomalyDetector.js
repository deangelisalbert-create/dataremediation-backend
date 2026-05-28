/**
 * Détecte les anomalies sur un tableau de factures parsées
 * @param {Array} records - tableau d'objets issus du fileParser
 * @returns {Array} tableau avec anomalies annotées
 */
function detectAnomalies(records) {
  return records.map((record, index) => {
    const anomalies = [];

    // 1. SIRET
    const siret = clean(record.siret || record.SIRET || record.Siret);
    if (!siret) {
      anomalies.push({ champ: 'siret', type: 'MANQUANT', valeur: null });
    } else if (!isValidSiret(siret)) {
      anomalies.push({ champ: 'siret', type: 'INVALIDE', valeur: siret });
    }

    // 2. Numéro de TVA
    const tva = clean(record.tva || record.TVA || record.numero_tva || record.vatNumber);
    if (!tva) {
      anomalies.push({ champ: 'tva', type: 'MANQUANT', valeur: null });
    } else if (!isValidTVA(tva)) {
      anomalies.push({ champ: 'tva', type: 'INVALIDE', valeur: tva });
    }

    // 3. Montant HT
    const montantHT = parseFloat(record.montant_ht || record.montantHT || record.amount_ht || 0);
    if (isNaN(montantHT) || montantHT <= 0) {
      anomalies.push({ champ: 'montant_ht', type: 'INVALIDE', valeur: record.montant_ht });
    }

    // 4. Montant TTC
    const montantTTC = parseFloat(record.montant_ttc || record.montantTTC || record.amount_ttc || 0);
    if (isNaN(montantTTC) || montantTTC <= 0) {
      anomalies.push({ champ: 'montant_ttc', type: 'INVALIDE', valeur: record.montant_ttc });
    }

    // 5. Cohérence HT/TTC
    if (montantHT > 0 && montantTTC > 0 && montantTTC < montantHT) {
      anomalies.push({
        champ: 'montants',
        type: 'INCOHERENT',
        valeur: `TTC (${montantTTC}) < HT (${montantHT})`,
      });
    }

    // 6. Date de facture
    const date = record.date || record.date_facture || record.invoiceDate;
    if (!date) {
      anomalies.push({ champ: 'date_facture', type: 'MANQUANT', valeur: null });
    } else if (!isValidDate(date)) {
      anomalies.push({ champ: 'date_facture', type: 'INVALIDE', valeur: date });
    }

    // 7. Raison sociale
    const raisonSociale = record.raison_sociale || record.raisonSociale || record.company_name;
    if (!raisonSociale || raisonSociale.trim() === '') {
      anomalies.push({ champ: 'raison_sociale', type: 'MANQUANT', valeur: null });
    }

    return {
      index,
      donnees_originales: record,
      anomalies,
      statut: anomalies.length === 0 ? 'VALIDE' : 'ANOMALIE',
    };
  });
}

// --- Helpers ---

function clean(val) {
  return val ? String(val).replace(/\s/g, '').trim() : null;
}

function isValidSiret(siret) {
  if (!/^\d{14}$/.test(siret)) return false;
  // Algorithme de Luhn pour SIRET
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    let digit = parseInt(siret[i]);
    if (i % 2 === 0) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

function isValidTVA(tva) {
  // Format FR : FR + 2 caractères + 9 chiffres
  return /^FR[A-Z0-9]{2}\d{9}$/.test(tva.toUpperCase());
}

function isValidDate(date) {
  const d = new Date(date);
  return !isNaN(d.getTime());
}

module.exports = { detectAnomalies };
