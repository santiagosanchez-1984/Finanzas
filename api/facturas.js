// Endpoint del modulo Facturas IVA (listar/validar-nuevas/guardar), enrutado
// por ?action= — mismo patron dispatch que api/finanzas.js y api/inversiones.js
// (limite de 12 Serverless Functions en Vercel Hobby).
const cors = require('../lib/cors');
const { isAuthenticated } = require('../lib/auth');
const { getSheetsClient, getDriveClient, ensureSheetExists, SHEET_ID } = require('../lib/sheets');
const { leerUsuarios, buscarPorEmail, tienePermiso } = require('../lib/usuarios');
const {
  SHEET_FACTURAS, HEADER_FACTURAS, MAX_POR_LOTE,
  leerFacturas, listarArchivosDrive, descargarArchivoBase64,
  analizarFacturaConGemini, claveDuplicadoFactura, actualizarFactura,
  claveDuplicadoFacturaLogica, agruparDuplicados, eliminarFactura,
} = require('../lib/facturas');

const DRIVE_FOLDER_ID = process.env.FACTURAS_DRIVE_FOLDER_ID;

// Todo el modulo Facturas IVA cae bajo un unico permiso ("facturas").
const NIVEL_POR_ACCION = {
  'listar': 'lectura', 'validar-nuevas': 'escritura', 'guardar': 'escritura', 'editar': 'escritura',
  'duplicados': 'lectura', 'eliminar': 'escritura',
};

module.exports = async function(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const email = isAuthenticated(req);
  if (!email) return res.status(401).json({ error: 'No autenticado' });

  const action = (req.query || {}).action;
  try {
    const sheets = getSheetsClient();

    const usuarios = await leerUsuarios(sheets, SHEET_ID);
    const usuario = buscarPorEmail(usuarios, email);
    if (!usuario) return res.status(403).json({ error: 'Tu cuenta no tiene acceso a esta aplicación.' });
    const nivel = NIVEL_POR_ACCION[action];
    if (nivel && !tienePermiso(usuario, 'facturas', nivel)) {
      return res.status(403).json({ error: 'No tenés permiso para esta acción.' });
    }

    switch (action) {
      case 'listar':
        return await accionListar(req, res, sheets);
      case 'validar-nuevas':
        return await accionValidarNuevas(req, res, sheets);
      case 'guardar':
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        return await accionGuardar(req, res, sheets);
      case 'editar':
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        return await accionEditar(req, res, sheets);
      case 'duplicados':
        return await accionDuplicados(req, res, sheets);
      case 'eliminar':
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        return await accionEliminar(req, res, sheets);
      default:
        return res.status(400).json({ error: 'accion desconocida: ' + action });
    }
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, ok: false, msg: e.message });
  }
};

async function accionListar(req, res, sheets) {
  const rows = await leerFacturas(sheets, SHEET_ID);
  rows.sort((a, b) => {
    const da = a.fecha.split('/').reverse().join('');
    const db = b.fecha.split('/').reverse().join('');
    return db > da ? 1 : db < da ? -1 : 0;
  });
  res.json({ rows });
}

async function accionValidarNuevas(req, res, sheets) {
  if (!DRIVE_FOLDER_ID) return res.status(500).json({ error: 'Falta configurar FACTURAS_DRIVE_FOLDER_ID' });
  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'Falta configurar GEMINI_API_KEY' });

  const drive = getDriveClient();
  const archivos = await listarArchivosDrive(drive, DRIVE_FOLDER_ID);

  const existentes = await leerFacturas(sheets, SHEET_ID);
  const yaProcesados = {};
  existentes.forEach(r => { yaProcesados[claveDuplicadoFactura(r)] = true; });

  const nuevos = archivos.filter(a => !yaProcesados[a.id]);
  const lote = nuevos.slice(0, MAX_POR_LOTE);

  // En paralelo (no secuencial): son llamadas de red independientes
  // (Drive + Gemini por archivo) y 8 en secuencia superan facil el
  // maxDuration de 60s de la funcion (Vercel corta con 504 y el frontend
  // recibe HTML en vez de JSON). En paralelo el tiempo total queda acotado
  // por la llamada mas lenta, no por la suma de todas.
  const procesadas = await Promise.all(lote.map(async archivo => {
    const base = {
      driveFileId: archivo.id, driveFileName: archivo.name,
      fecha: '', proveedor: '', cuit: '', tipoFactura: '', numeroFactura: '',
      neto: 0, iva: 0, impInterno: 0, idc: 0, total: 0, moneda: 'ARS', detalle: '', error: null,
    };
    try {
      const base64 = await descargarArchivoBase64(drive, archivo.id);
      const datos = await analizarFacturaConGemini(base64, archivo.mimeType);
      return Object.assign(base, {
        fecha: datos.fecha || '', proveedor: datos.proveedor || '', cuit: datos.cuit || '',
        tipoFactura: datos.tipoFactura || '', numeroFactura: datos.numeroFactura || '',
        neto: datos.neto || 0, iva: datos.iva || 0, impInterno: datos.impInterno || 0, idc: datos.idc || 0,
        total: datos.total || 0, moneda: datos.moneda || 'ARS', detalle: datos.detalle || '',
      });
    } catch (e) {
      return Object.assign(base, { error: e.message });
    }
  }));

  // Marca como posible duplicado (mismo CUIT + Nro. Factura ya guardado) para
  // que el usuario lo vea en el preview antes de decidir guardarlo o no.
  const clavesExistentes = {};
  existentes.forEach(r => { clavesExistentes[claveDuplicadoFacturaLogica(r)] = true; });
  procesadas.forEach(f => {
    const clave = claveDuplicadoFacturaLogica(f);
    f.posibleDuplicado = !!(clave && clavesExistentes[clave]);
  });

  res.json({ ok: true, procesadas, totalNuevos: nuevos.length, pendientes: nuevos.length - lote.length });
}

