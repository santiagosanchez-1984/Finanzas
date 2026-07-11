require('dotenv').config();
const http = require('http');
const fs   = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;

function patchRes(res) {
  res.status = function(code) { res._statusCode = code; return res; };
  res.json   = function(obj) {
    res.writeHead(res._statusCode || 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  res.send = function(data) {
    res.writeHead(res._statusCode || 200);
    res.end(String(data));
  };
  const _end = res.end.bind(res);
  res.end = function(data) {
    if (!res.headersSent) res.writeHead(res._statusCode || 200);
    _end(data);
  };
  return res;
}

const server = http.createServer(async (req, res) => {
  const fullUrl = new URL(req.url, `http://localhost:${PORT}`);
  let url = fullUrl.pathname;
  if (url === '/') url = '/api/index'; // mismo rewrite que vercel.json, para requerir login
  req.query = Object.fromEntries(fullUrl.searchParams);
  patchRes(res);

  // API routes
  if (url.startsWith('/api/')) {
    const relPath = url.slice(1).replace(/\//g, path.sep);
    let file = path.join(__dirname, relPath + '.js');

    if (!fs.existsSync(file)) {
      // Ruta dinamica estilo Vercel: api/carpeta/[param].js
      const dir = path.dirname(file);
      const lastSegment = path.basename(relPath);
      if (fs.existsSync(dir)) {
        const dynFile = fs.readdirSync(dir).find(f => /^\[.+\]\.js$/.test(f));
        if (dynFile) {
          const paramName = dynFile.slice(1, dynFile.indexOf(']'));
          req.query[paramName] = lastSegment;
          file = path.join(dir, dynFile);
        }
      }
    }

    if (!fs.existsSync(file)) { res.status(404).json({ error: 'Not found' }); return; }

    // Parse body para POST/PUT
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      if (body) try { req.body = JSON.parse(body); } catch {}
      try {
        // Limpia todo el cache del proyecto (no solo el archivo de la ruta) para
        // que los cambios en lib/*.js se reflejen sin reiniciar el server local.
        Object.keys(require.cache).forEach(k => { if (k.startsWith(__dirname)) delete require.cache[k]; });
        await require(file)(req, res);
      } catch (e) {
        if (!res.headersSent) res.status(500).json({ error: e.message });
      }
    });
    return;
  }

  res.status(404).send('Not found');
});

server.listen(PORT, () => console.log('Finanzas local: http://localhost:' + PORT));
