// Utilidades del modulo Mercado Pago: hoja propia, totalmente independiente
// de "📋 Registro". El PDF "Resumen de cuenta" se parsea client-side con
// pdf.js (ver views/index.html, funcion parsearMercadoPagoPDF); este archivo
// solo lee/escribe la hoja.

const SHEET_MP = 'Mercado Pago';
const HEADER_MP = ['Fecha', 'Descripcion', 'IdOperacion', 'Valor', 'Saldo', 'Categoria'];

const CATEGORIAS_MP = [
  'Rendimientos', 'Ingresos', 'Transferencias recibidas', 'Transferencias enviadas',
  'Alimentación', 'Salud', 'Transporte', 'Impuestos', 'Servicios', 'Consumos/Comercios', 'Otros',
];

function parseNumARS(str) {
  if (str === null || str === undefined || str === '') return 0;
  if (typeof str === 'number') return str;
  const s = String(str).trim().replace(/\$/g, '').replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function fechaToMes(fecha) {
  if (!fecha) return '';
  const m = String(fecha).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return m[3] + '-' + String(m[2]).padStart(2, '0');
  return '';
}

// Clave de dedup: el ID de operación de Mercado Pago es único por movimiento
// (mucho más confiable que fecha+descripción+monto).
function claveDuplicadoMP(row) {
  return String(row.idOperacion || '').trim();
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
  const data = await safeGet(sheets, SHEET_ID, `'${SHEET_MP}'!A2:F50000`);
  return data
    .filter(r => r[0] && r[2])
    .map((r, i) => ({
      fila:        i + 2,
      fecha:       (r[0] || '').trim(),
      descripcion: (r[1] || '').trim(),
      idOperacion: (r[2] || '').trim(),
      valor:       parseNumARS(r[3]),
      saldo:       parseNumARS(r[4]),
      categoria:   (r[5] || 'Otros').trim(),
      mes:         fechaToMes((r[0] || '').trim()),
    }));
}

module.exports = {
  SHEET_MP, HEADER_MP, CATEGORIAS_MP,
  parseNumARS, fechaToMes, claveDuplicadoMP, leerMovimientos,
};
