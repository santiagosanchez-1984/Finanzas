const cors = require('../lib/cors');
const { isAuthenticated } = require('../lib/auth');
const { getSheetsClient, getSheetGid, SHEET_ID } = require('../lib/sheets');
const { SHEET_REGISTRO, parseMonto } = require('../lib/finanzas');

module.exports = async function(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'No autenticado' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const sheets = getSheetsClient();
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `'${SHEET_REGISTRO}'!A3:F5000`,
    });
    const data = resp.data.values || [];
    const vistos = {};
    const filasABorrar = [];

    data.forEach((r, i) => {
      const desc = String(r[4] || '').trim();
      if (!desc) return;
      const monto = parseMonto(r[5]);
      const k = desc.substring(0, 40).toLowerCase() + '|' + Math.round(Math.abs(monto));
      if (vistos[k]) filasABorrar.push(i + 3); // fila real en la hoja
      else vistos[k] = true;
    });

    if (filasABorrar.length > 0) {
      const gid = await getSheetGid(sheets, SHEET_ID, SHEET_REGISTRO);
      // Borrar de abajo hacia arriba para no correr los indices
      const requests = filasABorrar
        .sort((a, b) => b - a)
        .map(fila => ({
          deleteDimension: {
            range: { sheetId: gid, dimension: 'ROWS', startIndex: fila - 1, endIndex: fila },
          },
        }));
      await sheets.spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID, requestBody: { requests } });
    }

    res.json({ ok: true, eliminadas: filasABorrar.length });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, msg: e.message });
  }
};
