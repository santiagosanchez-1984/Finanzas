// Endpoint unico para todo el modulo de Inversiones (dashboard, movimientos,
// existentes, importar, saldos), enrutado por ?action= — mismo motivo que
// api/finanzas.js (limite de 12 Serverless Functions en el plan Hobby).
const cors = require('../lib/cors');
const { isAuthenticated } = require('../lib/auth');
const { getSheetsClient, ensureSheetExists, SHEET_ID } = require('../lib/sheets');
const {
  SHEET_MOVIMIENTOS, SHEET_SALDOS, HEADER_MOVIMIENTOS, HEADER_SALDOS,
  claveDuplicadoInversion, leerMovimientos, leerSaldos,
} = require('../lib/inversiones');

module.exports = async function(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'No autenticado' });

  const action = (req.query || {}).action;
  try {
    const sheets = getSheetsClient();
    switch (action) {
      case 'dashboard':   return await accionDashboard(req, res, sheets);
      case 'movimientos': return await accionMovimientos(req, res, sheets);
      case 'existentes':  return await accionExistentes(req, res, sheets);
      case 'importar':
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        return await accionImportar(req, res, sheets);
      case 'saldos':
        if (req.method === 'POST') return await accionGuardarSaldo(req, res, sheets);
        return await accionGetSaldos(req, res, sheets);
      default:
        return res.status(400).json({ error: 'accion desconocida: ' + action });
    }
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, ok: false, msg: e.message });
  }
};

async function accionDashboard(req, res, sheets) {
  const { broker } = req.query || {};
  let movs   = await leerMovimientos(sheets, SHEET_ID);
  let saldos = await leerSaldos(sheets, SHEET_ID);

  if (broker) { movs = movs.filter(m => m.broker === broker); saldos = saldos.filter(s => s.broker === broker); }

  const porBroker = {};
  function bucket(b) {
    if (!porBroker[b]) porBroker[b] = {
      compras: 0, ventas: 0, comisiones: 0, renta: 0,
      cauctionColocada: 0, cauctionTomada: 0, transferenciasIn: 0, transferenciasOut: 0,
      movimientos: 0,
    };
    return porBroker[b];
  }

  movs.forEach(m => {
    const b = bucket(m.broker);
    b.movimientos++;
    b.comisiones += Math.abs(m.comision);
    const t = m.tipo.toLowerCase();
    if (t.indexOf('compra') >= 0)                b.compras += Math.abs(m.total);
    else if (t.indexOf('venta') >= 0)            b.ventas += Math.abs(m.total);
    else if (t.indexOf('colocadora') >= 0)       b.cauctionColocada += Math.abs(m.total);
    else if (t.indexOf('caucion') >= 0)          b.cauctionTomada += Math.abs(m.total);
    else if (t.indexOf('renta') >= 0 || t.indexOf('amortizacion') >= 0 || t.indexOf('rendimiento') >= 0 || t.indexOf('dividendo') >= 0) b.renta += Math.abs(m.total);
    else if (t.indexOf('entrada') >= 0 || (t.indexOf('transfer') >= 0 && m.total > 0)) b.transferenciasIn += Math.abs(m.total);
    else if (t.indexOf('salida') >= 0 || (t.indexOf('transfer') >= 0 && m.total < 0))  b.transferenciasOut += Math.abs(m.total);
  });

  const ultimoSaldo = {};
  saldos.forEach(s => {
    const k = s.broker + '|' + s.moneda;
    if (!ultimoSaldo[k] || s.fecha > ultimoSaldo[k].fecha) ultimoSaldo[k] = s;
  });

  const evolucion = saldos.slice().sort((a, b) => {
    const da = a.fecha.split('/').reverse().join('');
    const db = b.fecha.split('/').reverse().join('');
    return da < db ? -1 : da > db ? 1 : 0;
  });

  res.json({ porBroker, ultimoSaldo, evolucion, totalMovimientos: movs.length });
}

async function accionMovimientos(req, res, sheets) {
  const f = req.query || {};
  let rows = await leerMovimientos(sheets, SHEET_ID);

  if (f.broker) rows = rows.filter(r => r.broker === f.broker);
  if (f.mes)    rows = rows.filter(r => r.mes === f.mes);
  if (f.tipo)   rows = rows.filter(r => r.tipo === f.tipo);
  if (f.texto) {
    const t = f.texto.toLowerCase();
    rows = rows.filter(r => r.instrumento.toLowerCase().indexOf(t) >= 0 || r.notas.toLowerCase().indexOf(t) >= 0);
  }

  rows.sort((a, b) => {
    const da = a.fecha.split('/').reverse().join('');
    const db = b.fecha.split('/').reverse().join('');
    return db > da ? 1 : db < da ? -1 : 0;
  });

  res.json({ rows, total: rows.length });
}

async function accionExistentes(req, res, sheets) {
  const rows = await leerMovimientos(sheets, SHEET_ID);
  const keys = {};
  rows.forEach(r => { keys[claveDuplicadoInversion(r)] = true; });
  res.json(keys);
}

async function accionImportar(req, res, sheets) {
  const { rows, broker } = req.body || {};
  if (!rows || !rows.length) return res.json({ ok: false, msg: 'Sin datos' });

  await ensureSheetExists(sheets, SHEET_ID, SHEET_MOVIMIENTOS, HEADER_MOVIMIENTOS);

  const existentesArr = await leerMovimientos(sheets, SHEET_ID);
  const existentes = {};
  existentesArr.forEach(r => { existentes[claveDuplicadoInversion(r)] = true; });

  const nuevas = [];
  rows.forEach(row => {
    const r = {
      fecha: row.fecha, broker: row.broker || broker, tipo: row.tipo,
      instrumento: row.instrumento || '', total: row.total, notas: row.notas || '',
    };
    const k = claveDuplicadoInversion(r);
    if (existentes[k]) return;
    existentes[k] = true;
    nuevas.push([
      row.fecha, row.broker || broker, row.tipo || '', row.instrumento || '', row.moneda || '',
      row.cantidad || '', row.precio || '', row.montoBruto || '', row.comision || '', row.total || '', row.notas || '',
    ]);
  });

  if (nuevas.length > 0) {
    const getResp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `'${SHEET_MOVIMIENTOS}'!A:A` });
    const lastRow = (getResp.data.values || []).length;
    const firstRow = Math.max(lastRow + 1, 2);
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `'${SHEET_MOVIMIENTOS}'!A${firstRow}:K${firstRow + nuevas.length - 1}`,
      valueInputOption: 'RAW',
      requestBody: { values: nuevas },
    });
  }

  res.json({ ok: true, importadas: nuevas.length, duplicadas: rows.length - nuevas.length });
}

async function accionGetSaldos(req, res, sheets) {
  const rows = await leerSaldos(sheets, SHEET_ID);
  res.json({ rows });
}

async function accionGuardarSaldo(req, res, sheets) {
  const { fecha, broker, moneda, saldo, notas } = req.body || {};
  if (!fecha || !broker || !moneda || saldo === undefined) {
    return res.status(400).json({ ok: false, msg: 'Faltan datos (fecha, broker, moneda, saldo)' });
  }
  await ensureSheetExists(sheets, SHEET_ID, SHEET_SALDOS, HEADER_SALDOS);
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `'${SHEET_SALDOS}'!A:E`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[fecha, broker, moneda, saldo, notas || '']] },
  });
  res.json({ ok: true });
}
