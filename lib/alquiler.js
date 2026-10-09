// Utilidades del modulo Alquiler: pagos mensuales de alquiler del depto +
// cochera + expensas. Los datos viven en la hoja "BD" de una planilla propia
// (ALQUILER_SHEET_ID), una fila por mes. Esa misma planilla tiene ademas las
// pestanas historicas por año ("2023", "2024", ...) con bloques mensuales
// armados a mano; importarHistorico() las convierte a filas de BD.
const { getSheetGid } = require('./sheets');

const SHEET_BD = 'BD';
// Descuento: arreglos del depto que paga el inquilino y se descuentan del
// alquiler (ej. termotanque). Se carga en positivo y se resta del Total.
const HEADER_BD = [
  'Mes', 'Alquiler', 'Cochera', 'Expensas', 'Otros', 'DetalleOtros',
  'Descuento', 'DetalleDescuento', 'Total', 'FechaPago', 'Notas', 'Origen', 'FechaCarga',
];

function calcularTotal(alquiler, cochera, expensas, otros, descuento) {
  return redondear(alquiler + cochera + expensas + otros - descuento);
}

const MESES_NOMBRE = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

function parseMonto(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/[$\s]/g, '').replace(/\./g, '').replace(',', '.');
  return parseFloat(s) || 0;
}

function redondear(n) {
  return Math.round(n * 100) / 100;
}

function fechaHoy() {
  const d = new Date();
  return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();
}

function mesValido(mes) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(mes || ''));
}

async function safeGet(sheets, spreadsheetId, range, valueRenderOption) {
  try {
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range, valueRenderOption });
    return resp.data.values || [];
  } catch (e) {
    if (String(e.message || '').indexOf('Unable to parse range') >= 0) return []; // la hoja todavia no existe
    throw e;
  }
}

