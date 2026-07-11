// Utilidades del módulo de Inversiones (Cocos Capital, BullMarket, Balanz, Banco Galicia USD).

const SHEET_MOVIMIENTOS = 'INVERSIONES';
const SHEET_SALDOS       = 'INVERSIONES_SALDOS';
const SHEET_TENENCIAS    = 'INVERSIONES_TENENCIAS';

const HEADER_MOVIMIENTOS = ['Fecha', 'Broker', 'Tipo', 'Instrumento', 'Moneda', 'Cantidad', 'Precio', 'MontoBruto', 'Comision', 'Total', 'Notas'];
const HEADER_SALDOS      = ['Fecha', 'Broker', 'Moneda', 'Saldo', 'Notas'];
const HEADER_TENENCIAS   = ['FechaSnapshot', 'Broker', 'Instrumento', 'Cantidad', 'Precio', 'Moneda', 'Total'];

function parseNumARS(str) {
  if (str === null || str === undefined || str === '') return 0;
  if (typeof str === 'number') return str;
  const s = String(str).trim().replace(/\$/g, '').replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function fmtNum(n, decimales) {
  const d = decimales === undefined ? 2 : decimales;
  return Number(n).toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function fechaToMes(fecha) {
  if (!fecha) return '';
  const m = String(fecha).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return m[3] + '-' + String(m[2]).padStart(2, '0');
  return '';
}

// Clave de dedup: preferimos el nro de ticket (guardado en notas) si esta disponible,
// si no, fecha + instrumento + tipo + total.
function claveDuplicadoInversion(row) {
  const ticketM = String(row.notas || '').match(/Ticket\s+(\S+)/);
  if (ticketM) return 'TCK:' + ticketM[1];
  return [row.fecha, row.broker, row.tipo, row.instrumento, Math.round(Math.abs(row.total || 0) * 100)].join('|').toLowerCase();
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

async function leerMovimientos(sheets, SHEET_ID) {
  const data = await safeGet(sheets, SHEET_ID, `'${SHEET_MOVIMIENTOS}'!A2:K10000`);
  return data
    .filter(r => r[0] && r[1])
    .map((r, i) => ({
      fila:        i + 2,
      fecha:       (r[0] || '').trim(),
      broker:      (r[1] || '').trim(),
      tipo:        (r[2] || '').trim(),
      instrumento: (r[3] || '').trim(),
      moneda:      (r[4] || '').trim(),
      cantidad:    parseNumARS(r[5]),
      precio:      parseNumARS(r[6]),
      montoBruto:  parseNumARS(r[7]),
      comision:    parseNumARS(r[8]),
      total:       parseNumARS(r[9]),
      notas:       (r[10] || '').trim(),
      mes:         fechaToMes((r[0] || '').trim()),
    }));
}

async function leerSaldos(sheets, SHEET_ID) {
  const data = await safeGet(sheets, SHEET_ID, `'${SHEET_SALDOS}'!A2:E5000`);
  return data
    .filter(r => r[0] && r[1])
    .map((r, i) => ({
      fila:   i + 2,
      fecha:  (r[0] || '').trim(),
      broker: (r[1] || '').trim(),
      moneda: (r[2] || '').trim(),
      saldo:  parseNumARS(r[3]),
      notas:  (r[4] || '').trim(),
    }));
}

async function leerTenencias(sheets, SHEET_ID) {
  const data = await safeGet(sheets, SHEET_ID, `'${SHEET_TENENCIAS}'!A2:G20000`);
  return data
    .filter(r => r[0] && r[1])
    .map((r, i) => ({
      fila:        i + 2,
      fecha:       (r[0] || '').trim(),
      broker:      (r[1] || '').trim(),
      instrumento: (r[2] || '').trim(),
      cantidad:    parseNumARS(r[3]),
      precio:      parseNumARS(r[4]),
      moneda:      (r[5] || '').trim(),
      total:       parseNumARS(r[6]),
    }));
}

// Clave de dedup para tenencias: una misma foto (fecha+broker) no deberia
// tener el mismo instrumento cargado dos veces.
function claveDuplicadoTenencia(row) {
  return [row.fecha, row.broker, row.instrumento].join('|').toLowerCase();
}

module.exports = {
  SHEET_MOVIMIENTOS, SHEET_SALDOS, SHEET_TENENCIAS,
  HEADER_MOVIMIENTOS, HEADER_SALDOS, HEADER_TENENCIAS,
  parseNumARS, fmtNum, fechaToMes, claveDuplicadoInversion, claveDuplicadoTenencia,
  leerMovimientos, leerSaldos, leerTenencias,
};
