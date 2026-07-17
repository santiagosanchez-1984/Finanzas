// Endpoint unico para todo el modulo de Finanzas (dashboard, movimientos,
// metadatos, existentes, presupuesto, importar, limpiar-duplicados),
// enrutado por ?action= — asi el deployment usa 1 Serverless Function en
// vez de 7 (limite de 12 funciones en el plan Hobby de Vercel).
const cors = require('../lib/cors');
const { isAuthenticated } = require('../lib/auth');
const { getSheetsClient, getSheetGid, SHEET_ID } = require('../lib/sheets');
const { leerUsuarios, buscarPorEmail, tienePermiso } = require('../lib/usuarios');
const {
  SHEET_REGISTRO, SHEET_PRESUPUESTO, parseMonto, fmtMonto, fechaToMes,
  claveDuplicado, leerTodas,
} = require('../lib/finanzas');

// Mapeo accion -> { modulo, nivel } para el chequeo de permisos por modulo.
const PERMISO_POR_ACCION = {
  'dashboard':          { modulo: 'dashboard',   nivel: 'lectura' },
  'metadatos':          { modulo: 'dashboard',   nivel: 'lectura' },
  'movimientos':        { modulo: 'movimientos', nivel: 'lectura' },
  'presupuesto':        { modulo: 'presupuesto', nivel: 'lectura' },
  'existentes':         { modulo: 'importar',    nivel: 'lectura' },
  'importar':           { modulo: 'importar',    nivel: 'escritura' },
  'limpiar-duplicados': { modulo: 'importar',    nivel: 'escritura' },
};

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
    const permiso = PERMISO_POR_ACCION[action];
    if (permiso && !tienePermiso(usuario, permiso.modulo, permiso.nivel)) {
      return res.status(403).json({ error: 'No tenés permiso para esta acción.' });
    }

    switch (action) {
      case 'dashboard':    return await accionDashboard(req, res, sheets);
      case 'movimientos':  return await accionMovimientos(req, res, sheets);
      case 'metadatos':    return await accionMetadatos(req, res, sheets);
      case 'existentes':   return await accionExistentes(req, res, sheets);
      case 'presupuesto':  return await accionPresupuesto(req, res, sheets);
      case 'importar':
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        return await accionImportar(req, res, sheets);
      case 'limpiar-duplicados':
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        return await accionLimpiarDuplicados(req, res, sheets);
      default:
        return res.status(400).json({ error: 'accion desconocida: ' + action });
    }
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, ok: false, msg: e.message });
  }
};

async function accionDashboard(req, res, sheets) {
  const { anio, mes, banco, cat, subcat } = req.query || {};
  let rows = await leerTodas(sheets, SHEET_ID);

  if (anio)   rows = rows.filter(r => r.mes && r.mes.startsWith(anio));
  if (mes)    rows = rows.filter(r => r.mes === mes);
  if (banco)  rows = rows.filter(r => r.banco === banco);
  if (cat)    rows = rows.filter(r => r.categoria === cat);
  if (subcat) rows = rows.filter(r => r.subcat === subcat);

  let ingresos = 0, egresos = 0;
  const porMes = {}, porCatEgreso = {}, porCatIngreso = {}, porBanco = {}, porSubcatMes = {};

  rows.forEach(r => {
    const m = r.monto;
    if (r.tipo === 'INGRESO') {
      ingresos += m;
      porCatIngreso[r.categoria] = (porCatIngreso[r.categoria] || 0) + m;
    } else if (r.tipo === 'EGRESO') {
      egresos += m;
      porCatEgreso[r.categoria] = (porCatEgreso[r.categoria] || 0) + m;
      if (r.mes) {
        const scKey = r.categoria + '|' + (r.subcat || 'Sin subcat');
        if (!porSubcatMes[r.mes]) porSubcatMes[r.mes] = {};
        porSubcatMes[r.mes][scKey] = (porSubcatMes[r.mes][scKey] || 0) + m;
      }
    }
    if (r.mes) {
      if (!porMes[r.mes]) porMes[r.mes] = { ing: 0, egr: 0 };
      if (r.tipo === 'INGRESO') porMes[r.mes].ing += m;
      if (r.tipo === 'EGRESO')  porMes[r.mes].egr += m;
    }
    if (r.banco) porBanco[r.banco] = (porBanco[r.banco] || 0) + 1;
  });

  const balance   = ingresos - egresos;
  const pctAhorro = ingresos > 0 ? Math.round(balance / ingresos * 1000) / 10 : 0;
  const recientes = rows.slice(-15).reverse();

  res.json({
    ingresos, egresos, balance, pctAhorro,
    total: rows.length,
    porMes, porCatEgreso, porCatIngreso, porBanco, porSubcatMes, recientes,
  });
}

async function accionMovimientos(req, res, sheets) {
  const f = req.query || {};
  let rows = await leerTodas(sheets, SHEET_ID);

  if (f.mes)       rows = rows.filter(r => r.mes === f.mes);
  if (f.banco)     rows = rows.filter(r => r.banco === f.banco);
  if (f.tipo)      rows = rows.filter(r => r.tipo === f.tipo);
  if (f.categoria) rows = rows.filter(r => r.categoria === f.categoria);
  if (f.texto) {
    const t = f.texto.toLowerCase();
    rows = rows.filter(r =>
      r.descripcion.toLowerCase().indexOf(t) >= 0 ||
      r.medioPago.toLowerCase().indexOf(t) >= 0);
  }

  rows.sort((a, b) => {
    const da = a.fecha.split('/').reverse().join('');
    const db = b.fecha.split('/').reverse().join('');
    return db > da ? 1 : db < da ? -1 : 0;
  });

  res.json({ rows, total: rows.length });
}

