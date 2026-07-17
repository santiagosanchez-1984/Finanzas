const crypto = require('crypto');

const COOKIE_NAME = 'finanzas_session';
const MAX_AGE_SEC = 60 * 60 * 24 * 30; // 30 dias

function sign(payload) {
  return crypto.createHmac('sha256', process.env.AUTH_SECRET).update(payload).digest('hex');
}

function makeToken(email) {
  var expira = String(Date.now() + MAX_AGE_SEC * 1000);
  var emailB64 = Buffer.from(email, 'utf8').toString('base64');
  var payload = expira + '.' + emailB64;
  return payload + '.' + sign(payload);
}

// Devuelve el email autenticado, o null si el token es invalido/vencido.
function verifyToken(token) {
  if (!token) return null;
  var parts = token.split('.');
  if (parts.length !== 3) return null;
  var expira = parts[0], emailB64 = parts[1], firma = parts[2];
  var payload = expira + '.' + emailB64;
  var esperada = sign(payload);
  var bufA = Buffer.from(firma);
  var bufB = Buffer.from(esperada);
  if (bufA.length !== bufB.length) return null;
  if (!crypto.timingSafeEqual(bufA, bufB)) return null;
  if (Date.now() >= parseInt(expira, 10)) return null;
  try { return Buffer.from(emailB64, 'base64').toString('utf8'); } catch (e) { return null; }
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

// Devuelve el email logueado (string) o null. Usable como boolean en los
// checks existentes ("if (!isAuthenticated(req))") y como identidad.
function isAuthenticated(req) {
  var cookies = parseCookies(req);
  return verifyToken(cookies[COOKIE_NAME]);
}

function setSessionCookie(res, email) {
  var secure = process.env.VERCEL ? ' Secure;' : '';
  var token = makeToken(email);
  res.setHeader('Set-Cookie',
    COOKIE_NAME + '=' + encodeURIComponent(token) +
    '; Max-Age=' + MAX_AGE_SEC + '; Path=/; HttpOnly;' + secure + ' SameSite=Lax');
}

function clearSessionCookie(res) {
  var secure = process.env.VERCEL ? ' Secure;' : '';
  res.setHeader('Set-Cookie', COOKIE_NAME + '=; Max-Age=0; Path=/; HttpOnly;' + secure + ' SameSite=Lax');
}

module.exports = { isAuthenticated, setSessionCookie, clearSessionCookie };
