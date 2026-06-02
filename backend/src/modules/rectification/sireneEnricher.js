// modules/rectification/sireneEnricher.js
const https = require('https');

async function getInseeToken() {
  const key    = process.env.INSEE_CONSUMER_KEY;
  const secret = process.env.INSEE_CONSUMER_SECRET;
  if (!key || !secret) throw new Error('Cles INSEE non configurees');
  const credentials = Buffer.from(`${key}:${secret}`).toString('base64');
  return new Promise((resolve, reject) => {
    const body = 'grant_type=client_credentials';
    const options = {
      hostname: 'portail-api.insee.fr',
      path:     '/token',
      method:   'POST',
      headers: {
        Authorization:    `Basic ${credentials}`,
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(data).access_token); }
          catch(e) { reject(new Error('INSEE token: reponse non-JSON')); }
        } else {
          reject(new Error('INSEE token erreur ' + res.statusCode));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('INSEE token timeout')); });
    req.write(body);
    req.end();
  });
}

async function enrichWithSirene(analyzedRecords) {
  let token = null;
  try {
    token = await getInseeToken();
    console.log('[INSEE] Token obtenu');
  } catch(err) {
    console.warn('[INSEE] Enrichissement desactive:', err.message);
    return analyzedRecords.map(r => ({ ...r, donnees_insee: null }));
  }

  const enriched = [];
  for (const record of analyzedRecords) {
    enriched.push(await enrichRecord(record, token));
  }
  return enriched;
}

async function enrichRecord(record, token) {
  // Recuperer SIREN ou SIRET depuis les donnees originales
  const raw = record.donnees_originales;

  // Chercher dans toutes les colonnes possibles
  const siretRaw = findVal(raw, 'SIRET', 'Siret', 'siret');
  const sirenRaw = findVal(raw, 'Siren', 'siren', 'SIREN');

  const siret = clean(siretRaw);
  const siren = clean(sirenRaw);

  // Determiner l'identifiant a utiliser
  let identifiant = null;
  let typeid = null;

  if (siret && /^\d{14}$/.test(siret)) {
    identifiant = siret;
    typeid = 'siret';
  } else if (siren && /^\d{9}$/.test(siren)) {
    identifiant = siren;
    typeid = 'siren';
  } else if (siret && /^\d{9}$/.test(siret)) {
    // SIRET colonne contient en fait un SIREN 9 chiffres
    identifiant = siret;
    typeid = 'siren';
  }

  if (!identifiant) {
    return { ...record, donnees_insee: null };
  }

  try {
    const insee = typeid === 'siren'
      ? await fetchBySiren(identifiant, token)
      : await fetchBySiret(identifiant, token);

    if (!insee) return { ...record, donnees_insee: null };

    console.log('[INSEE] Trouve:', identifiant, '->', insee.siret, insee.raison_sociale);

    // Injecter le SIRET complet dans les donnees originales corrigees
    const donneesCorrigees = { ...record.donnees_originales };
    if (insee.siret) {
      // Mettre a jour la colonne SIRET avec le SIRET complet
      const siretKey = Object.keys(donneesCorrigees).find(k => k.toUpperCase() === 'SIRET') || 'SIRET';
      donneesCorrigees[siretKey] = insee.siret;
    }

    return {
      ...record,
      donnees_originales: donneesCorrigees,
      donnees_insee: insee,
      anomalies: reconcileAnomalies(record.anomalies || [], insee),
      // Marquer la correction SIRET comme effectuee
      correction_siret: insee.siret !== siret ? {
        champ:           'siret',
        valeur_originale: identifiant,
        valeur_corrigee:  insee.siret,
        confiance:        0.98,
        justification:    'SIRET complet retrouve via API INSEE a partir du SIREN ' + identifiant,
      } : null,
    };
  } catch(err) {
    console.warn('[INSEE] Erreur pour', identifiant, ':', err.message);
    return { ...record, donnees_insee: null };
  }
}

