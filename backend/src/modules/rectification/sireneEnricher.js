const https = require('https');

/**
 * Génère un token Bearer OAuth2 INSEE
 */
async function getInseeToken() {
  const key = process.env.INSEE_CONSUMER_KEY;
  const secret = process.env.INSEE_CONSUMER_SECRET;
  const credentials = Buffer.from(`${key}:${secret}`).toString('base64');

  return new Promise((resolve, reject) => {
    const body = 'grant_type=client_credentials';
    const options = {
      hostname: 'portail-api.insee.fr',
      path: '/token',
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode === 200) {
          const json = JSON.parse(data);
          resolve(json.access_token);
        } else {
          reject(new Error(`INSEE token erreur ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Enrichit les données avec l'API INSEE SIRENE
 */
async function enrichWithSirene(analyzedRecords) {
  const token = await getInseeToken();

  const enriched = await Promise.all(
    analyzedRecords.map(async (record) => {
      const siret = clean(
        record.donnees_originales.siret ||
        record.donnees_originales.SIRET ||
        record.donnees_originales.Siret
      );

      const siretAnomalie = record.anomalies.find(
        (a) => a.champ === 'siret' && a.type === 'INVALIDE'
      );
      if (!siret || siretAnomalie) {
        return { ...record, donnees_insee: null };
      }

      try {
        const insee = await fetchSirene(siret, token);
        return {
          ...record,
          donnees_insee: insee,
          anomalies: reconcileAnomalies(record.anomalies, insee),
        };
      } catch (err) {
        return {
          ...record,
          donnees_insee: null,
          erreur_insee: err.message,
        };
      }
    })
  );

  return enriched;
}

async function fetchSirene(siret, token) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.insee.fr',
      path: `/entreprises/sirene/V3.11/siret/${siret}`,
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode === 200) {
          const json = JSON.parse(data);
          const etablissement = json.etablissement;
          const uniteLegale = etablissement.uniteLegale;

          resolve({
            siret: etablissement.siret,
            siren: etablissement.siren,
            raison_sociale:
              uniteLegale.denominationUniteLegale ||
              `${uniteLegale.prenomUsuelUniteLegale || ''} ${uniteLegale.nomUniteLegale || ''}`.trim(),
            adresse: buildAdresse(etablissement.adresseEtablissement),
            code_naf: uniteLegale.activitePrincipaleUniteLegale,
            statut: uniteLegale.etatAdministratifUniteLegale,
            date_creation: uniteLegale.dateCreationUniteLegale,
          });
        } else if (res.statusCode === 404) {
          reject(new Error(`SIRET ${siret} introuvable dans SIRENE`));
        } else {
          reject(new Error(`INSEE API erreur ${res.statusCode}`));
        }
      });
    });

    req.on('error', reject);
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
  ]
    .filter(Boolean)
    .join(' ');
}

function reconcileAnomalies(anomalies, insee) {
  if (insee?.raison_sociale) {
    return anomalies.filter(
      (a) => !(a.champ === 'raison_sociale' && a.type === 'MANQUANT')
    );
  }
  return anomalies;
}

function clean(val) {
  return val ? String(val).replace(/\s/g, '').trim() : null;
}

module.exports = { enrichWithSirene };
