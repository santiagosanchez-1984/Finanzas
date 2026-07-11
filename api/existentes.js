const cors = require('../lib/cors');
const { isAuthenticated } = require('../lib/auth');
const { getSheetsClient, SHEET_ID } = require('../lib/sheets');
const { SHEET_REGISTRO, parseMonto, claveDuplicado } = require('../lib/finanzas');

module.exports = async function(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'No autenticado' });

  try {
    const sheets = getSheetsClient();
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `'${SHEET_REGISTRO}'!A3:F5000`,
    });
    const data = resp.data.values || [];
    const keys = {};
    data.forEach(r => {
      const fechaRaw = r[0], desc = String(r[4] || '').trim(), montoRaw = r[5];
      if (!fechaRaw || !desc) return;
      const monto = parseMonto(montoRaw);
      keys[claveDuplicado(fechaRaw, desc, monto)] = true;
    });
    res.json(keys);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
};
