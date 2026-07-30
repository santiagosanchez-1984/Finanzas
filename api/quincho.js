// Endpoint del modulo Quincho (etapas, materiales, presupuesto, pagos),
// enrutado por ?action= — mismo patron dispatch que los demas modulos.
// Los datos del modulo viven en una planilla propia (QUINCHO_SHEET_ID),
// separada de la planilla principal de Finanzas; los permisos de usuario
// siguen viniendo de la planilla principal (SHEET_ID), como el resto de la app.
const cors = require('../lib/cors');
const { isAuthenticated } = require('../lib/auth');
const { getSheetsClient, getDriveClientEscritura, ensureSheetExists, SHEET_ID } = require('../lib/sheets');
const { leerUsuarios, buscarPorEmail, tienePermiso } = require('../lib/usuarios');
const {
  SHEET_ETAPAS, SHEET_MATERIALES, SHEET_PRESUPUESTO, SHEET_PAGOS,
  HEADER_ETAPAS, HEADER_MATERIALES, HEADER_PRESUPUESTO, HEADER_PAGOS,
  CATEGORIAS_PAGO,
  leerEtapas, leerMateriales, leerPresupuesto, leerPagos,
  calcularTotalesEtapa, claveDuplicadoMaterial, subirImagenADrive,
  analizarMaterialConGemini, agregarEtapa, actualizarEtapa,
  actualizarPresupuesto, actualizarPago, eliminarFila,
} = require('../lib/quincho');

const QUINCHO_SHEET_ID = process.env.QUINCHO_SHEET_ID;
const QUINCHO_MATERIALES_FOLDER_ID = process.env.QUINCHO_MATERIALES_FOLDER_ID;

// Todo el modulo Quincho cae bajo un unico permiso ("quincho").
const NIVEL_POR_ACCION = {
  'etapas': 'lectura', 'crear-etapa': 'escritura', 'editar-etapa': 'escritura',
  'materiales': 'lectura', 'materiales-analizar': 'escritura', 'materiales-guardar': 'escritura', 'materiales-eliminar': 'escritura',
  'presupuesto': 'lectura', 'presupuesto-agregar': 'escritura', 'presupuesto-editar': 'escritura', 'presupuesto-eliminar': 'escritura',
  'pagos': 'lectura', 'pagos-agregar': 'escritura', 'pagos-editar': 'escritura', 'pagos-eliminar': 'escritura',
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
    if (nivel && !tienePermiso(usuario, 'quincho', nivel)) {
      return res.status(403).json({ error: 'No tenés permiso para esta acción.' });
    }

    switch (action) {
      case 'etapas':      return await accionEtapas(req, res, sheets);
      case 'crear-etapa':
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        return await accionCrearEtapa(req, res, sheets);
      case 'editar-etapa':
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        return await accionEditarEtapa(req, res, sheets);

      case 'materiales':          return await accionMateriales(req, res, sheets);
      case 'materiales-analizar':
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        return await accionMaterialesAnalizar(req, res);
      case 'materiales-guardar':
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        return await accionMaterialesGuardar(req, res, sheets);
      case 'materiales-eliminar':
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        return await accionEliminar(req, res, sheets, SHEET_MATERIALES);

      case 'presupuesto': return await accionPresupuesto(req, res, sheets);
      case 'presupuesto-agregar':
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        return await accionPresupuestoAgregar(req, res, sheets);
      case 'presupuesto-editar':
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        return await accionPresupuestoEditar(req, res, sheets);
      case 'presupuesto-eliminar':
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        return await accionEliminar(req, res, sheets, SHEET_PRESUPUESTO);

      case 'pagos': return await accionPagos(req, res, sheets);
      case 'pagos-agregar':
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        return await accionPagosAgregar(req, res, sheets);
      case 'pagos-editar':
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        return await accionPagosEditar(req, res, sheets);
      case 'pagos-eliminar':
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        return await accionEliminar(req, res, sheets, SHEET_PAGOS);

      default:
        return res.status(400).json({ error: 'accion desconocida: ' + action });
    }
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, ok: false, msg: e.message });
  }
};

