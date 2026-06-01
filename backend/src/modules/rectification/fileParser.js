// modules/rectification/fileParser.js
const csv    = require('csv-parse/sync');
const xml2js = require('xml2js');
const XLSX   = require('xlsx');

/**
 * Parse un fichier et retourne un tableau d'objets normalises
 */
async function parseFile(fileBuffer, mimeType) {
  const ext = detectExt(mimeType);

  switch (ext) {
    case 'xlsx':
      return parseXLSX(fileBuffer);
    case 'csv':
      return parseCSV(fileBuffer);
    case 'xml':
      return await parseXML(fileBuffer.toString('utf-8'));
    case 'json':
      return parseJSON(fileBuffer.toString('utf-8'));
    default:
      // Tentative CSV en dernier recours
      try { return parseCSV(fileBuffer); }
      catch(e) { throw new Error('Format non supporte : ' + mimeType); }
  }
}

function detectExt(mimeType) {
  if (!mimeType) return 'csv';
  const m = mimeType.toLowerCase();
  if (m.includes('sheet') || m.includes('excel') || m.includes('xlsx') || m.includes('xls')) return 'xlsx';
  if (m.includes('xml')) return 'xml';
  if (m.includes('json')) return 'json';
  return 'csv';
}

// ── XLSX ──────────────────────────────────────────────────
function parseXLSX(fileBuffer) {
  const workbook  = XLSX.read(fileBuffer, { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const sheet     = workbook.Sheets[sheetName];
  const rows      = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  return rows.map(row => {
    const normalized = {};
    Object.keys(row).forEach(k => {
      normalized[k.trim()] = String(row[k] ?? '').trim();
    });
    return normalized;
  });
}

// ── CSV robuste ───────────────────────────────────────────
function parseCSV(fileBuffer) {
  let content = fileBuffer.toString('utf-8');

  // Supprimer BOM
  if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);

  // Detecter separateur
  const firstLine = content.split('\n')[0] || '';
  const sep = firstLine.split(';').length > firstLine.split(',').length ? ';' : ',';

  // Essai 1 : parser strict
  try {
    return csv.parse(content, {
      columns:          true,
      skip_empty_lines: true,
      trim:             true,
      bom:              true,
      delimiter:        sep,
      relax_quotes:     true,
      relax_column_count: true,
    });
  } catch(e1) {
    // Essai 2 : parser sans gestion des guillemets
    try {
      return csv.parse(content, {
        columns:          true,
        skip_empty_lines: true,
        trim:             true,
        bom:              true,
        delimiter:        sep,
        quote:            false,
        relax_column_count: true,
      });
    } catch(e2) {
      // Essai 3 : parser manuel ligne par ligne
      return parseCSVManual(content, sep);
    }
  }
}

function parseCSVManual(content, sep) {
  const lines   = content.split('\n').filter(l => l.trim());
  if (lines.length < 2) throw new Error('Fichier CSV vide ou invalide');

  const headers = lines[0].split(sep).map(h => h.trim().replace(/^["']|["']$/g, ''));

  return lines.slice(1).map(line => {
    const cols = line.split(sep).map(c => c.trim().replace(/^["']|["']$/g, ''));
    const obj  = {};
    headers.forEach((h, i) => { obj[h] = cols[i] ?? ''; });
    return obj;
  });
}

// ── XML ───────────────────────────────────────────────────
async function parseXML(content) {
  const parser = new xml2js.Parser({
    explicitArray: false,
    mergeAttrs:    true,
    trim:          true,
  });
  const result   = await parser.parseStringPromise(content);
  const rootKey  = Object.keys(result)[0];
  const root     = result[rootKey];
  const childKey = Object.keys(root)[0];
  const items    = root[childKey];
  return Array.isArray(items) ? items : [items];
}

// ── JSON ──────────────────────────────────────────────────
function parseJSON(content) {
  const data = JSON.parse(content);
  return Array.isArray(data) ? data : [data];
}

module.exports = { parseFile };