async function accionGuardar(req, res, sheets) {
  const { facturas } = req.body || {};
  if (!facturas || !facturas.length) return res.json({ ok: false, msg: 'Sin datos' });

  await ensureSheetExists(sheets, SHEET_ID, SHEET_FACTURAS, HEADER_FACTURAS);

  const existentesArr = await leerFacturas(sheets, SHEET_ID);
  const existentes = {};
  existentesArr.forEach(r => { existentes[claveDuplicadoFactura(r)] = true; });
  const clavesPorNumero = {};
  existentesArr.forEach(r => {
    const clave = claveDuplicadoFacturaLogica(r);
    if (clave) clavesPorNumero[clave] = true;
  });

  const ahora = new Date();
  const fechaCarga = String(ahora.getDate()).padStart(2, '0') + '/' + String(ahora.getMonth() + 1).padStart(2, '0') + '/' + ahora.getFullYear();

  const nuevas = [];
  let duplicadasPorNumero = 0;
  facturas.forEach(f => {
    if (!f.driveFileId || existentes[f.driveFileId]) return;
    existentes[f.driveFileId] = true;

    // Validacion por Nro. Factura: el numero de comprobante es unico (dentro
    // de un mismo CUIT emisor), asi que si ya hay una factura guardada con el
    // mismo CUIT+numero, esta es la misma factura subida de nuevo (otra foto,
    // el PDF ademas de la foto, etc.) — no se carga, salvo que no se pudo leer
    // CUIT o numero (en ese caso no hay forma de afirmar que es duplicado).
    const claveNumero = claveDuplicadoFacturaLogica(f);
    if (claveNumero && clavesPorNumero[claveNumero]) { duplicadasPorNumero++; return; }
    if (claveNumero) clavesPorNumero[claveNumero] = true;

    nuevas.push([
      f.driveFileId, f.driveFileName || '', f.fecha || '', f.proveedor || '', f.cuit || '',
      f.tipoFactura || '', f.numeroFactura || '', f.neto || 0, f.iva || 0, f.impInterno || 0, f.idc || 0,
      f.total || 0, f.moneda || 'ARS', f.detalle || '', fechaCarga,
    ]);
  });

  if (nuevas.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `'${SHEET_FACTURAS}'!A:O`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: nuevas },
    });
  }

  const duplicadasPorArchivo = facturas.length - nuevas.length - duplicadasPorNumero;
  res.json({
    ok: true, guardadas: nuevas.length, duplicadas: facturas.length - nuevas.length,
    duplicadasPorNumero, duplicadasPorArchivo,
  });
}

async function accionEditar(req, res, sheets) {
  const { driveFileId } = req.body || {};
  if (!driveFileId) return res.json({ ok: false, msg: 'Falta driveFileId' });
  const actualizado = await actualizarFactura(sheets, SHEET_ID, req.body);
  if (!actualizado) return res.json({ ok: false, msg: 'No se encontró esa factura' });
  res.json({ ok: true });
}

// Devuelve los grupos de facturas duplicadas ya guardadas (mismo CUIT + Nro.
// Factura, cargadas mas de una vez desde archivos distintos).
async function accionDuplicados(req, res, sheets) {
  const rows = await leerFacturas(sheets, SHEET_ID);
  const grupos = agruparDuplicados(rows);
  res.json({ grupos, totalGrupos: grupos.length, totalFilasDuplicadas: grupos.reduce((a, g) => a + g.filas.length - 1, 0) });
}

async function accionEliminar(req, res, sheets) {
  const { driveFileId } = req.body || {};
  if (!driveFileId) return res.json({ ok: false, msg: 'Falta driveFileId' });
  const eliminada = await eliminarFactura(sheets, SHEET_ID, driveFileId);
  if (!eliminada) return res.json({ ok: false, msg: 'No se encontró esa factura' });
  res.json({ ok: true });
}
