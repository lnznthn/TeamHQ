// Service worker: keeps the app's own files on the device so it opens offline.
// The page is network-first (3-second budget, then the cached copy), so any launch with signal runs the newest version.
// Fonts, icons and the manifest are cache-first. Requests to the sheet are never cached here.
const CACHE = 'teamhq-v1.3.0';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png',
  './fonts/bebas-neue-latin-400-normal.woff2', './fonts/geist-sans-latin-400-normal.woff2', './fonts/geist-sans-latin-500-normal.woff2', './fonts/geist-sans-latin-600-normal.woff2'];

self.addEventListener('install', e => {
  // cache: 'reload' skips the browser's HTTP cache, which GitHub Pages lets hold files for 10 minutes
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  // Delete only this app's old caches: the other apps on this site keep theirs.
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('teamhq-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (e.request.mode === 'navigate') {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const net = await Promise.race([fetch(url.pathname, { cache: 'no-store' }), new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 3000))]);
        if (net.ok) { cache.put('./index.html', net.clone()); return net; }
      } catch (err) {}
      return (await cache.match('./index.html')) || new Response('Offline', { status: 503 });
    })());
    return;
  }
  e.respondWith(caches.open(CACHE).then(async cache => {
    const hit = await cache.match(e.request);
    const net = fetch(e.request, { cache: 'no-store' }).then(res => { if (res.ok) cache.put(e.request, res.clone()); return res; }).catch(() => null);
    return hit || (await net) || new Response('Offline', { status: 503 });
  }));
});