async function accionMetadatos(req, res, sheets) {
  const rows = await leerTodas(sheets, SHEET_ID);
  const meses = {}, bancos = {}, cats = {}, tipos = {}, subcats = {};
  rows.forEach(r => {
    if (r.mes)       meses[r.mes]       = true;
    if (r.banco)     bancos[r.banco]    = true;
    if (r.categoria) cats[r.categoria]  = true;
    if (r.tipo)      tipos[r.tipo]      = true;
    if (r.subcat)    subcats[r.subcat]  = true;
  });
  res.json({
    meses:   Object.keys(meses).sort().reverse(),
    bancos:  Object.keys(bancos).sort(),
    cats:    Object.keys(cats).sort(),
    tipos:   Object.keys(tipos).sort(),
    subcats: Object.keys(subcats).sort(),
  });
}

async function accionExistentes(req, res, sheets) {
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${SHEET_REGISTRO}'!A3:F5000`,
  });
  const data = resp.data.values || [];
  const keys = {};
  data.forEach(r => {
    const fechaRaw = r[0], desc = String(r[4] || '').trim(), montoRaw = r[5];
    if (!fechaRaw || !desc) return;
    keys[claveDuplicado(fechaRaw, desc, parseMonto(montoRaw))] = true;
  });
  res.json(keys);
}

async function accionPresupuesto(req, res, sheets) {
  const gid = await getSheetGid(sheets, SHEET_ID, SHEET_PRESUPUESTO);
  if (gid === null) return res.json([]);
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${SHEET_PRESUPUESTO}'!A2:F200`,
  });
  const data = resp.data.values || [];
  res.json(data.filter(r => r[0] && r[1]).map(r => ({
    categoria:   r[0],
    presupuesto: parseMonto(r[1]),
    gastado:     parseMonto(r[2]),
    diferencia:  parseMonto(r[3]),
    pctUsado:    r[4],
    estado:      r[5],
  })));
}

async function accionImportar(req, res, sheets) {
  const { rows, banco } = req.body || {};
  if (!rows || !rows.length) return res.json({ ok: false, msg: 'Sin datos' });

  const existResp = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${SHEET_REGISTRO}'!A3:F5000`,
  });
  const existentes = {};
  (existResp.data.values || []).forEach(r => {
    const fechaRaw = r[0], desc = String(r[4] || '').trim(), montoRaw = r[5];
    if (!fechaRaw || !desc) return;
    existentes[claveDuplicado(fechaRaw, desc, parseMonto(montoRaw))] = true;
  });

  const nuevas = [];
  rows.forEach(row => {
    const monto = Math.abs(row.monto);
    const k = claveDuplicado(row.fecha, row.descripcion, monto);
    if (existentes[k]) return;
    existentes[k] = true;
    const mes = fechaToMes(row.fecha);
    nuevas.push([
      row.fecha,
      row.tipo        || 'EGRESO',
      row.categoria   || 'Otros Gastos',
      row.subcat      || '',
      (row.descripcion || '').substring(0, 200),
      fmtMonto(monto),
      row.medioPago   || banco,
      mes,
      'Importado ' + banco,
      banco,
    ]);
  });

  if (nuevas.length > 0) {
    const getResp = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `'${SHEET_REGISTRO}'!A:A`,
    });
    const lastRow = (getResp.data.values || []).length;
    const firstRow = Math.max(lastRow + 1, 3);
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `'${SHEET_REGISTRO}'!A${firstRow}:J${firstRow + nuevas.length - 1}`,
      valueInputOption: 'RAW',
      requestBody: { values: nuevas },
    });
  }

  res.json({ ok: true, importadas: nuevas.length, duplicadas: rows.length - nuevas.length });
}

async function accionLimpiarDuplicados(req, res, sheets) {
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `'${SHEET_REGISTRO}'!A3:F5000`,
  });
  const data = resp.data.values || [];
  const vistos = {};
  const filasABorrar = [];

  data.forEach((r, i) => {
    const desc = String(r[4] || '').trim();
    if (!desc) return;
    const monto = parseMonto(r[5]);
    const k = desc.substring(0, 40).toLowerCase() + '|' + Math.round(Math.abs(monto));
    if (vistos[k]) filasABorrar.push(i + 3);
    else vistos[k] = true;
  });

  if (filasABorrar.length > 0) {
    const gid = await getSheetGid(sheets, SHEET_ID, SHEET_REGISTRO);
    const requests = filasABorrar
      .sort((a, b) => b - a)
      .map(fila => ({
        deleteDimension: {
          range: { sheetId: gid, dimension: 'ROWS', startIndex: fila - 1, endIndex: fila },
        },
      }));
    await sheets.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests } });
  }

  res.json({ ok: true, eliminadas: filasABorrar.length });
}
