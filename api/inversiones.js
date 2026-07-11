// Endpoint unico para todo el modulo de Inversiones (dashboard, movimientos,
// existentes, importar, saldos, tenencias), enrutado por ?action= — mismo
// motivo que api/finanzas.js (limite de 12 Serverless Functions en Hobby).
const cors = require('../lib/cors');
const { isAuthenticated } = require('../lib/auth');
const { getSheetsClient, ensureSheetExists, SHEET_ID } = require('../lib/sheets');
const {
  SHEET_MOVIMIENTOS, SHEET_SALDOS, SHEET_TENENCIAS,
  HEADER_MOVIMIENTOS, HEADER_SALDOS, HEADER_TENENCIAS,
  claveDuplicadoInversion, claveDuplicadoTenencia,
  leerMovimientos, leerSaldos, leerTenencias,
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
      case 'tenencias':
        return await accionGetTenencias(req, res, sheets);
      case 'importar-tenencias':
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        return await accionImportarTenencias(req, res, sheets);
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
function ordenarPorFecha(arr) {
  return arr.slice().sort((a, b) => {
    const ia = fechaAIso(a.fecha) || '', ib = fechaAIso(b.fecha) || '';
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  });
}

async function accionDashboard(req, res, sheets) {
  const { broker } = req.query || {};
  let movs      = await leerMovimientos(sheets, SHEET_ID);
  let saldos    = await leerSaldos(sheets, SHEET_ID);
  let tenencias = await leerTenencias(sheets, SHEET_ID);

  if (broker) {
    movs      = movs.filter(m => m.broker === broker);
    saldos    = saldos.filter(s => s.broker === broker);
    tenencias = tenencias.filter(t => t.broker === broker);
  }

  // ── Estadisticas de movimientos (informativas: no representan patrimonio) ──
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

  // ── Patrimonio real: se arma SOLO a partir de fotos de cartera (tenencias)
  // y saldos cargados a mano — nunca sumando movimientos historicos (una
  // caucion se renueva todos los dias, sumarlas todas exagera el capital). ──
  const snapshotsPorBrokerFecha = {}; // broker|fecha -> { moneda: total }
  tenencias.forEach(t => {
    const k = t.broker + '|' + t.fecha;
    if (!snapshotsPorBrokerFecha[k]) snapshotsPorBrokerFecha[k] = { broker: t.broker, fecha: t.fecha, porMoneda: {} };
    snapshotsPorBrokerFecha[k].porMoneda[t.moneda] = (snapshotsPorBrokerFecha[k].porMoneda[t.moneda] || 0) + t.total;
  });

  // Serie de valores por broker+moneda, combinando tenencias (preferido) y saldos manuales
  const seriePorBrokerMoneda = {}; // "broker|moneda" -> [{fecha, valor, origen}]
  function addPunto(b, m, fecha, valor, origen) {
    const k = b + '|' + m;
    if (!seriePorBrokerMoneda[k]) seriePorBrokerMoneda[k] = [];
    seriePorBrokerMoneda[k].push({ fecha, valor, origen });
  }
  Object.values(snapshotsPorBrokerFecha).forEach(snap => {
    Object.keys(snap.porMoneda).forEach(moneda => {
      addPunto(snap.broker, moneda, snap.fecha, snap.porMoneda[moneda], 'tenencias');
    });
  });
  saldos.forEach(s => addPunto(s.broker, s.moneda, s.fecha, s.saldo, 'saldo'));

  // Por fecha exacta duplicada preferimos tenencias sobre saldo manual
  Object.keys(seriePorBrokerMoneda).forEach(k => {
    const porFecha = {};
    seriePorBrokerMoneda[k].forEach(p => {
      const prev = porFecha[p.fecha];
      if (!prev || (prev.origen !== 'tenencias' && p.origen === 'tenencias')) porFecha[p.fecha] = p;
    });
    seriePorBrokerMoneda[k] = ordenarPorFecha(Object.values(porFecha));
  });

  // Patrimonio actual = ultimo punto de cada serie
  const ultimoSaldo = {};
  Object.keys(seriePorBrokerMoneda).forEach(k => {
    const serie = seriePorBrokerMoneda[k];
    if (serie.length) {
      const ult = serie[serie.length - 1];
      ultimoSaldo[k] = { broker: ult.broker || k.split('|')[0], moneda: k.split('|')[1], fecha: ult.fecha, saldo: ult.valor };
    }
  });

  // Composicion actual (ultima foto de tenencias por broker)
  const ultimaFechaTenenciaPorBroker = {};
  tenencias.forEach(t => {
    if (!ultimaFechaTenenciaPorBroker[t.broker] || fechaAIso(t.fecha) > fechaAIso(ultimaFechaTenenciaPorBroker[t.broker])) {
      ultimaFechaTenenciaPorBroker[t.broker] = t.fecha;
    }
  });
  const composicion = tenencias.filter(t => t.fecha === ultimaFechaTenenciaPorBroker[t.broker]);

  // Evolucion "aplanada" para el grafico (compatibilidad con el frontend actual)
  const evolucion = [];
  Object.keys(seriePorBrokerMoneda).forEach(k => {
    const [b, m] = k.split('|');
    seriePorBrokerMoneda[k].forEach(p => evolucion.push({ broker: b, moneda: m, fecha: p.fecha, saldo: p.valor }));
  });

  // Resultado por periodo (variacion del valor de cartera), por broker+moneda
  const resultadoPeriodos = {};
  ['mes', 'trimestre', 'semestre', 'anio'].forEach(tipo => {
    Object.keys(seriePorBrokerMoneda).forEach(k => {
      const serie = seriePorBrokerMoneda[k];
      if (!resultadoPeriodos[tipo]) resultadoPeriodos[tipo] = {};
      resultadoPeriodos[tipo][k] = calcularResultadoPeriodo(serie, tipo);
    });
  });

  res.json({
    porBroker, ultimoSaldo, evolucion, composicion, resultadoPeriodos,
    totalMovimientos: movs.length,
  });
}

function claveDePeriodo(fecha, tipo) {
  const iso = fechaAIso(fecha);
  if (!iso) return null;
  const [y, m] = iso.split('-');
  const mNum = parseInt(m, 10);
  if (tipo === 'mes')       return y + '-' + m;
  if (tipo === 'trimestre') return y + '-T' + (Math.floor((mNum - 1) / 3) + 1);
  if (tipo === 'semestre')  return y + '-S' + (mNum <= 6 ? 1 : 2);
  return y;
}

// Toma el ultimo valor disponible dentro de cada periodo (cierre de periodo)
// y calcula la variacion contra el cierre del periodo anterior.
function calcularResultadoPeriodo(serieOrdenada, tipo) {
  const cierres = []; // { periodo, fecha, valor }
  serieOrdenada.forEach(p => {
    const periodo = claveDePeriodo(p.fecha, tipo);
    if (!periodo) return;
    const idx = cierres.findIndex(c => c.periodo === periodo);
    if (idx === -1) cierres.push({ periodo, fecha: p.fecha, valor: p.valor });
    else if (fechaAIso(p.fecha) >= fechaAIso(cierres[idx].fecha)) cierres[idx] = { periodo, fecha: p.fecha, valor: p.valor };
  });
  return cierres.map((c, i) => {
    const anterior = i > 0 ? cierres[i - 1].valor : null;
    const cambio = anterior !== null ? c.valor - anterior : null;
    const cambioPct = anterior ? Math.round((cambio / Math.abs(anterior)) * 1000) / 10 : null;
    return { periodo: c.periodo, fecha: c.fecha, valor: c.valor, cambio, cambioPct };
  });
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

async function accionGetTenencias(req, res, sheets) {
  const { broker } = req.query || {};
  let rows = await leerTenencias(sheets, SHEET_ID);
  if (broker) rows = rows.filter(r => r.broker === broker);
  res.json({ rows });
}

async function accionImportarTenencias(req, res, sheets) {
  const { rows, broker, fecha } = req.body || {};
  if (!rows || !rows.length) return res.json({ ok: false, msg: 'Sin datos' });

  await ensureSheetExists(sheets, SHEET_ID, SHEET_TENENCIAS, HEADER_TENENCIAS);

  const existentesArr = await leerTenencias(sheets, SHEET_ID);
  const existentes = {};
  existentesArr.forEach(r => { existentes[claveDuplicadoTenencia(r)] = true; });

  const nuevas = [];
  rows.forEach(row => {
    const r = { fecha: row.fecha || fecha, broker: row.broker || broker, instrumento: row.instrumento || '' };
    const k = claveDuplicadoTenencia(r);
    if (existentes[k]) return;
    existentes[k] = true;
    nuevas.push([
      row.fecha || fecha, row.broker || broker, row.instrumento || '',
      row.cantidad || '', row.precio || '', row.moneda || '', row.total || '',
    ]);
  });

  if (nuevas.length > 0) {
    const getResp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `'${SHEET_TENENCIAS}'!A:A` });
    const lastRow = (getResp.data.values || []).length;
    const firstRow = Math.max(lastRow + 1, 2);
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `'${SHEET_TENENCIAS}'!A${firstRow}:G${firstRow + nuevas.length - 1}`,
      valueInputOption: 'RAW',
      requestBody: { values: nuevas },
    });
  }

  res.json({ ok: true, importadas: nuevas.length, duplicadas: rows.length - nuevas.length });
}
