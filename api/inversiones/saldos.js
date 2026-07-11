const cors = require('../../lib/cors');
const { isAuthenticated } = require('../../lib/auth');
const { getSheetsClient, ensureSheetExists, SHEET_ID } = require('../../lib/sheets');
const { SHEET_SALDOS, HEADER_SALDOS, leerSaldos } = require('../../lib/inversiones');

module.exports = async function(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'No autenticado' });

  try {
    const sheets = getSheetsClient();

    if (req.method === 'POST') {
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
      return res.json({ ok: true });
    }

    const rows = await leerSaldos(sheets, SHEET_ID);
    res.json({ rows });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, ok: false, msg: e.message });
  }
};