async function accionEtapas(req, res, sheets) {
  const [etapas, materiales, presupuesto, pagos] = await Promise.all([
    leerEtapas(sheets, QUINCHO_SHEET_ID),
    leerMateriales(sheets, QUINCHO_SHEET_ID),
    leerPresupuesto(sheets, QUINCHO_SHEET_ID),
    leerPagos(sheets, QUINCHO_SHEET_ID),
  ]);
  const conTotales = etapas.map(e => Object.assign({}, e, calcularTotalesEtapa(e.id, materiales, presupuesto, pagos)));
  res.json({ etapas: conTotales });
}

async function accionCrearEtapa(req, res, sheets) {
  const { nombre, fecha, detalle } = req.body || {};
  if (!nombre || !nombre.trim()) return res.json({ ok: false, msg: 'Falta el nombre de la etapa' });
  await ensureSheetExists(sheets, QUINCHO_SHEET_ID, SHEET_ETAPAS, HEADER_ETAPAS);
  const etapa = await agregarEtapa(sheets, QUINCHO_SHEET_ID, { nombre: nombre.trim(), fecha, detalle });
  res.json({ ok: true, etapa });
}

async function accionEditarEtapa(req, res, sheets) {
  const { id, nombre, estado, fecha, detalle } = req.body || {};
  if (!id || !nombre || !nombre.trim()) return res.json({ ok: false, msg: 'Faltan datos obligatorios' });
  const ok = await actualizarEtapa(sheets, QUINCHO_SHEET_ID, { id, nombre: nombre.trim(), estado, fecha, detalle });
  if (!ok) return res.json({ ok: false, msg: 'No se encontró esa etapa' });
  res.json({ ok: true });
}

async function accionMateriales(req, res, sheets) {
  const { etapaId } = req.query || {};
  const rows = (await leerMateriales(sheets, QUINCHO_SHEET_ID)).filter(m => !etapaId || m.etapaId === etapaId);
  res.json({ rows });
}

async function accionMaterialesAnalizar(req, res) {
  const { base64, mimeType } = req.body || {};
  if (!base64 || !mimeType) return res.json({ ok: false, msg: 'Falta la imagen' });
  const datos = await analizarMaterialConGemini(base64, mimeType);
  const items = (Array.isArray(datos.items) ? datos.items : []).map(it => ({
    detalle: it.detalle || '', cantidad: it.cantidad || '', total: it.total || 0,
  }));
  res.json({
    ok: true,
    fecha: datos.fecha || '', proveedor: datos.proveedor || '', numeroFactura: datos.numeroFactura || '',
    total: datos.total || 0, items,
  });
}

// Guarda un item por fila (detalle/cantidad/total propios), todos con el
// mismo EtapaID/Fecha/Proveedor/NumeroFactura/DriveFileId (una compra puede
// tener varios items, pero es una sola foto/comprobante).
async function accionMaterialesGuardar(req, res, sheets) {
  const { etapaId, fecha, proveedor, numeroFactura, items, base64, mimeType } = req.body || {};
  const itemsValidos = (items || []).filter(it => it && it.detalle && it.total);
  if (!etapaId || !fecha || !itemsValidos.length) {
    return res.json({ ok: false, msg: 'Faltan datos obligatorios (fecha y al menos un ítem con detalle y total)' });
  }

  await ensureSheetExists(sheets, QUINCHO_SHEET_ID, SHEET_MATERIALES, HEADER_MATERIALES);

  const clave = claveDuplicadoMaterial({ etapaId, numeroFactura });
  if (clave) {
    const existentes = await leerMateriales(sheets, QUINCHO_SHEET_ID);
    const yaExiste = existentes.some(m => claveDuplicadoMaterial(m) === clave);
    if (yaExiste) return res.json({ ok: false, msg: 'Ya hay un material cargado con ese número de factura en esta etapa' });
  }

  let driveFileId = '', driveFileName = '', origen = 'manual';
  if (base64 && mimeType) {
    if (!QUINCHO_MATERIALES_FOLDER_ID) throw new Error('Falta configurar QUINCHO_MATERIALES_FOLDER_ID');
    const nombreArchivo = (fecha || 'material') + ' - ' + (proveedor || 'sin proveedor') + '.' + (mimeType.split('/')[1] || 'jpg');
    const subida = await subirImagenADrive(getDriveClientEscritura(), QUINCHO_MATERIALES_FOLDER_ID, base64, mimeType, nombreArchivo);
    driveFileId = subida.driveFileId;
    driveFileName = subida.driveFileName;
    origen = 'foto';
  }

  const ahora = new Date();
  const fechaCarga = String(ahora.getDate()).padStart(2, '0') + '/' + String(ahora.getMonth() + 1).padStart(2, '0') + '/' + ahora.getFullYear();

  const filas = itemsValidos.map(it => [
    etapaId, fecha, proveedor || '', numeroFactura || '', it.detalle, it.total,
    driveFileId, driveFileName, origen, fechaCarga, it.cantidad || '',
  ]);

  await sheets.spreadsheets.values.append({
    spreadsheetId: QUINCHO_SHEET_ID,
    range: `'${SHEET_MATERIALES}'!A:K`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: filas },
  });

  res.json({ ok: true, itemsGuardados: filas.length });
}

