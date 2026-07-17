// Usuarios habilitados y sus permisos por modulo, guardados en la hoja
// "Usuarios" de la misma planilla (a diferencia de COA, que usa Vercel Blob
// porque no tiene planilla propia). Mismo modelo de permisos que COA:
// rol admin (acceso total siempre) + nivel por modulo ninguno/lectura/escritura.
const { ensureSheetExists, getSheetGid } = require('./sheets');

const SHEET_USUARIOS = 'Usuarios';
const HEADER_USUARIOS = ['Email', 'Nombre', 'Rol', 'PermisosJSON', 'FechaAlta'];
const MODULOS = ['dashboard', 'movimientos', 'importar', 'presupuesto', 'inversiones', 'facturas'];
const NIVELES = ['ninguno', 'lectura', 'escritura'];

function permisosVacios() {
  const p = {};
  MODULOS.forEach(m => { p[m] = 'ninguno'; });
  return p;
}

function validarPermisos(permisos) {
  const out = permisosVacios();
  MODULOS.forEach(m => {
    const v = (permisos || {})[m];
    if (NIVELES.indexOf(v) >= 0) out[m] = v;
  });
  return out;
}

function fechaHoy() {
  const d = new Date();
  return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();
}

async function safeGet(sheets, spreadsheetId, range) {
  try {
    const resp = await sheets.spreadsheets.values.get({ spreadsheetId, range });
    return resp.data.values || [];
  } catch (e) {
    if (String(e.message || '').indexOf('Unable to parse range') >= 0) return []; // la hoja todavia no existe
    throw e;
  }
}

// Devuelve la lista de usuarios. Si la hoja esta vacia y hay un ADMIN_EMAIL
// configurado, siembra el primer usuario (admin) automaticamente.
async function leerUsuarios(sheets, SHEET_ID) {
  const data = await safeGet(sheets, SHEET_ID, `'${SHEET_USUARIOS}'!A2:E1000`);
  let usuarios = data.filter(r => r[0]).map((r, i) => ({
    fila:      i + 2,
    email:     (r[0] || '').trim().toLowerCase(),
    nombre:    (r[1] || '').trim(),
    rol:       (r[2] || 'usuario').trim(),
    permisos:  validarPermisos(safeParseJSON(r[3])),
    fechaAlta: (r[4] || '').trim(),
  }));

  if (usuarios.length === 0) {
    const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    if (!adminEmail) return [];
    await ensureSheetExists(sheets, SHEET_ID, SHEET_USUARIOS, HEADER_USUARIOS);
    const fecha = fechaHoy();
    const nombre = process.env.ADMIN_NOMBRE || 'Admin';
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `'${SHEET_USUARIOS}'!A:E`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [[adminEmail, nombre, 'admin', '{}', fecha]] },
    });
    usuarios = [{ fila: 2, email: adminEmail, nombre, rol: 'admin', permisos: permisosVacios(), fechaAlta: fecha }];
  }
  return usuarios;
}

function safeParseJSON(str) {
  try { return JSON.parse(str || '{}'); } catch (e) { return {}; }
}

function buscarPorEmail(usuarios, email) {
  const e = (email || '').trim().toLowerCase();
  return usuarios.find(u => u.email === e) || null;
}

// nivelRequerido: 'lectura' o 'escritura'. Un admin tiene acceso total siempre.
function tienePermiso(usuario, modulo, nivelRequerido) {
  if (!usuario) return false;
  if (usuario.rol === 'admin') return true;
  const nivel = (usuario.permisos || {})[modulo] || 'ninguno';
  if (nivelRequerido === 'lectura') return nivel === 'lectura' || nivel === 'escritura';
  if (nivelRequerido === 'escritura') return nivel === 'escritura';
  return false;
}

function permisosPublicos(usuario) {
  if (usuario.rol === 'admin') {
    const p = {};
    MODULOS.forEach(m => { p[m] = 'escritura'; });
    return p;
  }
  const p = permisosVacios();
  Object.assign(p, usuario.permisos || {});
  return p;
}

async function agregarUsuario(sheets, SHEET_ID, { email, nombre, permisos }) {
  await ensureSheetExists(sheets, SHEET_ID, SHEET_USUARIOS, HEADER_USUARIOS);
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `'${SHEET_USUARIOS}'!A:E`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[email, (nombre || '').trim() || email, 'usuario', JSON.stringify(validarPermisos(permisos)), fechaHoy()]] },
  });
}

async function actualizarUsuario(sheets, SHEET_ID, usuario) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `'${SHEET_USUARIOS}'!B${usuario.fila}:D${usuario.fila}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[usuario.nombre, usuario.rol, JSON.stringify(validarPermisos(usuario.permisos))]] },
  });
}

async function eliminarUsuario(sheets, SHEET_ID, usuario) {
  const gid = await getSheetGid(sheets, SHEET_ID, SHEET_USUARIOS);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { requests: [{ deleteDimension: { range: { sheetId: gid, dimension: 'ROWS', startIndex: usuario.fila - 1, endIndex: usuario.fila } } }] },
  });
}

module.exports = {
  MODULOS, NIVELES,
  leerUsuarios, buscarPorEmail, tienePermiso, permisosPublicos,
  agregarUsuario, actualizarUsuario, eliminarUsuario,
};
