// Utilidades del modulo Quincho: registro de gastos de la construccion del
// quincho, organizado por etapas (Materiales, Presupuesto y Pagos por etapa).
const { Readable } = require('stream');
const { getSheetGid } = require('./sheets');

const SHEET_ETAPAS      = 'Quincho Etapas';
const SHEET_MATERIALES  = 'Quincho Materiales';
const SHEET_PRESUPUESTO = 'Quincho Presupuesto';
const SHEET_PAGOS       = 'Quincho Pagos';

const HEADER_ETAPAS      = ['ID', 'Nombre', 'Orden', 'Estado', 'Fecha', 'Detalle'];
const HEADER_MATERIALES  = [
  'EtapaID', 'Fecha', 'Proveedor', 'NumeroFactura', 'Detalle', 'Total',
  'DriveFileId', 'DriveFileName', 'Origen', 'FechaCarga', 'Cantidad',
];
const HEADER_PRESUPUESTO = ['EtapaID', 'Fecha', 'Detalle', 'Monto'];
const HEADER_PAGOS       = ['EtapaID', 'Fecha', 'Mes', 'Detalle', 'Monto'];

function parseMonto(str) {
  if (str === null || str === undefined || str === '') return 0;
  if (typeof str === 'number') return str;
  const s = String(str).replace(/[$\s]/g, '').replace(/\./g, '').replace(',', '.');
  return parseFloat(s) || 0;
}

function fmtMonto(n) {
  return '$' + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
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

async function leerEtapas(sheets, SHEET_ID) {
  const data = await safeGet(sheets, SHEET_ID, `'${SHEET_ETAPAS}'!A2:F500`);
  return data
    .filter(r => r[0])
    .map((r, i) => ({
      fila:    i + 2,
      id:      (r[0] || '').trim(),
      nombre:  (r[1] || '').trim(),
      orden:   parseInt(r[2], 10) || 0,
      estado:  (r[3] || 'En curso').trim(),
      fecha:   (r[4] || '').trim(),
      detalle: (r[5] || '').trim(),
    }))
    .sort((a, b) => b.orden - a.orden); // la mas reciente (en curso) primero
}

async function leerMateriales(sheets, SHEET_ID) {
  const data = await safeGet(sheets, SHEET_ID, `'${SHEET_MATERIALES}'!A2:K20000`);
  return data
    .filter(r => r[0])
    .map((r, i) => ({
      fila:          i + 2,
      etapaId:       (r[0] || '').trim(),
      fecha:         (r[1] || '').trim(),
      proveedor:     (r[2] || '').trim(),
      numeroFactura: (r[3] || '').trim(),
      detalle:       (r[4] || '').trim(),
      total:         parseMonto(r[5]),
      driveFileId:   (r[6] || '').trim(),
      driveFileName: (r[7] || '').trim(),
      origen:        (r[8] || 'manual').trim(),
      fechaCarga:    (r[9] || '').trim(),
      cantidad:      (r[10] || '').trim(),
    }));
}

async function leerPresupuesto(sheets, SHEET_ID) {
  const data = await safeGet(sheets, SHEET_ID, `'${SHEET_PRESUPUESTO}'!A2:D5000`);
  return data
    .filter(r => r[0])
    .map((r, i) => ({
      fila:    i + 2,
      etapaId: (r[0] || '').trim(),
      fecha:   (r[1] || '').trim(),
      detalle: (r[2] || '').trim(),
      monto:   parseMonto(r[3]),
    }));
}

async function leerPagos(sheets, SHEET_ID) {
  const data = await safeGet(sheets, SHEET_ID, `'${SHEET_PAGOS}'!A2:E5000`);
  return data
    .filter(r => r[0])
    .map((r, i) => ({
      fila:    i + 2,
      etapaId: (r[0] || '').trim(),
      fecha:   (r[1] || '').trim(),
      mes:     (r[2] || '').trim(),
      detalle: (r[3] || '').trim(),
      monto:   parseMonto(r[4]),
    }));
}

// Totales de una etapa a partir de las filas ya leidas (evita releer la hoja
// una vez por etapa cuando se arma el listado completo).
function calcularTotalesEtapa(etapaId, materiales, presupuesto, pagos) {
  const totalMateriales  = materiales.filter(m => m.etapaId === etapaId).reduce((a, m) => a + m.total, 0);
  const totalPresupuesto = presupuesto.filter(p => p.etapaId === etapaId).reduce((a, p) => a + p.monto, 0);
  const totalPagado      = pagos.filter(p => p.etapaId === etapaId).reduce((a, p) => a + p.monto, 0);
  return { totalMateriales, totalPresupuesto, totalPagado, saldo: totalPresupuesto - totalPagado };
}

// Clave de dedup: EtapaID + Nro. Factura. Sin numero de factura no se puede
// afirmar que sea la misma compra cargada de nuevo.
function claveDuplicadoMaterial(row) {
  const numero = String(row.numeroFactura || '').trim().toUpperCase();
  if (!numero) return null;
  return row.etapaId + '|' + numero;
}

async function subirImagenADrive(driveEscritura, folderId, base64Data, mimeType, nombre) {
  const resp = await driveEscritura.files.create({
    requestBody: { name: nombre, parents: [folderId] },
    media: { mimeType, body: Readable.from(Buffer.from(base64Data, 'base64')) },
    fields: 'id, name',
  });
  return { driveFileId: resp.data.id, driveFileName: resp.data.name };
}

const GEMINI_SCHEMA_MATERIAL = {
  type: 'OBJECT',
  properties: {
    fecha:         { type: 'STRING', description: 'Fecha de la compra, formato dd/mm/aaaa. Vacio si no es legible.' },
    proveedor:     { type: 'STRING', description: 'Nombre del comercio o proveedor que emite el comprobante.' },
    numeroFactura: { type: 'STRING', description: 'Numero de factura o de ticket del comprobante, tal como figura impreso.' },
    items: {
      type: 'ARRAY',
      description: 'Un elemento por CADA producto/item que figura en el cuerpo del comprobante. Recorrer todo el ' +
        'listado impreso, no solo el primer renglon.',
      items: {
        type: 'OBJECT',
        properties: {
          detalle:  { type: 'STRING', description: 'Descripcion del producto/item, tal como figura impresa.' },
          cantidad: { type: 'STRING', description: 'Cantidad de ese item tal como figura impresa (ej. "2", "1 bolsa", "50").' },
          total:    { type: 'NUMBER', description: 'Importe de esa linea (numero, sin separador de miles).' },
        },
        required: ['detalle', 'total'],
      },
    },
    total: { type: 'NUMBER', description: 'Importe TOTAL general del comprobante, tal como figura impreso (numero, sin separador de miles).' },
  },
  required: ['fecha', 'total', 'items'],
};

const GEMINI_PROMPT_MATERIAL = 'Analiza esta imagen de un comprobante o factura de compra de materiales de ' +
  'construccion y extrae los campos pedidos. Prestá especial atencion al cuerpo del comprobante (la lista de ' +
  'productos/items comprados) para armar el array "items" completo, uno por cada renglon del comprobante, con su ' +
  'cantidad y el importe de esa linea — no un resumen ni una unica linea generica. El campo "total" es el importe ' +
  'general que figura impreso al pie del comprobante. Responde unicamente con el JSON pedido, sin texto adicional. ' +
  'Si un campo no es legible o no figura en el comprobante, dejalo vacio (string vacio o 0 segun el tipo), pero ' +
  'nunca inventes valores.';

async function analizarMaterialConGemini(base64Data, mimeType) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ parts: [{ text: GEMINI_PROMPT_MATERIAL }, { inlineData: { mimeType, data: base64Data } }] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: GEMINI_SCHEMA_MATERIAL },
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

