// Shared setup for the browser tests: serves frontend/ on a local port and opens
// pages where the Supabase library is replaced by tests/e2e/fake-supabase.js.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..', '..', 'frontend');
const FAKE = fs.readFileSync(path.join(__dirname, 'fake-supabase.js'), 'utf8');
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

function serve() {
  const server = http.createServer((req, res) => {
    let file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` })));
}

// Desktop size by default; phone tests pass their own viewport.
async function newApp(browser, opts) {
  const ctx = await browser.newContext(Object.assign({ serviceWorkers: 'block', viewport: { width: 1100, height: 900 } }, opts || {}));
  await ctx.route(/cdn\.jsdelivr\.net/, r => r.fulfill({ contentType: 'application/javascript', body: FAKE }));
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  return ctx;
}

// Opens My tasks unless the url names a screen (the app itself starts on Projects).
async function signIn(page, url, username) {
  await page.goto(url.indexOf('#') === -1 ? url + '#/tasks' : url);
  await page.fill('input[name=username]', username);
  await page.fill('input[name=password]', 'test-password');
  await page.click('button[type=submit]');
  await page.waitForSelector('.week-seg, .board-seg');
}

// PW_CHANNEL=chrome uses an installed Google Chrome instead of Playwright's Chromium (CI does this).
const launch = () => chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});

module.exports = { chromium, launch, serve, newApp, signIn };
