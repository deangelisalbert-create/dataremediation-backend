// modules/rectification/anomalyDetector.js
// Detecte automatiquement si le fichier est une base fournisseurs ou des factures

function detectAnomalies(records) {
  if (!records || records.length === 0) return [];

  const type = detectFileType(records[0]);
  console.log('[AnomalyDetector] Type detecte:', type);

  return records.map((record, index) => {
    const anomalies = type === 'fournisseurs'
      ? detectAnomaliesFournisseur(record)
      : detectAnomaliesFacture(record);

    return {
      index,
      donnees_originales: record,
      anomalies,
      statut: anomalies.length === 0 ? 'VALIDE' : 'ANOMALIE',
      type_fichier: type,
    };
  });
}

// ── Détection automatique du type de fichier ──────────────
function detectFileType(firstRecord) {
  const keys = Object.keys(firstRecord).map(k => k.toLowerCase().trim());

  // Signaux fournisseurs
  const signalsFournisseur = [
    'denomination', 'dénomination', 'raison_sociale', 'fournisseur',
    'siren', 'siret', 'iban', 'adresse', 'email', 'telephone',
    'nom_fournisseur', 'supplier', 'vendor',
  ];

  // Signaux factures
  const signalsFacture = [
    'montant_ht', 'montant_ttc', 'montantht', 'montantttc',
    'date_facture', 'numero_facture', 'invoice', 'amount',
    'facture', 'debit', 'credit',
  ];

  const scoreFournisseur = signalsFournisseur.filter(s =>
    keys.some(k => k.includes(s))
  ).length;

  const scoreFacture = signalsFacture.filter(s =>
    keys.some(k => k.includes(s))
  ).length;

  return scoreFournisseur >= scoreFacture ? 'fournisseurs' : 'factures';
}

// ── Anomalies FOURNISSEURS ────────────────────────────────
function detectAnomaliesFournisseur(record) {
  const anomalies = [];
  const keys = Object.keys(record);

  // Helper pour trouver une valeur par mots-clés
  const find = (...keywords) => {
    for (const kw of keywords) {
      const key = keys.find(k => k.toLowerCase().replace(/[\s_-]/g,'').includes(kw.toLowerCase().replace(/[\s_-]/g,'')));
      if (key && record[key] && String(record[key]).trim()) return String(record[key]).trim();
    }
    return null;
  };

  // 1. Dénomination / Raison sociale
  const nom = find('denomination', 'dénomination', 'raison_sociale', 'raisonsociale', 'fournisseur', 'nom', 'company', 'supplier');
  if (!nom) {
    anomalies.push({ champ: 'denomination', type: 'MANQUANT', valeur: null });
  }

  // 2. SIRET / SIREN
  const siret = clean(find('siret', 'siren', 'siret_siren'));
  if (!siret) {
    anomalies.push({ champ: 'siret', type: 'MANQUANT', valeur: null });
  } else if (!/^\d{9}$/.test(siret) && !isValidSiret(siret)) {
    anomalies.push({ champ: 'siret', type: 'INVALIDE', valeur: siret });
  }

  // 3. TVA intracommunautaire
  const tva = clean(find('tva', 'vat', 'numero_tva', 'numerotva', 'vatNumber'));
  if (tva && !isValidTVA(tva)) {
    anomalies.push({ champ: 'tva', type: 'INVALIDE', valeur: tva });
  }

  // 4. Email
  const email = find('email', 'mail', 'courriel', 'e-mail');
  if (email && !isValidEmail(email)) {
    anomalies.push({ champ: 'email', type: 'INVALIDE', valeur: email });
  }

  // 5. IBAN
  const iban = clean(find('iban', 'bban', 'compte'));
  if (iban && !isValidIBAN(iban)) {
    anomalies.push({ champ: 'iban', type: 'INVALIDE', valeur: iban });
  }

  // 6. Adresse
  const adresse = find('adresse', 'address', 'rue', 'voie');
  if (!adresse) {
    anomalies.push({ champ: 'adresse', type: 'MANQUANT', valeur: null });
  }

  // 7. Code postal
  const cp = find('code_postal', 'codepostal', 'cp', 'postal', 'zip');
  if (cp && !/^\d{5}$/.test(clean(cp))) {
    anomalies.push({ champ: 'code_postal', type: 'INVALIDE', valeur: cp });
  }

  return anomalies;
}