// ── Recherche par SIREN → retourne le siege social ────────
async function fetchBySiren(siren, token) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.insee.fr',
      path:     `/entreprises/sirene/V3.11/siren/${siren}`,
      method:   'GET',
      headers:  { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const json   = JSON.parse(data);
            const ul     = json.uniteLegale;
            if (!ul) return resolve(null);

            // Prendre le siege social (periodeUniteLegale la plus recente)
            const siret = ul.siren + (ul.nicSiegeUniteLegale || '00001');
            const periode = Array.isArray(ul.periodesUniteLegale)
              ? ul.periodesUniteLegale[0]
              : ul.periodesUniteLegale || {};

            resolve({
              siret:          siret,
              siren:          ul.siren,
              raison_sociale: periode.denominationUniteLegale ||
                              `${periode.prenomUsuelUniteLegale || ''} ${periode.nomUniteLegale || ''}`.trim(),
              code_naf:       periode.activitePrincipaleUniteLegale,
              statut:         periode.etatAdministratifUniteLegale,
              date_creation:  ul.dateCreationUniteLegale,
              adresse:        null,
            });
          } catch(e) {
            reject(new Error('INSEE SIREN parse erreur: ' + e.message));
          }
        } else if (res.statusCode === 404) {
          resolve(null);
        } else {
          reject(new Error('INSEE SIREN erreur ' + res.statusCode));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('INSEE SIREN timeout')); });
    req.end();
  });
}

// ── Recherche par SIRET 14 chiffres ───────────────────────
async function fetchBySiret(siret, token) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.insee.fr',
      path:     `/entreprises/sirene/V3.11/siret/${siret}`,
      method:   'GET',
      headers:  { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const json = JSON.parse(data);
            const etab = json.etablissement;
            if (!etab) return resolve(null);
            const ul = etab.uniteLegale || {};
            resolve({
              siret:          etab.siret,
              siren:          etab.siren,
              raison_sociale: ul.denominationUniteLegale ||
                              `${ul.prenomUsuelUniteLegale || ''} ${ul.nomUniteLegale || ''}`.trim(),
              adresse:        buildAdresse(etab.adresseEtablissement),
              code_naf:       ul.activitePrincipaleUniteLegale,
              statut:         ul.etatAdministratifUniteLegale,
              date_creation:  ul.dateCreationUniteLegale,
            });
          } catch(e) {
            reject(new Error('INSEE SIRET parse erreur: ' + e.message));
          }
        } else if (res.statusCode === 404) {
          resolve(null);
        } else {
          reject(new Error('INSEE SIRET erreur ' + res.statusCode));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('INSEE SIRET timeout')); });
    req.end();
  });
}

function buildAdresse(adresse) {
  if (!adresse) return null;
  return [
    adresse.numeroVoieEtablissement,
    adresse.typeVoieEtablissement,
    adresse.libelleVoieEtablissement,
    adresse.codePostalEtablissement,
    adresse.libelleCommuneEtablissement,
  ].filter(Boolean).join(' ');
}

function reconcileAnomalies(anomalies, insee) {
  return anomalies.filter(a => {
    if (a.champ === 'siret' && insee?.siret) return false;
    if (a.champ === 'denomination' && insee?.raison_sociale) return false;
    return true;
  });
}

function findVal(record, ...keys) {
  for (const k of keys) {
    const found = Object.keys(record).find(r => r.toLowerCase().replace(/[^a-z]/g,'') === k.toLowerCase().replace(/[^a-z]/g,''));
    if (found && record[found] !== undefined && record[found] !== null) {
      const val = String(record[found]).trim().replace(/^"|"$/g,'').trim();
      if (val !== '' && val !== '""') return val;
    }
  }
  return null;
}

function clean(val) {
  return val ? String(val).replace(/[\s.]/g,'').trim() : null;
}

module.exports = { enrichWithSirene };