// La hoja BD puede existir vacia (creada a mano): ensureSheetExists no le pone
// encabezado en ese caso, asi que se verifica A1 y se escribe con formato.
async function asegurarHojaBD(sheets, SHEET_ID) {
  let gid = await getSheetGid(sheets, SHEET_ID, SHEET_BD);
  if (gid === null) {
    const res = await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: SHEET_BD } } }] },
    });
    gid = res.data.replies[0].addSheet.properties.sheetId;
  }
  const a1 = await safeGet(sheets, SHEET_ID, `'${SHEET_BD}'!A1:M1`);
  if (a1.length && a1[0][0]) return gid;

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `'${SHEET_BD}'!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [HEADER_BD] },
  });
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { requests: [
      { repeatCell: {
        range: { sheetId: gid, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: HEADER_BD.length },
        cell: { userEnteredFormat: {
          backgroundColor: { red: 0.04, green: 0.21, blue: 0.38 },
          textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
          horizontalAlignment: 'CENTER',
        } },
        fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)',
      } },
      { updateSheetProperties: { properties: { sheetId: gid, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
      { repeatCell: {
        range: { sheetId: gid, startRowIndex: 1, startColumnIndex: 1, endColumnIndex: 9 },
        cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '$#,##0.00' } } },
        fields: 'userEnteredFormat.numberFormat',
      } },
    ] },
  });
  return gid;
}

async function leerRegistros(sheets, SHEET_ID) {
  const data = await safeGet(sheets, SHEET_ID, `'${SHEET_BD}'!A2:M2000`, 'UNFORMATTED_VALUE');
  return data
    .map((r, i) => ({ r, fila: i + 2 }))
    .filter(x => mesValido(String(x.r[0] || '').trim()))
    .map(({ r, fila }) => {
      const alquiler = parseMonto(r[1]);
      const cochera  = parseMonto(r[2]);
      const expensas = parseMonto(r[3]);
      const otros    = parseMonto(r[4]);
      const descuento = parseMonto(r[6]);
      return {
        fila,
        mes:          String(r[0]).trim(),
        alquiler, cochera, expensas, otros,
        detalleOtros: String(r[5] || '').trim(),
        descuento,
        detalleDescuento: String(r[7] || '').trim(),
        total:        calcularTotal(alquiler, cochera, expensas, otros, descuento), // siempre recalculado, no se confia en la columna
        fechaPago:    String(r[9] || '').trim(),
        notas:        String(r[10] || '').trim(),
        origen:       String(r[11] || 'manual').trim(),
        fechaCarga:   String(r[12] || '').trim(),
      };
    })
    .sort((a, b) => a.mes.localeCompare(b.mes));
}

function filaDesdeRegistro(reg, origen) {
  const alquiler = parseMonto(reg.alquiler);
  const cochera  = parseMonto(reg.cochera);
  const expensas = parseMonto(reg.expensas);
  const otros    = parseMonto(reg.otros);
  const descuento = Math.abs(parseMonto(reg.descuento));
  return [
    reg.mes, alquiler, cochera, expensas, otros, reg.detalleOtros || '',
    descuento, reg.detalleDescuento || '',
    calcularTotal(alquiler, cochera, expensas, otros, descuento),
    reg.fechaPago || '', reg.notas || '', origen || 'manual', fechaHoy(),
  ];
}

async function agregarRegistros(sheets, SHEET_ID, registros, origen) {
  if (!registros.length) return 0;
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `'${SHEET_BD}'!A:M`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: registros.map(r => filaDesdeRegistro(r, origen)) },
  });
  return registros.length;
}

async function actualizarRegistro(sheets, SHEET_ID, fila, reg, origenPrevio) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `'${SHEET_BD}'!A${fila}:M${fila}`,
    valueInputOption: 'RAW',
    requestBody: { values: [filaDesdeRegistro(reg, origenPrevio || 'manual')] },
  });
}

async function eliminarFila(sheets, SHEET_ID, fila) {
  const gid = await getSheetGid(sheets, SHEET_ID, SHEET_BD);
  if (gid === null) return false;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { requests: [{ deleteDimension: { range: { sheetId: gid, dimension: 'ROWS', startIndex: fila - 1, endIndex: fila } } }] },
  });
  return true;
}

// ── Importacion de las pestanas historicas por año ─────────────
// Cada pestaña ("2023", "2024", ...) tiene bloques de 2 columnas:
//   [titulo "Aquiler Depto ..."] / [mes "enero 2026"] / Alquiler $ | n /
//   Cochera | n / Expensas | n / Total | n / [opcional: arreglo descontado]
// El año se toma del nombre de la pestaña, no del texto del encabezado: en la
// pestaña 2025 varios bloques dicen "abril 2024", "julio 2024", etc. por un
// copiar/pegar, pero los montos son claramente de 2025.
function parsearPestanaAnual(anio, textos, valores) {
  const out = [];
  const celdaTxt = (r, c) => String(((textos[r] || [])[c]) ?? '').trim();
  const celdaVal = (r, c) => ((valores[r] || [])[c]);

  for (let r = 0; r < textos.length; r++) {
    const fila = textos[r] || [];
    for (let c = 0; c < fila.length; c++) {
      if (!/^alquiler\b/i.test(celdaTxt(r, c))) continue;

      // Mes: primera celda hacia arriba (en esta columna) que nombre un mes.
      let mesIdx = -1;
      for (let k = r - 1; k >= Math.max(0, r - 3) && mesIdx < 0; k--) {
        const t = celdaTxt(k, c).toLowerCase();
        mesIdx = MESES_NOMBRE.findIndex(m => t.startsWith(m));
      }
      if (mesIdx < 0) continue;

      const alquiler = parseMonto(celdaVal(r, c + 1));
      const cochera  = /^cochera/i.test(celdaTxt(r + 1, c)) ? parseMonto(celdaVal(r + 1, c + 1)) : 0;
      const expensas = /^expensa/i.test(celdaTxt(r + 2, c)) ? parseMonto(celdaVal(r + 2, c + 1)) : 0;
      if (!alquiler && !cochera && !expensas) continue; // bloque de un mes futuro, todavia vacio

      // Fila extra debajo del Total (ej. "Termitanque | 313.290"): es un
      // arreglo descontado del alquiler, y el valor es lo que efectivamente se
      // pago ese mes. El descuento es la diferencia contra el total bruto.
      let descuento = 0, detalleDescuento = '';
      const notas = [];
      const filaTotal = /^total/i.test(celdaTxt(r + 3, c)) ? r + 3 : -1;
      if (filaTotal >= 0) {
        const etiqueta = celdaTxt(filaTotal + 1, c);
        const pagado = parseMonto(celdaVal(filaTotal + 1, c + 1));
        if (etiqueta && !/aquiler|alquiler depto/i.test(etiqueta) && pagado) {
          const bruto = alquiler + cochera + expensas;
          if (pagado > 0 && pagado < bruto) {
            descuento = redondear(bruto - pagado);
            detalleDescuento = etiqueta;
          } else {
            notas.push(etiqueta + ': $' + celdaTxt(filaTotal + 1, c + 1));
          }
        }
      }

      out.push({
        mes: anio + '-' + String(mesIdx + 1).padStart(2, '0'),
        alquiler: redondear(alquiler), cochera: redondear(cochera), expensas: redondear(expensas),
        otros: 0, detalleOtros: '', descuento, detalleDescuento, fechaPago: '', notas: notas.join(' · '),
      });
    }
  }
  return out;
}

async function leerHistoricoPestanas(sheets, SHEET_ID) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID, fields: 'sheets.properties.title' });
  const pestanas = meta.data.sheets.map(s => s.properties.title).filter(t => /^\d{4}$/.test(t.trim())).sort();
  if (!pestanas.length) return { pestanas, registros: [] };

  const rangos = pestanas.map(t => `'${t}'!A1:Z200`);
  const [txt, val] = await Promise.all([
    sheets.spreadsheets.values.batchGet({ spreadsheetId: SHEET_ID, ranges: rangos, valueRenderOption: 'FORMATTED_VALUE' }),
    sheets.spreadsheets.values.batchGet({ spreadsheetId: SHEET_ID, ranges: rangos, valueRenderOption: 'UNFORMATTED_VALUE' }),
  ]);

  const porMes = {};
  pestanas.forEach((t, i) => {
    const regs = parsearPestanaAnual(t.trim(), txt.data.valueRanges[i].values || [], val.data.valueRanges[i].values || []);
    regs.forEach(r => { if (!porMes[r.mes]) porMes[r.mes] = r; });
  });
  const registros = Object.keys(porMes).sort().map(m => porMes[m]);
  return { pestanas, registros };
}

module.exports = {
  SHEET_BD, HEADER_BD,
  parseMonto, mesValido,
  asegurarHojaBD, leerRegistros, agregarRegistros, actualizarRegistro, eliminarFila,
  parsearPestanaAnual, leerHistoricoPestanas,
};
