/* Squig Compare service worker.
   - app shell: cache-first with background refresh (stale-while-revalidate)
   - /api/*: network-first, cached fallback (offline demo of last data)
   - cross-origin (fonts, tailwind CDN): stale-while-revalidate */
const V = 'sq-v4';
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
    } else {
      /* app shell: cache-first + background refresh */
      e.respondWith(
        caches.match(req).then(m => {
          const net = fetch(req).then(r => {
            if (r.ok) {
              const cp = r.clone();
              caches.open(V).then(c => c.put(req, cp));
            }
            return r;
          }).catch(() => m);
          return m || net;
        })
      );
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
      return m || net;
    })
  );
});