async function agregarEtapa(sheets, SHEET_ID, { nombre, fecha, detalle }) {
  const etapas = await leerEtapas(sheets, SHEET_ID);
  const orden = etapas.reduce((max, e) => Math.max(max, e.orden), 0) + 1;
  const id = 'etapa-' + Date.now();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `'${SHEET_ETAPAS}'!A:F`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[id, nombre, orden, 'En curso', fecha || '', detalle || '']] },
  });
  return { id, nombre, orden, estado: 'En curso', fecha: fecha || '', detalle: detalle || '' };
}

// Actualiza nombre/estado/fecha/detalle de una etapa ya creada (busca la fila
// por ID; el Orden no se toca desde este formulario).
async function actualizarEtapa(sheets, SHEET_ID, { id, nombre, estado, fecha, detalle }) {
  const etapas = await leerEtapas(sheets, SHEET_ID);
  const etapa = etapas.find(e => e.id === id);
  if (!etapa) return false;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `'${SHEET_ETAPAS}'!B${etapa.fila}:F${etapa.fila}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[nombre, etapa.orden, estado || 'En curso', fecha || '', detalle || '']] },
  });
  return true;
}

// Actualiza fecha/detalle/monto de un item de presupuesto ya cargado (no
// toca EtapaID).
async function actualizarPresupuesto(sheets, SHEET_ID, { fila, fecha, detalle, monto }) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `'${SHEET_PRESUPUESTO}'!B${fila}:D${fila}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[fecha || '', detalle, monto]] },
  });
  return true;
}

// Borra una fila por numero (el frontend siempre relee el listado despues de
// cada cambio, asi que el numero de fila llega fresco al momento de borrar).
async function eliminarFila(sheets, SHEET_ID, sheetName, fila) {
  const gid = await getSheetGid(sheets, SHEET_ID, sheetName);
  if (gid === null) return false;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { requests: [{ deleteDimension: { range: { sheetId: gid, dimension: 'ROWS', startIndex: fila - 1, endIndex: fila } } }] },
  });
  return true;
}

module.exports = {
  SHEET_ETAPAS, SHEET_MATERIALES, SHEET_PRESUPUESTO, SHEET_PAGOS,
  HEADER_ETAPAS, HEADER_MATERIALES, HEADER_PRESUPUESTO, HEADER_PAGOS,
  parseMonto, fmtMonto,
  leerEtapas, leerMateriales, leerPresupuesto, leerPagos,
  calcularTotalesEtapa, claveDuplicadoMaterial, subirImagenADrive,
  analizarMaterialConGemini, agregarEtapa, actualizarEtapa,
  actualizarPresupuesto, eliminarFila,
};
