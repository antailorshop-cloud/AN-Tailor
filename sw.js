// Bump on every release that changes any cached file. The old cache is deleted
// on activate, so a bumped name is what forces phones to pick up new code.
//
// This has to happen on EVERY release, not just when a file is added. A fixed
// file that is not re-precached stays broken for anyone on a weak connection:
// network-first falls back to the cache, and the cache still holds the old
// copy. That is how a "Save order" fix reached the server and never reached
// the shop phone.
var CACHE = 'an-tailor-v28';

// Every module index.html loads, so a first visit that is online and then goes
// offline still has the whole app rather than a shell that cannot open Bills.
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
  './scripts/resale.js',
  './scripts/orders.js',
  './scripts/payments.js',
  './scripts/dashboard.js',
  './scripts/qr.js',
'./scripts/upi.js',
'./scripts/printsize.js',
'./scripts/whatsapp.js',
  './scripts/billpdf.js',
  './scripts/bills.js',
  './scripts/settings.js',
  './scripts/app.js',
  './assets/icon.svg',
  // The shop's own logo. Optional: a shop with no logo file yet still installs.
  './assets/ANTailor.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE).then(function (cache) {
      // Each shell file is cached on its own rather than with cache.addAll(),
      // which rejects the entire install if a single URL is missing. ANTailor.png is
      // optional, so a shop that has not been given one must still install and
      // run offline. Anything that fails here is skipped and picked up on first
      // online use by the fetch handler instead.
      return Promise.all(SHELL.map(function (entry) {
        return cache.add(entry).catch(function () { return null; });
      }));
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
    }).then(function () {
      // A new worker has taken over, so the open tabs are now on fresh files.
      // Without this they keep running whatever was in memory and only find
      // out on the next full reload.
      return self.clients.matchAll({ type: 'window' }).then(function (list) {
        list.forEach(function (client) {
          client.postMessage({ type: 'updated', cache: CACHE });
        });
      });
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
        return caches.match('./index.html').then(function (hit) {
          announceStale();
          return markStale(hit);
        });
      })
    );
    return;
  }

  // Network-first for the app's own code. A tailor must never be handed last
  // week's JavaScript, so code is fetched fresh and the cache is only a
  // fallback for when the shop has no signal. Icons and fonts are safe to serve
  // from cache immediately, because they do not change between releases.
  var isCode = /\.(?:html|js|css|webmanifest)$/.test(url.pathname);

  // A cached copy is marked so the page can tell the user. Serving stale code
  // quietly is worse than being offline: the tailor sees a button that does
  // nothing and has no way to know why.
  function markStale(res) {
    if (!res) return res;
    var headers = new Headers(res.headers);
    headers.set('X-From-Cache', '1');
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: headers
    });
  }

  // Any open tab is running a mix of fresh and cached files. Say so, so it can
  // show the banner instead of failing mysteriously.
  function announceStale() {
    return self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(function (list) {
        list.forEach(function (client) {
          client.postMessage({ type: 'stale', cache: CACHE });
        });
      });
  }

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
          var stale = markStale(hit || caches.match('./index.html'));
          announceStale();
          return stale;
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
