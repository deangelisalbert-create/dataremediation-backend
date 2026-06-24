// modules/rectification/anomalyDetector.js
// Calibre sur le format Pennylane fournisseurs + detection auto autres formats

// ─── LISTES DE CLASSIFICATION ────────────────────────────────────────────────

// Libellés comptables utilisés comme "fournisseur" dans les exports (jamais des vrais fournisseurs)
const CATEGORIES_DEPENSES = new Set([
  'transport', 'frais_kilometriques', 'fraiskilometriques', 'frais kilometriques',
  'peage', 'péage', 'hotel', 'hôtel', 'hotels', 'hôtels',
  'taxi', 'vtc', 'parking', 'restaurants', 'restaurant',
  'repas', 'carburant', 'essence', 'gazole', 'gasoil',
  'autre', 'autres', 'divers', 'frais generaux', 'fraisgeneraux',
  'note de frais', 'notedefrais', 'cartebancaire', 'carte bancaire',
  'abonnement', 'fournitures', 'telecom', 'telephone',
  'fournisseurs - achats de biens et pres', 'fournisseurs - achats de biens',
  'fournisseurs', 'achats de biens', 'achats',
]);

// Grandes enseignes B2C : achats ponctuels en caisse, pas concernés e-invoicing
const ENSEIGNES_PONCTUELLES = new Set([
  // BTP / bricolage
  'leroy merlin', 'leroymerlin', 'castorama', 'brico depot', 'bricodepot',
  'point p', 'pointp', 'mr bricolage', 'mrbricolage', 'weldom', 'socoda',
  'chausson materiaux', 'chaussonmateriaux', 'cdl', 'plateforme du batiment',
  // Alimentaire / GMS
  'intermarche', 'intermarché', 'leclerc', 'carrefour', 'auchan', 'lidl',
  'aldi', 'super u', 'superu', 'casino', 'monoprix', 'franprix', 'cora',
  'simply market', 'netto', 'metro', 'promocash',
  // Restauration rapide / ponctuel
  'mcdonald', 'mcdo', 'burger king', 'burgerking', 'kfc', 'subway',
  'flunch', 'buffalo grill', 'buffalogrill', 'hippopotamus', 'courtepaille',
  'paul', 'boulangerie', 'boucherie', 'epicerie',
  // Carburant
  'total energies', 'totalenergies', 'total', 'bp', 'shell', 'esso',
  'leclerc carburant', 'intermarche carburant',
  // Autres grandes enseignes ponctuelles
  'amazon', 'fnac', 'darty', 'boulanger', 'ikea', 'conforama',
  'office depot', 'officedepot', 'staples',
]);

// Pattern : SIRET contient du texte non numérique = libellé comptable
function isLibelleComptable(identifiant) {
  return identifiant && /[a-zA-Z_]/.test(identifiant);
}

// Normalise un nom pour comparaison
function normalizeName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // enlève accents
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Détecte si un nom est une catégorie de dépenses comptables
function isCategorieDepense(nom, siret) {
  const n = normalizeName(nom);
  // Match exact ou contenu dans la liste
  if (CATEGORIES_DEPENSES.has(n)) return true;
  // Libellé comptable dans le champ SIRET
  if (siret && isLibelleComptable(siret)) {
    const siretNorm = normalizeName(siret);
    if (CATEGORIES_DEPENSES.has(siretNorm)) return true;
  }
  return false;
}

// Détecte si un nom est une enseigne ponctuelle B2C
function isEnseignePonctuelle(nom) {
  const n = normalizeName(nom);
  // Match exact
  if (ENSEIGNES_PONCTUELLES.has(n)) return true;
  // Match partiel (le nom commence par une enseigne connue)
  for (const e of ENSEIGNES_PONCTUELLES) {
    if (n.startsWith(e) || n.includes(e)) return true;
  }
  return false;
}

// ─── DÉTECTION PRINCIPALE ────────────────────────────────────────────────────

function detectAnomalies(records) {
  if (!records || records.length === 0) return [];
  const type = detectFileType(records[0]);
  console.log('[AnomalyDetector] Type detecte:', type);
  return records.map((record, index) => {
    const anomalies = type === 'fournisseurs'
      ? detectAnomaliesFournisseur(record)
      : detectAnomaliesFacture(record);

    // Classification enrichie
    const classification = anomalies.find(a => a.type === 'CATEGORIE_DEPENSE' || a.type === 'ENSEIGNE_PONCTUELLE');
    const statut = anomalies.length === 0
      ? 'VALIDE'
      : classification
        ? classification.type  // 'CATEGORIE_DEPENSE' ou 'ENSEIGNE_PONCTUELLE'
        : 'ANOMALIE';

    return {
      index,
      donnees_originales: record,
      anomalies,
      statut,
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
    return anomalies; // Sans nom on ne peut rien classifier
  }

  const siren = clean(findVal(record, 'Siren', 'siren', 'SIREN'));
  const siret = clean(findVal(record, 'SIRET', 'Siret', 'siret'));
  const identifiant = siret || siren;

  // 2. Détection CATEGORIE_DEPENSE (priorité max — stop ici)
  if (isCategorieDepense(nom, identifiant)) {
    anomalies.push({
      champ: 'classification',
      type: 'CATEGORIE_DEPENSE',
      valeur: nom,
      message: 'Libellé comptable détecté — exclu du score e-Invoicing',
    });
    return anomalies;
  }

  // 3. Détection ENSEIGNE_PONCTUELLE (achat caisse — pas de flux e-invoicing attendu)
  if (!identifiant && isEnseignePonctuelle(nom)) {
    anomalies.push({
      champ: 'classification',
      type: 'ENSEIGNE_PONCTUELLE',
      valeur: nom,
      message: 'Enseigne B2C ponctuelle — achat en caisse probable, pas de flux e-invoicing attendu',
    });
    return anomalies;
  }

  // 4. SIREN/SIRET — fournisseur réel
  if (!identifiant) {
    anomalies.push({ champ: 'siret', type: 'MANQUANT', valeur: null });
  } else if (isLibelleComptable(identifiant)) {
    // Libellé non reconnu dans la liste — on signale quand même
    anomalies.push({ champ: 'siret', type: 'INVALIDE', valeur: identifiant });
  }

  // 5. TVA — seulement si presente et invalide
  const tva = clean(findVal(record, 'Numero de TVA', 'numerotva', 'TVA', 'tva', 'vat'));
  if (tva && !/^exempt$/i.test(tva) && !isValidTVA(tva)) {
    anomalies.push({ champ: 'tva', type: 'INVALIDE', valeur: tva });
  }

  // 6. Email — seulement si present et invalide
  const email = findVal(record, "Liste d'e-mails", 'email', 'mail', 'emails');
  if (email && !isValidEmail(email)) {
    anomalies.push({ champ: 'email', type: 'INVALIDE', valeur: email });
  }

  // 7. IBAN — seulement si present et invalide
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

// Export des helpers pour le reportGenerator
module.exports = {
  detectAnomalies,
  isCategorieDepense,
  isEnseignePonctuelle,
  normalizeName,
};
