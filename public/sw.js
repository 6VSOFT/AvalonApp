// App-shell cache only. API calls and the event stream always go to the network,
// so the app never pretends an action succeeded while offline.
const CACHE = 'avalon-v8';
const SHELL = [
  '/', '/index.html', '/app.js', '/style.css', '/manifest.webmanifest',
  '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png',
  '/roles/merlin.svg', '/roles/percival.svg', '/roles/servant.svg', '/roles/assassin.svg',
  '/roles/morgana.svg', '/roles/mordred.svg', '/roles/oberon.svg', '/roles/minion.svg',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  const isPage = e.request.mode === 'navigate';
  // Network first so updates show up immediately; fall back to cache when offline.
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok && !isPage) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(isPage ? '/index.html' : e.request))
  );
});
