// Offline support for the PWA. Bump VERSION whenever the precache list changes.
//  - pages: network first, cache as fallback (fresh HTML whenever online)
//  - static files: stale-while-revalidate (instant, refreshed in background)
//  - /socket.io/ traffic and /api/ are never cached
const VERSION = 'v2';
const CACHE = 'lode-' + VERSION;
const PRECACHE = [
  '/',
  '/style.css',
  '/game.js',
  '/sfx.js',
  '/pwa.js',
  '/socket.io/socket.io.js',
  '/favicon.svg',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('lode-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/socket.io/') && url.pathname !== '/socket.io/socket.io.js') return;

  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req));
  } else {
    event.respondWith(staleWhileRevalidate(req, event));
  }
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    // Cache under the path only, so /?room=ABC still has an offline fallback.
    if (res.ok) cache.put(new URL(req.url).pathname, res.clone());
    return res;
  } catch (err) {
    const path = new URL(req.url).pathname;
    return (await cache.match(path)) || (await cache.match('/')) || Response.error();
  }
}

async function staleWhileRevalidate(req, event) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req, { ignoreSearch: true });
  const network = fetch(req)
    .then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => undefined);
  if (cached) {
    event.waitUntil(network);
    return cached;
  }
  return (await network) || Response.error();
}
