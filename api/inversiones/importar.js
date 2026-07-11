const cors = require('../../lib/cors');
const { isAuthenticated } = require('../../lib/auth');
const { getSheetsClient, ensureSheetExists, SHEET_ID } = require('../../lib/sheets');
const { SHEET_MOVIMIENTOS, HEADER_MOVIMIENTOS, leerMovimientos, claveDuplicadoInversion } = require('../../lib/inversiones');

module.exports = async function(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'No autenticado' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { rows, broker } = req.body || {};
    if (!rows || !rows.length) return res.json({ ok: false, msg: 'Sin datos' });

    const sheets = getSheetsClient();
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
        row.fecha,
        row.broker || broker,
        row.tipo || '',
        row.instrumento || '',
        row.moneda || '',
        row.cantidad || '',
        row.precio || '',
        row.montoBruto || '',
        row.comision || '',
        row.total || '',
        row.notas || '',
      ]);
    });

    if (nuevas.length > 0) {
      const getResp = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `'${SHEET_MOVIMIENTOS}'!A:A`,
      });
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
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, msg: e.message });
  }
};