async function accionPresupuesto(req, res, sheets) {
  const { etapaId } = req.query || {};
  const rows = (await leerPresupuesto(sheets, QUINCHO_SHEET_ID)).filter(p => !etapaId || p.etapaId === etapaId);
  res.json({ rows });
}

async function accionPresupuestoAgregar(req, res, sheets) {
  const { etapaId, fecha, detalle, monto } = req.body || {};
  if (!etapaId || !detalle || !monto) return res.json({ ok: false, msg: 'Faltan datos obligatorios' });
  await ensureSheetExists(sheets, QUINCHO_SHEET_ID, SHEET_PRESUPUESTO, HEADER_PRESUPUESTO);
  await sheets.spreadsheets.values.append({
    spreadsheetId: QUINCHO_SHEET_ID,
    range: `'${SHEET_PRESUPUESTO}'!A:D`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[etapaId, fecha || '', detalle, monto]] },
  });
  res.json({ ok: true });
}

async function accionPresupuestoEditar(req, res, sheets) {
  const { fila, fecha, detalle, monto } = req.body || {};
  if (!fila || !detalle || !monto) return res.json({ ok: false, msg: 'Faltan datos obligatorios' });
  await actualizarPresupuesto(sheets, QUINCHO_SHEET_ID, { fila, fecha, detalle, monto });
  res.json({ ok: true });
}

async function accionPagos(req, res, sheets) {
  const { etapaId } = req.query || {};
  const rows = (await leerPagos(sheets, QUINCHO_SHEET_ID)).filter(p => !etapaId || p.etapaId === etapaId);
  res.json({ rows });
}

async function accionPagosAgregar(req, res, sheets) {
  const { etapaId, fecha, mes, detalle, monto, categoria } = req.body || {};
  if (!etapaId || !fecha || !monto) return res.json({ ok: false, msg: 'Faltan datos obligatorios' });
  const cat = CATEGORIAS_PAGO.indexOf(categoria) >= 0 ? categoria : 'Mano de Obra';
  await ensureSheetExists(sheets, QUINCHO_SHEET_ID, SHEET_PAGOS, HEADER_PAGOS);
  await sheets.spreadsheets.values.append({
    spreadsheetId: QUINCHO_SHEET_ID,
    range: `'${SHEET_PAGOS}'!A:F`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[etapaId, fecha, mes || '', detalle || '', monto, cat]] },
  });
  res.json({ ok: true });
}

async function accionPagosEditar(req, res, sheets) {
  const { fila, fecha, mes, detalle, monto, categoria } = req.body || {};
  if (!fila || !fecha || !monto) return res.json({ ok: false, msg: 'Faltan datos obligatorios' });
  await actualizarPago(sheets, QUINCHO_SHEET_ID, { fila, fecha, mes, detalle, monto, categoria });
  res.json({ ok: true });
}

async function accionEliminar(req, res, sheets, sheetName) {
  const { fila } = req.body || {};
  if (!fila) return res.json({ ok: false, msg: 'Falta la fila a eliminar' });
  const eliminada = await eliminarFila(sheets, QUINCHO_SHEET_ID, sheetName, fila);
  res.json({ ok: eliminada });
}
