const cors = require('../lib/cors');
const { isAuthenticated } = require('../lib/auth');
const { getSheetsClient, SHEET_ID } = require('../lib/sheets');
const { leerTodas } = require('../lib/finanzas');

module.exports = async function(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'No autenticado' });

  try {
    const { anio, mes, banco, cat, subcat } = req.query || {};
    const sheets = getSheetsClient();
    let rows = await leerTodas(sheets, SHEET_ID);

    if (anio)   rows = rows.filter(r => r.mes && r.mes.startsWith(anio));
    if (mes)    rows = rows.filter(r => r.mes === mes);
    if (banco)  rows = rows.filter(r => r.banco === banco);
    if (cat)    rows = rows.filter(r => r.categoria === cat);
    if (subcat) rows = rows.filter(r => r.subcat === subcat);

    let ingresos = 0, egresos = 0;
    const porMes = {}, porCatEgreso = {}, porCatIngreso = {}, porBanco = {}, porSubcatMes = {};

    rows.forEach(r => {
      const m = r.monto;
      if (r.tipo === 'INGRESO') {
        ingresos += m;
        porCatIngreso[r.categoria] = (porCatIngreso[r.categoria] || 0) + m;
      } else if (r.tipo === 'EGRESO') {
        egresos += m;
        porCatEgreso[r.categoria] = (porCatEgreso[r.categoria] || 0) + m;
        if (r.mes) {
          const scKey = r.categoria + '|' + (r.subcat || 'Sin subcat');
          if (!porSubcatMes[r.mes]) porSubcatMes[r.mes] = {};
          porSubcatMes[r.mes][scKey] = (porSubcatMes[r.mes][scKey] || 0) + m;
        }
      }
      if (r.mes) {
        if (!porMes[r.mes]) porMes[r.mes] = { ing: 0, egr: 0 };
        if (r.tipo === 'INGRESO') porMes[r.mes].ing += m;
        if (r.tipo === 'EGRESO')  porMes[r.mes].egr += m;
      }
      if (r.banco) porBanco[r.banco] = (porBanco[r.banco] || 0) + 1;
    });

    const balance   = ingresos - egresos;
    const pctAhorro = ingresos > 0 ? Math.round(balance / ingresos * 1000) / 10 : 0;
    const recientes = rows.slice(-15).reverse();

    res.json({
      ingresos, egresos, balance, pctAhorro,
      total: rows.length,
      porMes, porCatEgreso, porCatIngreso, porBanco, porSubcatMes, recientes,
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
};
