/* Squig Compare service worker.
   - navigations: network-first (updates land on the next online launch),
     offline falls back to the cached shell regardless of query string
   - app-shell assets: cache-first with background refresh (SWR), wrapped
     in waitUntil so the refresh survives SW termination
   - /api/*: network-first, cached fallback (offline demo of last data)
   - cross-origin (fonts, tailwind CDN): stale-while-revalidate */
const V = 'sq-v5';
const SHELL = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './fr-core.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-180.png',
  './icons/favicon-64.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== V).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === location.origin) {
    if (url.pathname.startsWith('/api/')) {
      /* network-first, cached fallback */
      e.respondWith(
        fetch(req).then(r => {
          if (r.ok) {
            const cp = r.clone();
            caches.open(V).then(c => c.put(req, cp));
          }
          return r;
        }).catch(() =>
          caches.match(req).then(m => m || new Response(JSON.stringify({ error: 'offline' }), { headers: { 'Content-Type': 'application/json' } }))
        )
      );
    } else if (req.mode === 'navigate') {
      /* network-first so shipping updates show on the very next online
         launch; offline, shared links (?s=…) still get the cached shell */
      e.respondWith(
        fetch(req).then(r => {
          if (r.ok) {
            const cp = r.clone();
            caches.open(V).then(c => c.put('./', cp));
          }
          return r;
        }).catch(() =>
          caches.match('./', { ignoreSearch: true }).then(m => m || Response.error())
        )
      );
    } else {
      /* assets: cache-first + background refresh (kept alive by waitUntil) */
      e.respondWith((async () => {
        const m = await caches.match(req);
        const net = fetch(req).then(r => {
          if (r.ok) {
            const cp = r.clone();
            caches.open(V).then(c => c.put(req, cp));
          }
          return r;
        }).catch(() => m);
        e.waitUntil(net.then(() => {}, () => {}));
        return m || net;
      })());
    }
    return;
  }

  /* cross-origin GET (googleapis fonts, cdn.tailwindcss.com): SWR */
  e.respondWith(
    caches.match(req).then(m => {
      const net = fetch(req).then(r => {
        if (r && (r.ok || r.type === 'opaque')) {
          const cp = r.clone();
          caches.open(V).then(c => c.put(req, cp));
        }
        return r;
      }).catch(() => m);
      e.waitUntil(net.then(() => {}, () => {}));
      return m || net;
    })
  );
});
