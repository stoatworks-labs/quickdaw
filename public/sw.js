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
//   everything else -> network first, cache as fallback
//
// A navigation always asks the network first, so an online user is always on
// the current build; the cache only answers when the network does not.
//
// Bump CACHE when the caching behaviour itself changes. It does not need
// bumping per deploy — the hashed filenames already handle that — and old
// caches are deleted on activate.

const CACHE = 'quickdaw-v2';

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
  '/support-footer.js',
];

// Pull in the hashed files the current build actually names.
//
// This is not belt and braces. A page's own scripts are fetched before this
// worker controls anything -- registration happens on `load`, by which time
// the browser has the bundle already -- so an install alone leaves the one
// file the app cannot start without uncached. The shell would open with no
// signal and render nothing, and "works offline" would quietly mean "from
// the second visit onwards".
//
// Reading the shell HTML back and caching whatever /assets/ URLs it names
// costs one extra fetch at activate and makes the first visit enough.
async function warmBuildAssets() {
  try {
    const cache = await caches.open(CACHE);
    const res = await fetch('/', { cache: 'reload' });
    if (!res.ok) return;
    await cache.put('/', res.clone());
    const html = await res.text();
    // Resolved, not string-matched: an app built with a relative base names
    // `./assets/x.js` here, and a startsWith on the raw attribute would match
    // nothing at all and warm nothing, silently.
    const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
      .map((m) => {
        try {
          return new URL(m[1], self.location.origin + '/');
        } catch {
          return null;
        }
      })
      .filter((u) => u && u.origin === self.location.origin
        && u.pathname.startsWith('/assets/'))
      .map((u) => u.pathname + u.search);
    await Promise.all([...new Set(urls)].map((u) => cache.add(u).catch(() => {})));
  } catch {
    // No network at activate time. Runtime caching picks these up on the
    // next online visit; nothing here is worth failing an activation over.
  }
}

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
      await warmBuildAssets();
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
    return;
  }

  // Everything else same-origin: the shell files above, and anything else the
  // page asks for by a stable name. The network wins whenever there is one,
  // because none of these URLs carry their own version and a cached copy could
  // be any age. The cache answers only when the fetch throws.
  //
  // Falling through here instead -- letting the browser fetch normally -- is
  // what this worker used to do, and it is the quiet way to have no offline
  // support at all: install filled a cache that the fetch handler never read,
  // so the page loaded with no signal and then every script it pulls from the
  // site root failed.
  event.respondWith(
    (async () => {
      try {
        const fresh = await fetch(request);
        if (fresh.ok && SHELL.includes(url.pathname)) {
          const cache = await caches.open(CACHE);
          cache.put(request, fresh.clone());
        }
        return fresh;
      } catch (error) {
        const cached = await caches.match(request);
        if (cached) return cached;
        throw error;
      }
    })(),
  );
});
