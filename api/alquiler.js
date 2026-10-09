// Endpoint del modulo Alquiler (alquiler + cochera + expensas, una fila por
// mes), enrutado por ?action= — mismo patron dispatch que los demas modulos.
// Los datos viven en la hoja "BD" de una planilla propia (ALQUILER_SHEET_ID);
// los permisos de usuario vienen de la planilla principal (SHEET_ID).
const cors = require('../lib/cors');
const { isAuthenticated } = require('../lib/auth');
const { getSheetsClient, getDriveClientEscritura, SHEET_ID } = require('../lib/sheets');
const { leerUsuarios, buscarPorEmail, tienePermiso } = require('../lib/usuarios');
const {
  mesValido, asegurarHojaBD, leerRegistros, agregarRegistros, actualizarRegistro,
  eliminarFila, leerHistoricoPestanas, subirComprobante, quitarComprobante,
} = require('../lib/alquiler');

const ALQUILER_SHEET_ID = process.env.ALQUILER_SHEET_ID;
// Carpeta de Drive para los comprobantes de pago (la sube la cuenta personal
// via GOOGLE_DRIVE_REFRESH_TOKEN, igual que Quincho: el service account no
// tiene cuota de Drive).
const ALQUILER_COMPROBANTES_FOLDER_ID = process.env.ALQUILER_COMPROBANTES_FOLDER_ID;

const NIVEL_POR_ACCION = {
  'listar': 'lectura',
  'agregar': 'escritura', 'editar': 'escritura', 'eliminar': 'escritura',
  'importar-historico': 'escritura',
  'subir-comprobante': 'escritura', 'quitar-comprobante': 'escritura',
};

module.exports = async function(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const email = isAuthenticated(req);
  if (!email) return res.status(401).json({ error: 'No autenticado' });

  const action = (req.query || {}).action;
  try {
    if (!ALQUILER_SHEET_ID) return res.status(500).json({ error: 'Falta configurar ALQUILER_SHEET_ID' });
    const sheets = getSheetsClient();

    const usuarios = await leerUsuarios(sheets, SHEET_ID);
    const usuario = buscarPorEmail(usuarios, email);
    if (!usuario) return res.status(403).json({ error: 'Tu cuenta no tiene acceso a esta aplicación.' });
    const nivel = NIVEL_POR_ACCION[action];
    if (!nivel) return res.status(400).json({ error: 'accion desconocida: ' + action });
    if (!tienePermiso(usuario, 'alquiler', nivel)) {
      return res.status(403).json({ error: 'No tenés permiso para esta acción.' });
    }
    if (nivel === 'escritura' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    switch (action) {
      case 'listar':             return await accionListar(req, res, sheets);
      case 'agregar':            return await accionAgregar(req, res, sheets);
      case 'editar':             return await accionEditar(req, res, sheets);
      case 'eliminar':           return await accionEliminar(req, res, sheets);
      case 'importar-historico': return await accionImportarHistorico(req, res, sheets);
      case 'subir-comprobante':  return await accionSubirComprobante(req, res, sheets);
      case 'quitar-comprobante': return await accionQuitarComprobante(req, res, sheets);
    }
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, ok: false, msg: e.message });
  }
};

async function accionListar(req, res, sheets) {
  const registros = await leerRegistros(sheets, ALQUILER_SHEET_ID);
  res.json({ registros, comprobantesHabilitados: !!ALQUILER_COMPROBANTES_FOLDER_ID });
}

function validarRegistro(body) {
  const reg = {
    mes:          String(body.mes || '').trim(),
    alquiler:     Number(body.alquiler) || 0,
    cochera:      Number(body.cochera) || 0,
    expensas:     Number(body.expensas) || 0,
    otros:        Number(body.otros) || 0,
    detalleOtros: String(body.detalleOtros || '').trim().slice(0, 200),
    descuento:    Math.abs(Number(body.descuento) || 0),
    detalleDescuento: String(body.detalleDescuento || '').trim().slice(0, 200),
    fechaPago:    String(body.fechaPago || '').trim(),
    notas:        String(body.notas || '').trim().slice(0, 300),
  };
  if (!mesValido(reg.mes)) return { error: 'Mes inválido (formato AAAA-MM)' };
  if (!reg.alquiler && !reg.cochera && !reg.expensas && !reg.otros) return { error: 'Cargá al menos un monto' };
  if (reg.descuento && !reg.detalleDescuento) return { error: 'Poné el detalle del arreglo descontado' };
  return { reg };
}

