const cors = require('../lib/cors');
const { isAuthenticated } = require('../lib/auth');
const { getSheetsClient, SHEET_ID } = require('../lib/sheets');
const { leerTodas } = require('../lib/finanzas');

module.exports = async function(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'No autenticado' });

  try {
    const f = req.query || {};
    const sheets = getSheetsClient();
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
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
};
