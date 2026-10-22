// Service worker: caches the app shell so the app opens instantly (and offline).
// Data requests to Supabase are never cached here; the app keeps its own data cache.
// Bump VERSION on every deploy that changes these files.
const VERSION = 'acs-tracker-v4';
const SHELL = [
  './', 'index.html', 'css/styles.css', 'js/config.js', 'js/api.js', 'js/app.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/apple-touch-icon.png', 'icons/acs-mark.svg',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.js',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Stale-while-revalidate for the app shell: answer from cache, update in the background.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isShell = url.origin === location.origin || /^https:\/\/(cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com)\//.test(url.href);
  if (!isShell) return;
  e.respondWith(caches.open(VERSION).then(async cache => {
    const cached = await cache.match(req, { ignoreSearch: url.origin === location.origin });
    const network = fetch(req).then(res => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => cached);
    return cached || network;
  }));
});
