// Utilidades portadas de Codigo.gs (Apps Script) sin dependencias de Apps Script.

const SHEET_REGISTRO     = '📋 Registro';
const SHEET_PRESUPUESTO  = 'METAS Y PRESUPUESTO';

function parseMonto(str) {
  if (!str) return 0;
  const s = String(str).replace(/[$\s]/g, '').replace(/\./g, '').replace(',', '.');
  return parseFloat(s) || 0;
}

function fmtMonto(n) {
  return '$' + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

function fechaToMes(fecha) {
  if (!fecha) return '';
  let m = String(fecha).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return m[3] + '-' + String(m[2]).padStart(2, '0');
  m = String(fecha).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return m[1] + '-' + m[2];
  return '';
}

// Acepta fecha string DD/MM/YYYY, D/M/YYYY o YYYY-MM-DD.
function claveDuplicado(fecha, desc, monto) {
  const f = String(fecha).trim();
  let fechaNorm;
  const mf = f.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (mf) {
    fechaNorm = mf[3] + String(mf[2]).padStart(2, '0') + String(mf[1]).padStart(2, '0');
  } else {
    const mf2 = f.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    fechaNorm = mf2 ? mf2[1] + mf2[2] + mf2[3] : f.replace(/[\/\-\s]/g, '');
  }
  return fechaNorm + '|' + String(desc).trim().substring(0, 35).toLowerCase() + '|' + Math.round(Math.abs(monto));
}

async function leerTodas(sheets, SHEET_ID) {
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${SHEET_REGISTRO}'!A3:J5000`,
  });
  const data = resp.data.values || [];
  return data
    .filter(r => r[0] && r[5])
    .map((r, i) => ({
      fila:        i + 3, // fila real en la hoja (offset por titulo+encabezado); valido solo si no hubo huecos antes
      fecha:       (r[0] || '').trim(),
      tipo:        (r[1] || '').trim(),
      categoria:   (r[2] || '').trim(),
      subcat:      (r[3] || '').trim(),
      descripcion: (r[4] || '').trim(),
      monto:       parseMonto(r[5]),
      medioPago:   (r[6] || '').trim(),
      mes:         (r[7] || '').trim(),
      notas:       (r[8] || '').trim(),
      banco:       (r[9] || '').trim(),
    }));
}

module.exports = {
  SHEET_REGISTRO, SHEET_PRESUPUESTO,
  parseMonto, fmtMonto, fechaToMes, claveDuplicado, leerTodas,
};
