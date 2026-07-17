// Alta/edicion de usuarios habilitados y sus permisos por modulo, enrutado
// por ?action=. Solo un admin puede listar/agregar/editar/borrar; cualquier
// usuario logueado puede pedir su propio perfil (action=me).
const cors = require('../lib/cors');
const { isAuthenticated } = require('../lib/auth');
const { getSheetsClient, SHEET_ID } = require('../lib/sheets');
const { leerUsuarios, buscarPorEmail, permisosPublicos, agregarUsuario, actualizarUsuario, eliminarUsuario } = require('../lib/usuarios');

module.exports = async function(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const email = isAuthenticated(req);
  if (!email) return res.status(401).json({ error: 'No autenticado' });

  const action = (req.query || {}).action;

  try {
    const sheets = getSheetsClient();
    const usuarios = await leerUsuarios(sheets, SHEET_ID);
    const yo = buscarPorEmail(usuarios, email);
    if (!yo) return res.status(403).json({ error: 'Tu cuenta no tiene acceso a esta aplicación.' });

    if (action === 'me') {
      return res.json({ email: yo.email, nombre: yo.nombre, rol: yo.rol, permisos: permisosPublicos(yo) });
    }

    if (yo.rol !== 'admin') return res.status(403).json({ error: 'Solo un administrador puede gestionar usuarios.' });

    switch (action) {
      case 'list': {
        res.json({ usuarios: usuarios.map(u => ({ email: u.email, nombre: u.nombre, rol: u.rol, permisos: permisosPublicos(u) })) });
        return;
      }
      case 'add': {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        const { email: nuevoEmail, nombre, permisos } = req.body || {};
        const limpio = (nuevoEmail || '').trim().toLowerCase();
        if (!limpio || limpio.indexOf('@') === -1) return res.status(400).json({ error: 'Email invalido' });
        if (buscarPorEmail(usuarios, limpio)) return res.status(409).json({ error: 'Ese email ya esta cargado' });
        await agregarUsuario(sheets, SHEET_ID, { email: limpio, nombre, permisos });
        res.json({ ok: true });
        return;
      }
      case 'update': {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        const { email: objetivoEmail, nombre, permisos } = req.body || {};
        const objetivo = buscarPorEmail(usuarios, objetivoEmail);
        if (!objetivo) return res.status(404).json({ error: 'Usuario no encontrado' });
        if (objetivo.rol === 'admin') return res.status(400).json({ error: 'No se puede editar los permisos de un administrador' });
        objetivo.nombre = (nombre || '').trim() || objetivo.nombre;
        objetivo.permisos = permisos;
        await actualizarUsuario(sheets, SHEET_ID, objetivo);
        res.json({ ok: true });
        return;
      }
      case 'remove': {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
        const { email: objetivoEmail } = req.body || {};
        const objetivo = buscarPorEmail(usuarios, objetivoEmail);
        if (!objetivo) return res.status(404).json({ error: 'Usuario no encontrado' });
        if (objetivo.rol === 'admin') return res.status(400).json({ error: 'No se puede eliminar a un administrador' });
        await eliminarUsuario(sheets, SHEET_ID, objetivo);
        res.json({ ok: true });
        return;
      }
      default:
        res.status(400).json({ error: 'accion desconocida: ' + action });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
