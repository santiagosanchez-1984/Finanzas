const crypto = require('crypto');

const COOKIE_NAME = 'finanzas_session';
const MAX_AGE_SEC = 60 * 60 * 24 * 30; // 30 dias

function sign(payload) {
  return crypto.createHmac('sha256', process.env.AUTH_SECRET).update(payload).digest('hex');
}

function makeToken() {
  var expira = String(Date.now() + MAX_AGE_SEC * 1000);
  return expira + '.' + sign(expira);
}

function verifyToken(token) {
  if (!token) return false;
  var parts = token.split('.');
  if (parts.length !== 2) return false;
  var expira = parts[0];
  var firma = parts[1];
  var esperada = sign(expira);
  var bufA = Buffer.from(firma);
  var bufB = Buffer.from(esperada);
  if (bufA.length !== bufB.length) return false;
  if (!crypto.timingSafeEqual(bufA, bufB)) return false;
  return Date.now() < parseInt(expira, 10);
}

function parseCookies(req) {
  var header = req.headers.cookie || '';
  var out = {};
  header.split(';').forEach(function(pair) {
    var idx = pair.indexOf('=');
    if (idx < 0) return;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

function isAuthenticated(req) {
  var cookies = parseCookies(req);
  return verifyToken(cookies[COOKIE_NAME]);
}

function checkCredenciales(usuario, clave) {
  return usuario === process.env.AUTH_USER && clave === process.env.AUTH_PASS;
}

function setSessionCookie(res) {
  var secure = process.env.VERCEL ? ' Secure;' : '';
  var token = makeToken();
  res.setHeader('Set-Cookie',
    COOKIE_NAME + '=' + encodeURIComponent(token) +
    '; Max-Age=' + MAX_AGE_SEC + '; Path=/; HttpOnly;' + secure + ' SameSite=Lax');
}

function clearSessionCookie(res) {
  var secure = process.env.VERCEL ? ' Secure;' : '';
  res.setHeader('Set-Cookie', COOKIE_NAME + '=; Max-Age=0; Path=/; HttpOnly;' + secure + ' SameSite=Lax');
}

module.exports = { isAuthenticated, checkCredenciales, setSessionCookie, clearSessionCookie };
