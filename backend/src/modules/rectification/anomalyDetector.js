// modules/rectification/anomalyDetector.js
// Calibre sur le format Pennylane fournisseurs + detection auto autres formats

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

function detectFileType(firstRecord) {
  const keys = Object.keys(firstRecord).map(k => k.toLowerCase().replace(/[^a-z]/g,''));
  const sf = ['denomination','siren','siret','fournisseur','iban','tva','numerotva'].filter(s => keys.some(k => k.includes(s))).length;
  const sc = ['montantht','montantttc','datefacture','numerofacture','invoice','debit','credit'].filter(s => keys.some(k => k.includes(s))).length;
  return sf >= sc ? 'fournisseurs' : 'factures';
}

function findVal(record, ...keywords) {
  const keys = Object.keys(record);
  for (const kw of keywords) {
    const kwClean = kw.toLowerCase().replace(/[^a-z]/g,'');
    const key = keys.find(k => k.toLowerCase().replace(/[^a-z]/g,'').includes(kwClean));
    if (key !== undefined) {
      const val = record[key];
      if (val !== undefined && val !== null) {
        const str = String(val).trim().replace(/^"|"$/g,'').trim();
        if (str !== '' && str !== '""') return str;
      }
    }
  }
  return null;
}

function clean(val) {
  if (!val) return null;
  return String(val).replace(/[\s.]/g,'').trim();
}

function detectAnomaliesFournisseur(record) {
  const anomalies = [];

  // 1. Denomination obligatoire
  const nom = findVal(record, 'Denomination', 'denomination', 'raison_sociale', 'nom');
  if (!nom) {
    anomalies.push({ champ: 'denomination', type: 'MANQUANT', valeur: null });
  }

  // 2. SIREN/SIRET — seulement si texte non numerique (categorie de depenses)
  const siren = clean(findVal(record, 'Siren', 'siren', 'SIREN'));
  const siret = clean(findVal(record, 'SIRET', 'Siret', 'siret'));
  const identifiant = siret || siren;

  if (!identifiant) {
    anomalies.push({ champ: 'siret', type: 'MANQUANT', valeur: null });
  } else if (/[a-zA-Z_]/.test(identifiant)) {
    // Texte non numerique = categorie de depenses ou donnee invalide
    anomalies.push({ champ: 'siret', type: 'INVALIDE', valeur: identifiant });
  }
  // Si c'est un nombre partiel, on ne penalise pas

  // 3. TVA — seulement si presente et invalide (pas obligatoire)
  const tva = clean(findVal(record, 'Numero de TVA', 'numerotva', 'TVA', 'tva', 'vat'));
  if (tva && !/^exempt$/i.test(tva) && !isValidTVA(tva)) {
    anomalies.push({ champ: 'tva', type: 'INVALIDE', valeur: tva });
  }

  // 4. Email — seulement si present et invalide
  const email = findVal(record, "Liste d'e-mails", 'email', 'mail', 'emails');
  if (email && !isValidEmail(email)) {
    anomalies.push({ champ: 'email', type: 'INVALIDE', valeur: email });
  }

  // 5. IBAN — seulement si present et invalide
  const iban = clean(findVal(record, 'IBAN', 'iban'));
  if (iban && !isValidIBAN(iban)) {
    anomalies.push({ champ: 'iban', type: 'INVALIDE', valeur: iban });
  }

  return anomalies;
}

function detectAnomaliesFacture(record) {
  const anomalies = [];
  const siret = clean(record.siret || record.SIRET || record.Siret || record.siren || record.Siren);
  if (!siret) {
    anomalies.push({ champ: 'siret', type: 'MANQUANT', valeur: null });
  } else if (!/^\d{9,14}$/.test(siret)) {
    anomalies.push({ champ: 'siret', type: 'INVALIDE', valeur: siret });
  }
  const tva = clean(record.tva || record.TVA || record['Numero de TVA']);
  if (tva && !isValidTVA(tva) && !/^exempt$/i.test(tva)) {
    anomalies.push({ champ: 'tva', type: 'INVALIDE', valeur: tva });
  }
  return anomalies;
}

function isValidSiret(siret) {
  if (!siret || !/^\d{14}$/.test(siret)) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    let d = parseInt(siret[i]);
    if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

function isValidTVA(tva) {
  return /^FR[A-Z0-9]{2}\d{9}$/i.test(tva.replace(/\s/g,''));
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidIBAN(iban) {
  return /^[A-Z]{2}\d{2}[A-Z0-9]{4,30}$/i.test(iban.replace(/\s/g,''));
}

module.exports = { detectAnomalies };