// ── Anomalies FACTURES ────────────────────────────────────
function detectAnomaliesFacture(record) {
  const anomalies = [];

  // 1. SIRET
  const siret = clean(record.siret || record.SIRET || record.Siret);
  if (!siret) {
    anomalies.push({ champ: 'siret', type: 'MANQUANT', valeur: null });
  } else if (!isValidSiret(siret)) {
    anomalies.push({ champ: 'siret', type: 'INVALIDE', valeur: siret });
  }

  // 2. TVA
  const tva = clean(record.tva || record.TVA || record.numero_tva);
  if (!tva) {
    anomalies.push({ champ: 'tva', type: 'MANQUANT', valeur: null });
  } else if (!isValidTVA(tva)) {
    anomalies.push({ champ: 'tva', type: 'INVALIDE', valeur: tva });
  }

  // 3. Montant HT
  const montantHT = parseFloat(record.montant_ht || record.montantHT || 0);
  if (isNaN(montantHT) || montantHT <= 0) {
    anomalies.push({ champ: 'montant_ht', type: 'INVALIDE', valeur: record.montant_ht });
  }

  // 4. Montant TTC
  const montantTTC = parseFloat(record.montant_ttc || record.montantTTC || 0);
  if (isNaN(montantTTC) || montantTTC <= 0) {
    anomalies.push({ champ: 'montant_ttc', type: 'INVALIDE', valeur: record.montant_ttc });
  }

  // 5. Cohérence HT/TTC
  if (montantHT > 0 && montantTTC > 0 && montantTTC < montantHT) {
    anomalies.push({ champ: 'montants', type: 'INCOHERENT', valeur: `TTC (${montantTTC}) < HT (${montantHT})` });
  }

  // 6. Date
  const date = record.date || record.date_facture || record.invoiceDate;
  if (!date) {
    anomalies.push({ champ: 'date_facture', type: 'MANQUANT', valeur: null });
  } else if (!isValidDate(date)) {
    anomalies.push({ champ: 'date_facture', type: 'INVALIDE', valeur: date });
  }

  // 7. Raison sociale
  const rs = record.raison_sociale || record.raisonSociale || record.company_name;
  if (!rs || String(rs).trim() === '') {
    anomalies.push({ champ: 'raison_sociale', type: 'MANQUANT', valeur: null });
  }

  return anomalies;
}

// ── Helpers ───────────────────────────────────────────────
function clean(val) {
  return val ? String(val).replace(/[\s.]/g, '').trim() : null;
}

function isValidSiret(siret) {
  if (!siret) return false;
  // Accepter SIREN (9 chiffres) ou SIRET (14 chiffres)
  if (!/^\d{9}$/.test(siret) && !/^\d{14}$/.test(siret)) return false;
  if (siret.length === 9) return true; // SIREN valide si 9 chiffres
  // Luhn pour SIRET 14
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    let digit = parseInt(siret[i]);
    if (i % 2 === 0) { digit *= 2; if (digit > 9) digit -= 9; }
    sum += digit;
  }
  return sum % 10 === 0;
}

function isValidTVA(tva) {
  if (!tva) return false;
  return /^FR[A-Z0-9]{2}\d{9}$/i.test(tva.replace(/\s/g, ''));
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidIBAN(iban) {
  return /^[A-Z]{2}\d{2}[A-Z0-9]{4,30}$/i.test(iban.replace(/\s/g, ''));
}

function isValidDate(date) {
  const d = new Date(date);
  return !isNaN(d.getTime());
}

module.exports = { detectAnomalies };