async function accionAgregar(req, res, sheets) {
  const { reg, error } = validarRegistro(req.body || {});
  if (error) return res.json({ ok: false, msg: error });
  await asegurarHojaBD(sheets, ALQUILER_SHEET_ID);
  const existentes = await leerRegistros(sheets, ALQUILER_SHEET_ID);
  if (existentes.some(r => r.mes === reg.mes)) {
    return res.json({ ok: false, msg: 'Ese mes ya está cargado — editalo desde la tabla.' });
  }
  const fila = await agregarRegistros(sheets, ALQUILER_SHEET_ID, [reg], 'manual');
  res.json({ ok: true, fila });
}

async function accionEditar(req, res, sheets) {
  const body = req.body || {};
  const fila = parseInt(body.fila, 10);
  const { reg, error } = validarRegistro(body);
  if (error) return res.json({ ok: false, msg: error });
  const existentes = await leerRegistros(sheets, ALQUILER_SHEET_ID);
  const actual = existentes.find(r => r.fila === fila);
  if (!actual) return res.json({ ok: false, msg: 'No se encontró la fila (¿la planilla cambió?). Recargá e intentá de nuevo.' });
  if (existentes.some(r => r.mes === reg.mes && r.fila !== fila)) {
    return res.json({ ok: false, msg: 'Ya hay otro registro para ese mes.' });
  }
  await actualizarRegistro(sheets, ALQUILER_SHEET_ID, fila, reg, actual.origen);
  res.json({ ok: true });
}

async function accionEliminar(req, res, sheets) {
  const fila = parseInt((req.body || {}).fila, 10);
  if (!fila || fila < 2) return res.json({ ok: false, msg: 'Fila inválida' });
  await eliminarFila(sheets, ALQUILER_SHEET_ID, fila);
  res.json({ ok: true });
}

// Lee las pestañas por año y agrega a BD solo los meses que todavia no estan,
// asi se puede correr mas de una vez sin duplicar.
async function accionImportarHistorico(req, res, sheets) {
  await asegurarHojaBD(sheets, ALQUILER_SHEET_ID);
  const [{ pestanas, registros }, existentes] = await Promise.all([
    leerHistoricoPestanas(sheets, ALQUILER_SHEET_ID),
    leerRegistros(sheets, ALQUILER_SHEET_ID),
  ]);
  const ya = new Set(existentes.map(r => r.mes));
  const nuevos = registros.filter(r => !ya.has(r.mes));
  await agregarRegistros(sheets, ALQUILER_SHEET_ID, nuevos, 'historico');
  res.json({
    ok: true, pestanas,
    encontrados: registros.length,
    importados: nuevos.length,
    omitidos: registros.length - nuevos.length,
  });
}

async function accionSubirComprobante(req, res, sheets) {
  if (!ALQUILER_COMPROBANTES_FOLDER_ID) return res.json({ ok: false, msg: 'Falta configurar la carpeta de Drive (ALQUILER_COMPROBANTES_FOLDER_ID)' });
  const { fila, base64, mimeType, nombre, concepto } = req.body || {};
  const f = parseInt(fila, 10);
  if (!f || f < 2) return res.json({ ok: false, msg: 'Fila inválida' });
  if (!base64 || !mimeType) return res.json({ ok: false, msg: 'Falta el archivo' });
  if (!/^(image\/|application\/pdf$)/.test(mimeType)) return res.json({ ok: false, msg: 'Solo se aceptan fotos o PDF' });
  const comprobante = await subirComprobante(sheets, ALQUILER_SHEET_ID, getDriveClientEscritura(), ALQUILER_COMPROBANTES_FOLDER_ID,
    { fila: f, base64, mimeType, nombre, concepto });
  res.json({ ok: true, comprobante });
}

async function accionQuitarComprobante(req, res, sheets) {
  const { fila, id } = req.body || {};
  const f = parseInt(fila, 10);
  if (!f || f < 2 || !id) return res.json({ ok: false, msg: 'Datos inválidos' });
  await quitarComprobante(sheets, ALQUILER_SHEET_ID, f, String(id));
  res.json({ ok: true });
}
