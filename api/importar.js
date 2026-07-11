const cors = require('../lib/cors');
const { isAuthenticated } = require('../lib/auth');
const { getSheetsClient, SHEET_ID } = require('../lib/sheets');
const { SHEET_REGISTRO, fechaToMes, fmtMonto, claveDuplicado, parseMonto } = require('../lib/finanzas');

module.exports = async function(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'No autenticado' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { rows, banco } = req.body || {};
    if (!rows || !rows.length) return res.json({ ok: false, msg: 'Sin datos' });

    const sheets = getSheetsClient();
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
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, msg: e.message });
  }
};
