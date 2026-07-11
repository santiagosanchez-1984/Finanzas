const cors = require('../lib/cors');
const { isAuthenticated } = require('../lib/auth');
const { getSheetsClient, getSheetGid, SHEET_ID } = require('../lib/sheets');
const { SHEET_PRESUPUESTO, parseMonto } = require('../lib/finanzas');

module.exports = async function(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'No autenticado' });

  try {
    const sheets = getSheetsClient();
    const gid = await getSheetGid(sheets, SHEET_ID, SHEET_PRESUPUESTO);
    if (gid === null) return res.json([]);

    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `'${SHEET_PRESUPUESTO}'!A2:F200`,
    });
    const data = resp.data.values || [];
    const result = data
      .filter(r => r[0] && r[1])
      .map(r => ({
        categoria:   r[0],
        presupuesto: parseMonto(r[1]),
        gastado:     parseMonto(r[2]),
        diferencia:  parseMonto(r[3]),
        pctUsado:    r[4],
        estado:      r[5],
      }));
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
};
