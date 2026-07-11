const cors = require('../../lib/cors');
const { isAuthenticated } = require('../../lib/auth');
const { getSheetsClient, SHEET_ID } = require('../../lib/sheets');
const { leerMovimientos, claveDuplicadoInversion } = require('../../lib/inversiones');

module.exports = async function(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'No autenticado' });

  try {
    const sheets = getSheetsClient();
    const rows = await leerMovimientos(sheets, SHEET_ID);
    const keys = {};
    rows.forEach(r => { keys[claveDuplicadoInversion(r)] = true; });
    res.json(keys);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
};
