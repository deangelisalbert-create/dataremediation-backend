const https = require('https');

/**
 * Valide les numéros de TVA via l'API VIES EU
 * @param {Array} enrichedRecords - tableau issu du sireneEnricher
 * @returns {Promise<Array>} tableau avec validation TVA
 */
async function validateWithVies(enrichedRecords) {
  const validated = await Promise.all(
    enrichedRecords.map(async (record) => {
      const tva = clean(
        record.donnees_originales.tva ||
        record.donnees_originales.TVA ||
        record.donnees_originales.numero_tva ||
        record.donnees_originales.vatNumber
      );

      if (!tva) {
        return { ...record, donnees_vies: null };
      }

      // Sépare le code pays (2 lettres) du numéro
      const countryCode = tva.substring(0, 2).toUpperCase();
      const vatNumber = tva.substring(2);

      try {
        const vies = await checkVies(countryCode, vatNumber);
        return {
          ...record,
          donnees_vies: vies,
          anomalies: reconcileAnomalies(record.anomalies, vies, tva),
        };
      } catch (err) {
        return {
          ...record,
          donnees_vies: null,
          erreur_vies: err.message,
        };
      }
    })
  );

  return validated;
}

async function checkVies(countryCode, vatNumber) {
  const soapBody = `
    <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
      xmlns:urn="urn:ec.europa.eu:taxud:vies:services:checkVat:types">
      <soapenv:Body>
        <urn:checkVat>
          <urn:countryCode>${countryCode}</urn:countryCode>
          <urn:vatNumber>${vatNumber}</urn:vatNumber>
        </urn:checkVat>
      </soapenv:Body>
    </soapenv:Envelope>
  `.trim();

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'ec.europa.eu',
      path: '/taxation_customs/vies/services/checkVatService',
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml;charset=UTF-8',
        'Content-Length': Buffer.byteLength(soapBody),
        SOAPAction: '',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(parseViesResponse(data, countryCode, vatNumber));
        } else {
          reject(new Error(`VIES API erreur ${res.statusCode}`));
        }
      });
    });

    req.on('error', reject);
    req.write(soapBody);
    req.end();
  });
}

function parseViesResponse(xml, countryCode, vatNumber) {
  const valid = xml.includes('<valid>true</valid>');
  const nameMatch = xml.match(/<name>(.*?)<\/name>/);
  const addressMatch = xml.match(/<address>(.*?)<\/address>/s);

  return {
    tva: `${countryCode}${vatNumber}`,
    valide: valid,
    raison_sociale: nameMatch ? nameMatch[1].trim() : null,
    adresse: addressMatch ? addressMatch[1].trim() : null,
  };
}

function reconcileAnomalies(anomalies, vies, tva) {
  if (!vies) return anomalies;

  if (vies.valide) {
    // TVA valide → retire l'anomalie TVA INVALIDE si présente
    return anomalies.filter(
      (a) => !(a.champ === 'tva' && a.type === 'INVALIDE')
    );
  } else {
    // TVA invalide selon VIES → ajoute anomalie si pas déjà présente
    const dejaPresente = anomalies.find(
      (a) => a.champ === 'tva' && a.type === 'INVALIDE_VIES'
    );
    if (!dejaPresente) {
      return [
        ...anomalies,
        { champ: 'tva', type: 'INVALIDE_VIES', valeur: tva },
      ];
    }
  }
  return anomalies;
}

function clean(val) {
  return val ? String(val).replace(/\s/g, '').trim() : null;
}

module.exports = { validateWithVies };
