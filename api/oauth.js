// Login con Google (OAuth2/OIDC), enrutado por ?action=. Mismo patron que
// el proyecto COA: action=start redirige a la pantalla de consentimiento
// de Google; action=callback intercambia el "code" por un id_token, lo
// valida contra el endpoint de Google (sin librerias externas) y abre
// sesion si el email esta en la hoja "Usuarios".
const { setSessionCookie } = require('../lib/auth');
const { getSheetsClient, SHEET_ID } = require('../lib/sheets');
const { leerUsuarios, buscarPorEmail } = require('../lib/usuarios');

function baseUrl(req) {
  var proto = req.headers['x-forwarded-proto'] || (process.env.VERCEL ? 'https' : 'http');
  var host = req.headers.host;
  return proto + '://' + host;
}

module.exports = async function(req, res) {
  const action = (req.query || {}).action;
  const redirectUri = baseUrl(req) + '/api/oauth?action=callback';

  try {
    if (action === 'start') {
      const params = new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        prompt: 'select_account',
      });
      res.writeHead(302, { Location: 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString() });
      return res.end();
    }

    // Autorizacion UNICA (manual, para el admin) que le pide a Drive permiso
    // de escritura sobre la cuenta personal de Google y devuelve un refresh
    // token para pegar en GOOGLE_DRIVE_REFRESH_TOKEN. Necesario porque los
    // service accounts no tienen cuota de almacenamiento propia y no pueden
    // crear archivos nuevos (ver modulo Quincho) — subiendo con este refresh
    // token, el archivo cuenta contra la cuota personal del usuario.
    if (action === 'drive-start') {
      const params = new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'https://www.googleapis.com/auth/drive',
        access_type: 'offline',
        prompt: 'consent',
        state: 'drive',
      });
      res.writeHead(302, { Location: 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString() });
      return res.end();
    }

    if (action === 'callback') {
      const { code, error, state } = req.query || {};
      if (error || !code) {
        res.writeHead(302, { Location: '/?error=google_cancelado' });
        return res.end();
      }

      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      });
      const tokenData = await tokenRes.json();

      if (state === 'drive') {
        if (!tokenRes.ok || !tokenData.refresh_token) {
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          return res.send('<p>No se recibió refresh_token. Revocá el acceso previo de esta app en ' +
            '<a href="https://myaccount.google.com/permissions" target="_blank">myaccount.google.com/permissions</a> ' +
            'y probá de nuevo (Google solo lo manda la primera vez que se autoriza).</p><pre>' +
            JSON.stringify(tokenData, null, 2) + '</pre>');
        }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send('<p>✓ Listo. Copiá este valor en <code>GOOGLE_DRIVE_REFRESH_TOKEN</code> (.env y Vercel):</p>' +
          '<textarea style="width:100%;height:80px">' + tokenData.refresh_token + '</textarea>');
      }

      if (!tokenRes.ok || !tokenData.id_token) {
        res.writeHead(302, { Location: '/?error=google_token' });
        return res.end();
      }

      // Verificacion del id_token delegada al propio endpoint de Google
      // (chequea firma, expiracion y devuelve las claims ya decodificadas).
      const infoRes = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(tokenData.id_token));
      const info = await infoRes.json();
      if (!infoRes.ok || info.aud !== process.env.GOOGLE_CLIENT_ID || info.email_verified !== 'true' || !info.email) {
        res.writeHead(302, { Location: '/?error=google_invalido' });
        return res.end();
      }

      const email = info.email.trim().toLowerCase();
      const sheets = getSheetsClient();
      const usuarios = await leerUsuarios(sheets, SHEET_ID);
      const usuario = buscarPorEmail(usuarios, email);
      if (!usuario) {
        res.writeHead(302, { Location: '/?error=sin_acceso' });
        return res.end();
      }

      setSessionCookie(res, email);
      res.writeHead(302, { Location: '/' });
      return res.end();
    }

    res.status(400).json({ error: 'accion desconocida: ' + action });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
