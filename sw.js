// Optional static-host PWA support. The HTML files also work by themselves.
const CACHE = 'wod-log-web-coach-completions-20261008-v3';
const FILES = ['./cloud.js', './crossfit_wod_tracker_ko.html', './crossfit_wod_tracker_en.html', './manifest-ko.webmanifest', './manifest-en.webmanifest', './icon-192.png', './icon-512.png'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(async cache => {
      await cache.addAll([...FILES, './index.html', './']);
      for (const file of FILES.filter(file => file.endsWith('.html'))) {
        const response = await cache.match(file);
        if (response) {
          const clean = new Response(await response.arrayBuffer(), {
            status: response.status, statusText: response.statusText, headers: response.headers
          });
          await cache.put(file, clean.clone());
          await cache.put(new URL(file.slice(0, -5), self.registration.scope), clean);
        }
      }
    }).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('wod-log-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok && FILES.some(file => new URL(file, self.registration.scope).href === event.request.url)) {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE).then(cache => cache.put(event.request, copy)));
    }
    return response;
  }).catch(() => caches.match(event.request)));
});
