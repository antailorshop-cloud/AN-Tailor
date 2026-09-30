// Bump on every release that changes any cached file. The old cache is deleted
// on activate, so a bumped name is what forces phones to pick up new code.
// Adding a file to SHELL without bumping this is the trap: the install event
// never re-fires for an already-installed worker, so the new file is never
// precached and the previously cached copy keeps being served.
var CACHE = 'an-tailor-v5';

var SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './styles/tokens.css',
  './styles/app.css',
  './scripts/config.js',
  './scripts/supabase.js',
  './scripts/auth.js',
  './scripts/customers.js',
  './scripts/measurements.js',
  './scripts/settings.js',
  './scripts/app.js',
  './assets/icon.svg'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      return cache.addAll(SHELL);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === CACHE ? null : caches.delete(k);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;

  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
        return res;
      }).catch(function () {
        return caches.match('./index.html');
      })
    );
    return;
  }

  // Network-first for the app's own code. A tailor must never be handed last
  // week's JavaScript, so code is fetched fresh and the cache is only a
  // fallback for when the shop has no signal. Icons and fonts are safe to serve
  // from cache immediately, because they do not change between releases.
  var isCode = /\.(?:html|js|css|webmanifest)$/.test(url.pathname);

  if (isCode) {
    event.respondWith(
      fetch(req).then(function (res) {
        if (res && res.status === 200 && res.type === 'basic') {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () {
        return caches.match(req).then(function (hit) {
          return hit || caches.match('./index.html');
        });
      })
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && res.status === 200 && res.type === 'basic') {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      });
    })
  );
});
