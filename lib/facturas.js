// Utilidades del modulo Facturas IVA: escanea una carpeta de Google Drive,
// analiza cada comprobante nuevo con Gemini (vision) y arma las filas para
// la hoja 'Facturas IVA'.

const SHEET_FACTURAS = 'Facturas IVA';
const HEADER_FACTURAS = [
  'DriveFileId', 'DriveFileName', 'Fecha', 'Proveedor', 'CUIT', 'TipoFactura',
  'NumeroFactura', 'Neto', 'IVA', 'ImpInterno', 'IDC', 'Total', 'Moneda', 'Detalle', 'FechaCarga',
];

// Cuantos comprobantes nuevos procesamos como maximo por click en "Validar"
// (limite de tiempo de la funcion serverless, ver vercel.json maxDuration).
const MAX_POR_LOTE = 8;

function esArchivoSoportado(mimeType) {
  return /^image\//.test(mimeType || '') || mimeType === 'application/pdf';
}

async function safeGet(sheets, spreadsheetId, range) {
  try {
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range });
    return resp.data.values || [];
  } catch (e) {
    if (String(e.message || '').indexOf('Unable to parse range') >= 0) return []; // la hoja todavia no existe
    throw e;
  }
}

async function leerFacturas(sheets, SHEET_ID) {
  const data = await safeGet(sheets, SHEET_ID, `'${SHEET_FACTURAS}'!A2:O20000`);
  return data
    .filter(r => r[0])
    .map((r, i) => ({
      fila:          i + 2,
      driveFileId:   (r[0] || '').trim(),
      driveFileName: (r[1] || '').trim(),
      fecha:         (r[2] || '').trim(),
      proveedor:     (r[3] || '').trim(),
      cuit:          (r[4] || '').trim(),
      tipoFactura:   (r[5] || '').trim(),
      numeroFactura: (r[6] || '').trim(),
      neto:          parseFloat(r[7]) || 0,
      iva:           parseFloat(r[8]) || 0,
      impInterno:    parseFloat(r[9]) || 0,
      idc:           parseFloat(r[10]) || 0,
      total:         parseFloat(r[11]) || 0,
      moneda:        (r[12] || 'ARS').trim(),
      detalle:       (r[13] || '').trim(),
      fechaCarga:    (r[14] || '').trim(),
    }));
}

const MIME_CARPETA = 'application/vnd.google-apps.folder';

