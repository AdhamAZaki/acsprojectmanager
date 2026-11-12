// Try the app without a database: serves frontend/ with the test stand-in for Supabase
// (tests/e2e/fake-supabase.js), so everything works on made-up data kept in the browser.
// Nothing reaches the real database. Run: npm run preview   (then open http://localhost:4173)
//
// Sign in with any of the test usernames and any password:
//   adham (admin) · amira, hany (department admins) · mona, omar, laila, gina, tamer (employees)
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'frontend');
const FAKE = path.join(__dirname, '..', 'tests', 'e2e', 'fake-supabase.js');
const PORT = Number(process.env.PORT) || 4173;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/__fake-supabase.js') {
    res.writeHead(200, { 'Content-Type': TYPES['.js'], 'Cache-Control': 'no-store' });
    return fs.createReadStream(FAKE).pipe(res);
  }
  // No service worker in the preview: it would keep old files and fetch the real Supabase library.
  if (/\/sw\.js$/.test(url.pathname)) { res.writeHead(404); return res.end(); }
  let file = path.join(ROOT, decodeURIComponent(url.pathname));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
    if (!url.pathname.endsWith('/')) { res.writeHead(302, { Location: url.pathname + '/' }); return res.end(); }
    file = path.join(file, 'index.html');
  }
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
  const type = TYPES[path.extname(file)] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  if (path.extname(file) !== '.html') return fs.createReadStream(file).pipe(res);
  // Pages load the stand-in instead of the real Supabase library.
  res.end(fs.readFileSync(file, 'utf8').replace(/https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@[^"']+/g, '/__fake-supabase.js'));
}).listen(PORT, () => console.log('Preview with made-up data: http://localhost:' + PORT));
