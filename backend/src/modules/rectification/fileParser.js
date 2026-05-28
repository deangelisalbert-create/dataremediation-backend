const csv = require('csv-parse/sync');
const xml2js = require('xml2js');

/**
 * Parse un fichier et retourne un tableau d'objets normalisés
 * @param {Buffer} fileBuffer - contenu du fichier
 * @param {string} mimeType - 'text/csv' | 'application/xml' | 'application/json'
 * @returns {Promise<Array>} tableau d'objets
 */
async function parseFile(fileBuffer, mimeType) {
  const content = fileBuffer.toString('utf-8');

  switch (mimeType) {
    case 'text/csv':
    case 'application/csv':
      return parseCSV(content);

    case 'application/xml':
    case 'text/xml':
      return await parseXML(content);

    case 'application/json':
      return parseJSON(content);

    default:
      throw new Error(`Format non supporté : ${mimeType}`);
  }
}

function parseCSV(content) {
  const records = csv.parse(content, {
    columns: true,         // première ligne = headers
    skip_empty_lines: true,
    trim: true,
    bom: true,             // gère le BOM UTF-8
  });
  return records;
}

async function parseXML(content) {
  const parser = new xml2js.Parser({
    explicitArray: false,  // évite les tableaux inutiles
    mergeAttrs: true,
    trim: true,
  });
  const result = await parser.parseStringPromise(content);

  // On cherche le premier tableau d'éléments dans la structure XML
  const rootKey = Object.keys(result)[0];
  const root = result[rootKey];
  const childKey = Object.keys(root)[0];
  const items = root[childKey];

  return Array.isArray(items) ? items : [items];
}

function parseJSON(content) {
  const data = JSON.parse(content);
  return Array.isArray(data) ? data : [data];
}

module.exports = { parseFile };
