// modules/rectification/sireneEnricher.js
const https = require('https');

async function getInseeToken() {
  const key    = process.env.INSEE_CONSUMER_KEY;
  const secret = process.env.INSEE_CONSUMER_SECRET;

  if (!key || !secret) {
    throw new Error('Cles INSEE non configurees (INSEE_CONSUMER_KEY / INSEE_CONSUMER_SECRET)');
  }

  const credentials = Buffer.from(`${key}:${secret}`).toString('base64');

  return new Promise((resolve, reject) => {
    const body = 'grant_type=client_credentials';
    const options = {
      hostname: 'portail-api.insee.fr',
      path:     '/token',
      method:   'POST',
      headers: {
        Authorization:   `Basic ${credentials}`,
        'Content-Type':  'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const json = JSON.parse(data);
            resolve(json.access_token);
          } catch(e) {
            reject(new Error('INSEE token: reponse non-JSON — ' + data.slice(0, 100)));
          }
        } else {
          reject(new Error('INSEE token erreur ' + res.statusCode + ': ' + data.slice(0, 200)));
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
  // Si pas de cles INSEE, passer sans enrichissement
  let token = null;
  try {
    token = await getInseeToken();
  } catch(err) {
    console.warn('[INSEE] Enrichissement desactive:', err.message);
    return analyzedRecords.map(r => ({ ...r, donnees_insee: null }));
  }

  const enriched = await Promise.all(
    analyzedRecords.map(async (record) => {
      const siret = clean(
        record.donnees_originales?.siret ||
        record.donnees_originales?.SIRET ||
        record.donnees_originales?.Siret ||
        record.donnees_originales?.siren ||
        record.donnees_originales?.SIREN
      );

      // Pas de SIRET valide ou anomalie bloquante — skip
      const siretAnomalie = (record.anomalies || []).find(
        (a) => a.champ === 'siret' && a.type === 'INVALIDE'
      );
      if (!siret || siret.length < 9 || siretAnomalie) {
        return { ...record, donnees_insee: null };
      }

      try {
        const insee = await fetchSirene(siret, token);
        return {
          ...record,
          donnees_insee: insee,
          anomalies: reconcileAnomalies(record.anomalies || [], insee),
        };
      } catch (err) {
        // Erreur INSEE non bloquante — on continue sans enrichissement
        console.warn('[INSEE] Erreur pour SIRET', siret, ':', err.message);
        return { ...record, donnees_insee: null };
      }
    })
  );

  return enriched;
}

async function fetchSirene(siret, token) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.insee.fr',
      path:     `/entreprises/sirene/V3.11/siret/${siret}`,
      method:   'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept:        'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        // Verifier que la reponse est du JSON
        const contentType = res.headers['content-type'] || '';
        if (!contentType.includes('json') && res.statusCode !== 200) {
          return reject(new Error('INSEE reponse non-JSON (status ' + res.statusCode + ')'));
        }

        if (res.statusCode === 200) {
          try {
            const json = JSON.parse(data);
            const etab = json.etablissement;
            if (!etab) return reject(new Error('Structure INSEE inattendue'));
            const ul = etab.uniteLegale || {};

            resolve({
              siret:         etab.siret,
              siren:         etab.siren,
              raison_sociale: ul.denominationUniteLegale ||
                (`${ul.prenomUsuelUniteLegale || ''} ${ul.nomUniteLegale || ''}`).trim(),
              adresse:       buildAdresse(etab.adresseEtablissement),
              code_naf:      ul.activitePrincipaleUniteLegale,
              statut:        ul.etatAdministratifUniteLegale,
              date_creation: ul.dateCreationUniteLegale,
            });
          } catch(e) {
            reject(new Error('INSEE parse erreur: ' + e.message));
          }
        } else if (res.statusCode === 404) {
          reject(new Error('SIRET ' + siret + ' introuvable dans SIRENE'));
        } else if (res.statusCode === 401) {
          reject(new Error('INSEE token invalide ou expire'));
        } else if (res.statusCode === 403) {
          reject(new Error('INSEE acces refuse (quota ou droits)'));
        } else {
          reject(new Error('INSEE API erreur ' + res.statusCode));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('INSEE timeout')); });
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
  if (insee?.raison_sociale) {
    return anomalies.filter(a => !(a.champ === 'raison_sociale' && a.type === 'MANQUANT'));
  }
  return anomalies;
}

function clean(val) {
  return val ? String(val).replace(/[\s.]/g, '').trim() : null;
}

module.exports = { enrichWithSirene };
