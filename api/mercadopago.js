// Endpoint del modulo Mercado Pago (dashboard/movimientos/existentes/importar),
// enrutado por ?action= — mismo patron dispatch que los demas modulos.
const cors = require('../lib/cors');
const { isAuthenticated } = require('../lib/auth');
const { getSheetsClient, ensureSheetExists, SHEET_ID } = require('../lib/sheets');
const { leerUsuarios, buscarPorEmail, tienePermiso } = require('../lib/usuarios');
const {
  SHEET_MP, HEADER_MP, CATEGORIAS_MP,
  claveDuplicadoMP, leerMovimientos,
} = require('../lib/mercadopago');

// Todo el modulo Mercado Pago cae bajo un unico permiso ("mercadopago").
const NIVEL_POR_ACCION = { 'dashboard': 'lectura', 'movimientos': 'lectura', 'existentes': 'lectura', 'importar': 'escritura' };

module.exports = async function(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const email = isAuthenticated(req);
  if (!email) return res.status(401).json({ error: 'No autenticado' });

  const action = (req.query || {}).action;
  try {
    const sheets = getSheetsClient();

    const usuarios = await leerUsuarios(sheets, SHEET_ID);
    const usuario = buscarPorEmail(usuarios, email);
    if (!usuario) return res.status(403).json({ error: 'Tu cuenta no tiene acceso a esta aplicación.' });
    const nivel = NIVEL_POR_ACCION[action];
    if (nivel && !tienePermiso(usuario, 'mercadopago', nivel)) {
      return res.status(403).json({ error: 'No tenés permiso para esta acción.' });
    }

    switch (action) {
      case 'dashboard':   return await accionDashboard(req, res, sheets);
      case 'movimientos': return await accionMovimientos(req, res, sheets);
      case 'existentes':  return await accionExistentes(req, res, sheets);
      case 'importar':
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        return await accionImportar(req, res, sheets);
      case 'categorias':
        return res.json({ categorias: CATEGORIAS_MP });
      default:
        return res.status(400).json({ error: 'accion desconocida: ' + action });
    }
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, ok: false, msg: e.message });
  }
};

// ── Fechas dd/mm/yyyy ──
function fechaAIso(f) {
  const p = String(f || '').split('/');
  if (p.length !== 3) return null;
  return p[2] + '-' + p[1].padStart(2, '0') + '-' + p[0].padStart(2, '0');
}

// Orden cronológico real: fecha y, dentro del mismo día, el orden en que la
// fila se importó (columna A del sheet, "fila"). El ID de operación NO sirve
// como desempate: "Rendimientos" usa una numeración totalmente distinta (mucho
// más grande) que el resto de los movimientos, así que mezclar ambas por
// magnitud numérica los desordena. El orden de importación sí es confiable
// porque el PDF lista los movimientos de arriba hacia abajo en orden real.
function ordenarCronologico(rows) {
  return rows.slice().sort((a, b) => {
    const ia = fechaAIso(a.fecha) || '', ib = fechaAIso(b.fecha) || '';
    if (ia !== ib) return ia < ib ? -1 : 1;
    return a.fila - b.fila;
  });
}

async function accionDashboard(req, res, sheets) {
  const rows = ordenarCronologico(await leerMovimientos(sheets, SHEET_ID));

  const saldoActual      = rows.length ? rows[rows.length - 1].saldo : 0;
  const saldoActualFecha = rows.length ? rows[rows.length - 1].fecha : '';

  const hoy = new Date();
  const mesActual = hoy.getFullYear() + '-' + String(hoy.getMonth() + 1).padStart(2, '0');

  let ingresosMes = 0, egresosMes = 0, rendimientosTotal = 0, totalIngresos = 0, totalEgresos = 0;
  const porCategoria = {};
  const porMes = {};

  rows.forEach(r => {
    if (r.valor >= 0) totalIngresos += r.valor; else totalEgresos += Math.abs(r.valor);
    if (r.categoria === 'Rendimientos') rendimientosTotal += r.valor;

    if (r.mes === mesActual) {
      if (r.valor >= 0) ingresosMes += r.valor; else egresosMes += Math.abs(r.valor);
    }

    if (!porMes[r.mes]) porMes[r.mes] = { ingresos: 0, egresos: 0 };
    if (r.valor >= 0) porMes[r.mes].ingresos += r.valor; else porMes[r.mes].egresos += Math.abs(r.valor);

    // Composición de gastos: excluye transferencias enviadas (no son "consumo").
    if (r.valor < 0 && r.categoria !== 'Transferencias enviadas') {
      porCategoria[r.categoria] = (porCategoria[r.categoria] || 0) + Math.abs(r.valor);
    }
  });

  const evolucionSaldo = rows.map(r => ({ fecha: r.fecha, saldo: r.saldo }));
  const recientes = rows.slice(-12).reverse();

  res.json({
    saldoActual, saldoActualFecha, ingresosMes, egresosMes, resultadoMes: ingresosMes - egresosMes,
    mesActual, rendimientosTotal, totalIngresos, totalEgresos, totalMovimientos: rows.length,
    porCategoria, porMes, evolucionSaldo, recientes,
  });
}

async function accionMovimientos(req, res, sheets) {
  const f = req.query || {};
  let rows = await leerMovimientos(sheets, SHEET_ID);

  if (f.mes)       rows = rows.filter(r => r.mes === f.mes);
  if (f.desde)     rows = rows.filter(r => (fechaAIso(r.fecha) || '') >= f.desde);
  if (f.hasta)     rows = rows.filter(r => (fechaAIso(r.fecha) || '') <= f.hasta);
  if (f.categoria) rows = rows.filter(r => r.categoria === f.categoria);
  if (f.tipo === 'INGRESO') rows = rows.filter(r => r.valor >= 0);
  if (f.tipo === 'EGRESO')  rows = rows.filter(r => r.valor < 0);
  if (f.texto) {
    const t = f.texto.toLowerCase();
    rows = rows.filter(r => r.descripcion.toLowerCase().indexOf(t) >= 0);
  }

  rows = ordenarCronologico(rows).reverse();

  res.json({ rows, total: rows.length });
}

async function accionExistentes(req, res, sheets) {
  const rows = await leerMovimientos(sheets, SHEET_ID);
  const keys = {};
  rows.forEach(r => { keys[claveDuplicadoMP(r)] = true; });
  res.json(keys);
}

async function accionImportar(req, res, sheets) {
  const { rows } = req.body || {};
  if (!rows || !rows.length) return res.json({ ok: false, msg: 'Sin datos' });

  await ensureSheetExists(sheets, SHEET_ID, SHEET_MP, HEADER_MP);

  const existentesArr = await leerMovimientos(sheets, SHEET_ID);
  const existentes = {};
  existentesArr.forEach(r => { existentes[claveDuplicadoMP(r)] = true; });

  const nuevas = [];
  rows.forEach(row => {
    const k = claveDuplicadoMP(row);
    if (!k || existentes[k]) return;
    existentes[k] = true;
    nuevas.push([
      row.fecha, row.descripcion || '', row.idOperacion, row.valor || 0, row.saldo || 0, row.categoria || 'Otros',
    ]);
  });

  if (nuevas.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `'${SHEET_MP}'!A:F`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: nuevas },
    });
  }

  res.json({ ok: true, importadas: nuevas.length, duplicadas: rows.length - nuevas.length });
}