// Lista todos los archivos (imagenes/PDF) dentro de la carpeta de Drive,
// recorriendo tambien subcarpetas (el usuario organiza los comprobantes en
// una subcarpeta por mes, ej. 'Tickets/042026/'), ordenados del mas viejo
// al mas nuevo (asi procesamos en orden cronologico).
async function listarArchivosDrive(drive, folderId) {
  const archivos = [];
  const carpetasPendientes = [folderId];
  while (carpetasPendientes.length > 0) {
    const actual = carpetasPendientes.shift();
    let pageToken;
    do {
      const resp = await drive.files.list({
        q: `'${actual}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType, modifiedTime)',
        pageSize: 200,
        pageToken,
      });
      (resp.data.files || []).forEach(f => {
        if (f.mimeType === MIME_CARPETA) carpetasPendientes.push(f.id);
        else if (esArchivoSoportado(f.mimeType)) archivos.push(f);
      });
      pageToken = resp.data.nextPageToken;
    } while (pageToken);
  }
  archivos.sort((a, b) => (a.modifiedTime < b.modifiedTime ? -1 : a.modifiedTime > b.modifiedTime ? 1 : 0));
  return archivos;
}

async function descargarArchivoBase64(drive, fileId) {
  const resp = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
  return Buffer.from(resp.data).toString('base64');
}

const GEMINI_SCHEMA = {
  type: 'OBJECT',
  properties: {
    fecha:         { type: 'STRING', description: 'Campo "Fecha" (fecha de emision) de la factura, formato dd/mm/aaaa. Vacio si no es legible.' },
    proveedor:     { type: 'STRING', description: 'Campo "Razon Social" — nombre de la empresa que emite el comprobante.' },
    cuit:          { type: 'STRING', description: 'Campo "CUIT" del emisor, formato NN-NNNNNNNN-N si es legible.' },
    tipoFactura:   { type: 'STRING', description: 'Letra del comprobante (A, B, C, M, E) si figura impresa, o vacio.' },
    numeroFactura: { type: 'STRING', description: 'Campo "Comprobante Nº" — numero de comprobante completo, ej 0001-00012345.' },
    neto:          { type: 'NUMBER', description: 'Campo "Subt. Neto Gravado $" (numero, sin separador de miles).' },
    iva:           { type: 'NUMBER', description: 'Campo "IVA $".' },
    impInterno:    { type: 'NUMBER', description: 'Campo "Imp. Interno $" (impuestos internos). 0 si no figura en el comprobante.' },
    idc:           { type: 'NUMBER', description: 'Campo "IDC $" (impuesto al dioxido de carbono, comun en facturas de combustible). 0 si no figura.' },
    total:         { type: 'NUMBER', description: 'Campo "TOTAL $".' },
    moneda:        { type: 'STRING', description: 'ARS o USD segun corresponda. Por defecto ARS.' },
    detalle:       { type: 'STRING', description: 'Descripcion breve (una linea) de los conceptos o items facturados.' },
  },
  required: ['fecha', 'proveedor', 'total'],
};

const GEMINI_PROMPT = 'Analiza esta imagen o PDF de una factura o comprobante fiscal argentino y extrae los campos ' +
  'pedidos, buscando literalmente las etiquetas impresas: Razon Social, CUIT, Fecha, Comprobante Nº, Subt. Neto ' +
  'Gravado $, IVA $, Imp. Interno $, IDC $, TOTAL $. Responde unicamente con el JSON pedido, sin texto adicional. ' +
  'Si un campo no es legible o no figura en el comprobante, dejalo vacio (string vacio o 0 segun el tipo), pero ' +
  'nunca inventes valores.';

async function analizarFacturaConGemini(base64Data, mimeType) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ parts: [{ text: GEMINI_PROMPT }, { inlineData: { mimeType, data: base64Data } }] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: GEMINI_SCHEMA },
  };
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await resp.json();
  if (!resp.ok) throw new Error((data.error && data.error.message) || 'Error de Gemini API');
  const texto = data.candidates && data.candidates[0] && data.candidates[0].content &&
                data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
                data.candidates[0].content.parts[0].text;
  if (!texto) throw new Error('Gemini no devolvio contenido (posible bloqueo de seguridad o comprobante ilegible)');
  return JSON.parse(texto);
}

// Clave de dedup: el propio ID de archivo de Drive (un comprobante = un archivo = una fila).
function claveDuplicadoFactura(row) {
  return row.driveFileId;
}

// Actualiza los campos editables de una factura ya guardada (busca la fila
// por driveFileId, nunca toca DriveFileId/DriveFileName/FechaCarga).
async function actualizarFactura(sheets, SHEET_ID, factura) {
  const existentes = await leerFacturas(sheets, SHEET_ID);
  const row = existentes.find(r => r.driveFileId === factura.driveFileId);
  if (!row) return false;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `'${SHEET_FACTURAS}'!C${row.fila}:N${row.fila}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[
      factura.fecha || '', factura.proveedor || '', factura.cuit || '', factura.tipoFactura || '',
      factura.numeroFactura || '', factura.neto || 0, factura.iva || 0, factura.impInterno || 0,
      factura.idc || 0, factura.total || 0, factura.moneda || 'ARS', factura.detalle || '',
    ]] },
  });
  return true;
}

module.exports = {
  SHEET_FACTURAS, HEADER_FACTURAS, MAX_POR_LOTE,
  esArchivoSoportado, leerFacturas, listarArchivosDrive, descargarArchivoBase64,
  analizarFacturaConGemini, claveDuplicadoFactura, actualizarFactura,
};
