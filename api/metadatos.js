const cors = require('../lib/cors');
const { isAuthenticated } = require('../lib/auth');
const { getSheetsClient, SHEET_ID } = require('../lib/sheets');
const { leerTodas } = require('../lib/finanzas');

module.exports = async function(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'No autenticado' });

  try {
    const sheets = getSheetsClient();
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
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
};
