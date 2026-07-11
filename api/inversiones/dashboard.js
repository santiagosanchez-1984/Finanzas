const cors = require('../../lib/cors');
const { isAuthenticated } = require('../../lib/auth');
const { getSheetsClient, SHEET_ID } = require('../../lib/sheets');
const { leerMovimientos, leerSaldos } = require('../../lib/inversiones');

module.exports = async function(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'No autenticado' });

  try {
    const { broker } = req.query || {};
    const sheets = getSheetsClient();
    let movs   = await leerMovimientos(sheets, SHEET_ID);
    let saldos = await leerSaldos(sheets, SHEET_ID);

    if (broker) { movs = movs.filter(m => m.broker === broker); saldos = saldos.filter(s => s.broker === broker); }

    const porBroker = {};
    function bucket(b) {
      if (!porBroker[b]) porBroker[b] = {
        compras: 0, ventas: 0, comisiones: 0, renta: 0,
        cauctionColocada: 0, cauctionTomada: 0, transferenciasIn: 0, transferenciasOut: 0,
        movimientos: 0,
      };
      return porBroker[b];
    }

    movs.forEach(m => {
      const b = bucket(m.broker);
      b.movimientos++;
      b.comisiones += Math.abs(m.comision);
      // Clasifica según el vocabulario normalizado que produce cada parser de
      // broker (ver normalizarTipoCocos en el frontend), no la terminología
      // cruda del extracto original — así funciona igual para cualquier broker.
      const t = m.tipo.toLowerCase();
      if (t.indexOf('compra') >= 0)                b.compras += Math.abs(m.total);
      else if (t.indexOf('venta') >= 0)            b.ventas += Math.abs(m.total);
      else if (t.indexOf('colocadora') >= 0)       b.cauctionColocada += Math.abs(m.total);
      else if (t.indexOf('caucion') >= 0)          b.cauctionTomada += Math.abs(m.total);
      else if (t.indexOf('renta') >= 0 || t.indexOf('amortizacion') >= 0 || t.indexOf('rendimiento') >= 0 || t.indexOf('dividendo') >= 0) b.renta += Math.abs(m.total);
      else if (t.indexOf('entrada') >= 0 || (t.indexOf('transfer') >= 0 && m.total > 0)) b.transferenciasIn += Math.abs(m.total);
      else if (t.indexOf('salida') >= 0 || (t.indexOf('transfer') >= 0 && m.total < 0))  b.transferenciasOut += Math.abs(m.total);
    });

    // Ultimo saldo cargado por broker+moneda
    const ultimoSaldo = {};
    saldos.forEach(s => {
      const k = s.broker + '|' + s.moneda;
      if (!ultimoSaldo[k] || s.fecha > ultimoSaldo[k].fecha) ultimoSaldo[k] = s;
    });

    // Evolucion de saldos (para grafico), agrupado por fecha+broker+moneda
    const evolucion = saldos
      .slice()
      .sort((a, b) => {
        const da = a.fecha.split('/').reverse().join('');
        const db = b.fecha.split('/').reverse().join('');
        return da < db ? -1 : da > db ? 1 : 0;
      });

    res.json({
      porBroker,
      ultimoSaldo,
      evolucion,
      totalMovimientos: movs.length,
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
};
