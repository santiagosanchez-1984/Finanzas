const cors = require('../lib/cors');
const { checkCredenciales, setSessionCookie } = require('../lib/auth');

module.exports = async function(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, msg: 'Method not allowed' });

  const { usuario, clave } = req.body || {};
  if (checkCredenciales(usuario, clave)) {
    setSessionCookie(res);
    return res.json({ ok: true });
  }
  res.status(401).json({ ok: false, msg: 'Usuario o contraseña incorrectos' });
};
