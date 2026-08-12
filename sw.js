const CACHE_NAME = 'slack-shell-v1';
const SHELL_ASSETS = [
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

// Never cache anything that looks like a live data/API route —
// stale trading data is dangerous, so these always hit the network.
const NEVER_CACHE = [/\/api\//, /\/positions/, /\/prices/, /\/leaderboard\/live/];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  if (NEVER_CACHE.some((rx) => rx.test(url))) {
    event.respondWith(fetch(event.request));
    return;
  }

  // Shell/static assets: cache-first, falling back to network.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      return (
        cached ||
        fetch(event.request).then((response) => {
          if (response.ok && event.request.method === 'GET') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
      );
    })
  );
});

// Push notifications: trade executed, TP/SL hit, migration detected,
// circuit breaker triggered, whale added to leaderboard top 10.
self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : { title: 'Slack', body: 'New activity' };
  event.waitUntil(
    self.registration.showNotification(data.title || 'Slack', {
      body: data.body || '',
      icon: './icons/icon-192.png',
      badge: './icons/icon-96.png',
    })
  );
});
