// Bump on every release. The old cache is deleted on activate, so a bumped
// name is what forces phones to pick up new code.
var CACHE = 'an-tailor-v2';

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

  // Stale-while-revalidate. Answering from the cache keeps the app instant and
  // working on a weak connection, while a background fetch quietly refreshes
  // the copy for next time. Plain cache-first would pin a phone to the code it
  // first installed, with no way to receive a fix.
  event.respondWith(
    caches.match(req).then(function (hit) {
      var network = fetch(req).then(function (res) {
        if (res && res.status === 200 && res.type === 'basic') {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () {
        return hit;
      });
      return hit || network;
    })
  );
});
