const cors = require('../lib/cors');
const { clearSessionCookie } = require('../lib/auth');

module.exports = async function(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  clearSessionCookie(res);
  res.json({ ok: true });
};
