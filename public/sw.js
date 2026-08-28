// Service worker: offline use, without the risk of a permanently stale app.
//
// A recorder gets taken to places with no signal, so the shell is cached. That
// also makes the classic service-worker failure available to us: a cached shell
// that outlives every deploy, so the app silently never updates again and there
// is nothing the user can do short of clearing site data.
//
// The strategy is chosen to make that failure impossible rather than unlikely:
//
//   navigations     -> network first, cache as fallback
//   /assets/*       -> cache first, because Vite content-hashes those filenames,
//                      so a given URL's bytes can never change
//   everything else -> straight to the network
//
// A navigation always asks the network first, so an online user is always on
// the current build; the cache only answers when the network does not.
//
// Bump CACHE when the caching behaviour itself changes. It does not need
// bumping per deploy — the hashed filenames already handle that — and old
// caches are deleted on activate.

const CACHE = 'quickdaw-v1';

// Enough to boot offline. Everything else arrives through runtime caching.
//
// The two worklet processors are not optional and are not in /assets/: they
// live in public/, so Vite neither hashes nor bundles them, and the runtime
// rule below would let them through to a network that is not there. Without
// the capture processor the page loads offline and then cannot record, which
// is the entire app.
const SHELL = [
  '/',
  '/manifest.webmanifest',
  '/icon.svg',
  '/capture-worklet.js',
  '/playback-worklet.js',
  '/about.js',
  '/about-data.js',
];

self.addEventListener('install', (event) => {
  // addAll rejects the whole install if any one entry 404s, which would leave
  // the old worker in place — correct, but silent. Fetch individually so one
  // missing icon cannot block an install.
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      await Promise.all(SHELL.map((url) => cache.add(url).catch(() => {})));
      await self.skipWaiting();
    }),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Never touch anything but same-origin reads. A cross-origin response is not
  // ours to reason about, and under COEP there should not be one at all.
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          const cache = await caches.open(CACHE);
          cache.put('/', fresh.clone());
          return fresh;
        } catch {
          const cached = (await caches.match(request)) || (await caches.match('/'));
          if (cached) return cached;
          throw new Error('offline and nothing cached');
        }
      })(),
    );
    return;
  }

  // Content-hashed build output: the URL is the version, so a hit is always
  // correct and a miss is worth storing.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        const fresh = await fetch(request);
        if (fresh.ok) {
          const cache = await caches.open(CACHE);
          cache.put(request, fresh.clone());
        }
        return fresh;
      })(),
    );
  }
});
