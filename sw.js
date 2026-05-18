// ── MUN'26 Service Worker ──
const CACHE_NAME = 'mun26-v2';

// Archivos que se cachean al instalar
const PRECACHE = [
  '/mundial2026/',
  '/mundial2026/index.html',
  '/mundial2026/icon.svg',
  '/mundial2026/manifest.json',
];

// ── Instalación: cachear shell de la app ──
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

// ── Activación: limpiar caches viejos ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: network-first para HTML, cache-first para assets estáticos ──
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // No interceptar peticiones a Firebase, FIFA API ni Google Fonts
  if (
    url.hostname.includes('firebaseio.com') ||
    url.hostname.includes('firebase.com') ||
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('gstatic.com') ||
    url.hostname.includes('api.fifa.com') ||
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com')
  ) return;

  const isHTML = event.request.mode === 'navigate' ||
    url.pathname.endsWith('.html') ||
    url.pathname.endsWith('/');

  if (isHTML) {
    // Network-first para el HTML: siempre intenta la red, usa caché solo si falla
    event.respondWith(
      fetch(event.request).then(res => {
        if (res && res.status === 200) {
          caches.open(CACHE_NAME).then(c => c.put(event.request, res.clone()));
        }
        return res;
      }).catch(() => caches.match(event.request).then(c => c || caches.match('/mundial2026/')))
    );
  } else {
    // Cache-first para assets estáticos (iconos, manifest)
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(res => {
          if (!res || res.status !== 200 || res.type === 'opaque') return res;
          caches.open(CACHE_NAME).then(c => c.put(event.request, res.clone()));
          return res;
        }).catch(() => caches.match('/mundial2026/'));
      })
    );
  }
});
