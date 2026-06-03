// ALBIPOLLA Service Worker (Versión Optimizada)
const CACHE_NAME = 'albipolla-opt-v1';

const PRECACHE = [
  '/mundial2026/optimizada/',
  '/mundial2026/optimizada/index.html',
  '/mundial2026/optimizada/app.js',
  '/mundial2026/optimizada/albipolla-icon-192-v5.png',
  '/mundial2026/optimizada/albipolla-icon-512-v5.png',
  '/mundial2026/optimizada/manifest.json',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

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
    event.respondWith(
      fetch(event.request).then(res => {
        if (res && res.status === 200) {
          caches.open(CACHE_NAME).then(c => c.put(event.request, res.clone()));
        }
        return res;
      }).catch(() => caches.match(event.request).then(c => c || caches.match('/mundial2026/optimizada/')))
    );
  } else {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(res => {
          if (!res || res.status !== 200 || res.type === 'opaque') return res;
          caches.open(CACHE_NAME).then(c => c.put(event.request, res.clone()));
          return res;
        }).catch(() => caches.match('/mundial2026/optimizada/'));
      })
    );
  }
});
