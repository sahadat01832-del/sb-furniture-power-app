const CACHE_NAME = 'sb-furniture-v47';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/admin.html',
  '/css/style.css',
  '/css/admin.css',
  '/css/pwa-install.css',
  '/css/pwa-splash.css',
  '/css/animations.css',
  '/js/api.js',
  '/js/app-config.js',
  '/js/catalog-algorithm.js',
  '/js/cutlist-calculator.js',
  '/js/catalog.js',
  '/js/leaderboard.js',
  '/js/app.js',
  '/js/pwa-install.js',
  '/js/pwa-splash.js',
  '/js/referrals.js',
  '/js/admin-referrals.js',
  '/js/admin-users.js',
  '/js/admin.js',
  '/manifest.json',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/admin-icon.svg',
  '/icons/admin-icon-192.png',
  '/icons/admin-icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') {
    return;
  }

  const url = new URL(event.request.url);

  // The active phone API address must always come from Firestore, never a stale cache.
  if (url.hostname === 'firestore.googleapis.com') {
    return;
  }

  // Bypass non-http protocols (e.g. chrome-extension, file, capacitor)
  if (!url.protocol.startsWith('http')) {
    return;
  }

  // Bypass multi-megabyte native APK downloads and dynamic uploads from Service Worker cache storage
  if (url.pathname.startsWith('/download/') || url.pathname.startsWith('/dist-apk/') || url.pathname.startsWith('/uploads/')) {
    return;
  }

  // Product responses may contain reseller-only commissions when authenticated.
  // Never place personalized catalog data in a shared offline cache.
  if (url.pathname.startsWith('/api/products') && event.request.headers.has('authorization')) {
    return;
  }

  // 1. Navigation requests (HTML pages): Network-First with cache revalidation for instant OTA upgrades
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request, { cache: 'no-cache' })
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseToCache));
          }
          return networkResponse;
        })
        .catch(async () => {
          const cached = await caches.match(event.request);
          if (cached) return cached;
          return (await caches.match('/index.html')) || Response.error();
        })
    );
    return;
  }

  // 2. Network-first caching for public catalog, config & leaderboard APIs (Instant Live Catalog + Offline Fallback)
  if (
    url.pathname.startsWith('/api/products') ||
    url.pathname.startsWith('/api/config') ||
    url.pathname.startsWith('/api/leaderboard')
  ) {
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseToCache));
          }
          return networkResponse;
        })
        .catch(async (err) => {
          const cached = await caches.match(event.request);
          if (!cached) throw err;
          const headers = new Headers(cached.headers);
          headers.set('X-SB-SW-Cache', '1');
          return new Response(cached.body, {
            status: cached.status,
            statusText: cached.statusText,
            headers
          });
        })
    );
    return;
  }

  // 3. Bypass all other /api/ endpoints (auth, orders, wallet, admin) - direct live server connection
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // Keep the public API endpoint fresh when a phone tunnel is reconfigured.
  if (url.pathname === '/js/app-config.js' || url.pathname === '/js/api.js') {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' })
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, networkResponse.clone()));
          }
          return networkResponse;
        })
        .catch(async (err) => {
          const cached = (await caches.match(event.request)) || (await caches.match(event.request, { ignoreSearch: true }));
          if (cached) return cached;
          throw err;
        })
    );
    return;
  }

  // 4. Stale-While-Revalidate strategy for static assets (CSS, JS, images, icons)
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const fetchPromise = fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseToCache));
          }
          return networkResponse;
        });

      if (cachedResponse) {
        fetchPromise.catch(() => {});
        return cachedResponse;
      }
      return fetchPromise;
    })
  );
});
