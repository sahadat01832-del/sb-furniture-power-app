const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const resolverSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'api.js'), 'utf8');

function loadResolver({
  hostname = 'sb-power-demo.web.app',
  projectId = '',
  // Production sets APP_CONFIG.apiUrl to the stable Worker. Tests that cover
  // Firestore discovery leave it empty; fallback tests set it explicitly.
  configuredApiUrl = '',
  firestoreDocument = { fields: {
    apiUrl: { stringValue: 'https://phone-tunnel.example/' },
    status: { stringValue: 'online' }
  } },
  firestoreDocuments = null,
  firestoreStatus = 200,
  cachedApiUrl = '',
  capacitor = false,
  apiResponder = async () => ({ ok: true, status: 200 })
} = {}) {
  const storage = new Map();
  const calls = [];
  let firestoreReads = 0;
  const intervalCalls = [];
  if (cachedApiUrl) storage.set(`sb_active_phone_api_url:${projectId || 'sb-power-demo'}`, cachedApiUrl);
  const nativeFetch = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, init });
    if (url.startsWith('https://firestore.googleapis.com/')) {
      firestoreReads += 1;
      return {
        ok: firestoreStatus >= 200 && firestoreStatus < 300,
        status: firestoreStatus,
        async json() {
          return Array.isArray(firestoreDocuments)
            ? firestoreDocuments[Math.min(firestoreReads - 1, firestoreDocuments.length - 1)]
            : firestoreDocument;
        }
      };
    }
    return { ...await apiResponder(url, init), url, async json() { return { success: true }; } };
  };
  const location = {
    hostname,
    protocol: 'https:',
    port: '',
    origin: `https://${hostname}`,
    href: `https://${hostname}/`
  };
  const localStorage = {
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    setItem(key, value) { storage.set(key, String(value)); },
    removeItem(key) { storage.delete(key); }
  };
  const window = {
    Capacitor: capacitor ? {} : undefined,
    APP_CONFIG: { apiUrl: configuredApiUrl, firebaseProjectId: projectId },
    location,
    localStorage,
    fetch: nativeFetch
  };
  vm.runInNewContext(resolverSource, {
    window,
    localStorage,
    URL,
    Request,
    AbortController,
    setTimeout,
    clearTimeout,
    setInterval(callback, delay) {
      intervalCalls.push({ callback, delay });
      return intervalCalls.length;
    },
    clearInterval() {},
    console
  });
  return { window, calls, storage, intervalCalls, getFirestoreReads: () => firestoreReads };
}

test('API calls discover the current phone URL and preserve paths and query strings', async () => {
  const { window, calls, storage, intervalCalls } = loadResolver();
  await window.SB_API.connectionReady;

  assert.equal(window.SB_API.getBaseUrl(), 'https://phone-tunnel.example');
  const response = await window.fetch(window.apiUrl('/api/orders?status=pending'));
  assert.equal(response.ok, true);
  assert.equal(calls.at(-1).url, 'https://phone-tunnel.example/api/orders?status=pending');
  assert.equal(storage.get('sb_active_phone_api_url:sb-power-demo'), 'https://phone-tunnel.example');
  assert.equal(calls.filter((call) => call.url.startsWith('https://firestore.googleapis.com/')).length, 1);
  assert.equal(intervalCalls.length, 0);
});

test('a cached phone address serves normal visits without a Firestore read', async () => {
  const { window, calls, getFirestoreReads } = loadResolver({ cachedApiUrl: 'https://phone-tunnel.example/' });
  await window.SB_API.connectionReady;

  await window.fetch(window.apiUrl('/api/products'));
  assert.equal(getFirestoreReads(), 0);
  assert.deepEqual(calls.map((call) => call.url), ['https://phone-tunnel.example/api/products']);
});

test('a stale cached phone URL refreshes once and safe reads retry against the new tunnel', async () => {
  const { window, calls, storage, getFirestoreReads } = loadResolver({
    cachedApiUrl: 'https://old-phone.example',
    firestoreDocument: { fields: {
      apiUrl: { stringValue: 'https://new-phone.example' },
      status: { stringValue: 'online' }
    } },
    apiResponder: async (url) => {
      if (url === 'https://old-phone.example/api/config') throw new TypeError('Failed to fetch');
      return { ok: true, status: 200 };
    }
  });
  await window.SB_API.connectionReady;

  const response = await window.fetch(window.apiUrl('/api/config'));
  assert.equal(response.status, 200);
  assert.equal(getFirestoreReads(), 1);
  assert.deepEqual(calls.map((call) => call.url), [
    'https://old-phone.example/api/config',
    'https://firestore.googleapis.com/v1/projects/sb-power-demo/databases/(default)/documents/system_config/backend_tunnel',
    'https://new-phone.example/api/config'
  ]);
  assert.equal(storage.get('sb_active_phone_api_url:sb-power-demo'), 'https://new-phone.example');
});

test('a tunnel that goes stale just after the first lookup is refreshed on the failed request', async () => {
  const { window, calls, getFirestoreReads } = loadResolver({
    firestoreDocuments: [
      { fields: { apiUrl: { stringValue: 'https://old-phone.example' }, status: { stringValue: 'online' } } },
      { fields: { apiUrl: { stringValue: 'https://new-phone.example' }, status: { stringValue: 'online' } } }
    ],
    apiResponder: async (url) => {
      if (url === 'https://old-phone.example/api/config') throw new TypeError('Failed to fetch');
      return { ok: true, status: 200 };
    }
  });
  await window.SB_API.connectionReady;

  const response = await window.fetch(window.apiUrl('/api/config'));
  assert.equal(response.status, 200);
  assert.equal(getFirestoreReads(), 2);
  assert.deepEqual(calls.map((call) => call.url), [
    'https://firestore.googleapis.com/v1/projects/sb-power-demo/databases/(default)/documents/system_config/backend_tunnel',
    'https://old-phone.example/api/config',
    'https://firestore.googleapis.com/v1/projects/sb-power-demo/databases/(default)/documents/system_config/backend_tunnel',
    'https://new-phone.example/api/config'
  ]);
});

test('a failed mutation is never replayed but refreshes the address for the next request', async () => {
  const { window, calls, getFirestoreReads } = loadResolver({
    cachedApiUrl: 'https://old-phone.example',
    firestoreDocument: { fields: {
      apiUrl: { stringValue: 'https://new-phone.example' },
      status: { stringValue: 'online' }
    } },
    apiResponder: async (url) => ({ ok: url.startsWith('https://old-phone.example') ? false : true,
      status: url.startsWith('https://old-phone.example') ? 503 : 200 })
  });
  await window.SB_API.connectionReady;

  const failedMutation = await window.fetch(window.apiUrl('/api/orders'), { method: 'POST', body: '{"item":1}' });
  assert.equal(failedMutation.status, 503);
  assert.equal(getFirestoreReads(), 1);
  assert.deepEqual(calls.filter((call) => !call.url.startsWith('https://firestore.googleapis.com/')).map((call) => call.url), [
    'https://old-phone.example/api/orders'
  ]);

  await window.fetch(window.apiUrl('/api/config'));
  assert.deepEqual(calls.filter((call) => !call.url.startsWith('https://firestore.googleapis.com/')).map((call) => call.url), [
    'https://old-phone.example/api/orders',
    'https://new-phone.example/api/config'
  ]);
});

test('invalid Firebase endpoint values cannot become the API base', async () => {
  const { window, calls } = loadResolver({
    firestoreDocument: { fields: { apiUrl: { stringValue: 'http://unsafe.example' } } }
  });
  await window.SB_API.connectionReady;

  // No stable URL and no valid tunnel: stay on the site's own origin instead of
  // adopting the unsafe value from Firestore.
  assert.equal(window.SB_API.getBaseUrl(), 'https://sb-power-demo.web.app');
  await window.fetch(window.apiUrl('/api/config'));
  assert.equal(calls.at(-1).url, 'https://sb-power-demo.web.app/api/config');
});

test('a Firestore lookup failure keeps the app usable on the configured origin', async () => {
  const { window, calls } = loadResolver({
    configuredApiUrl: 'https://stable-api.example',
    firestoreStatus: 503
  });
  await window.SB_API.connectionReady;

  await window.fetch(window.apiUrl('/api/health'));
  assert.equal(calls.at(-1).url, 'https://stable-api.example/api/health');
});

test('an app without Firebase project config uses its same-origin API without Firestore requests', async () => {
  const { window, calls } = loadResolver({
    hostname: 'shop.example',
    configuredApiUrl: ''
  });
  await window.SB_API.connectionReady;

  assert.equal(window.SB_API.getBaseUrl(), 'https://shop.example');
  await window.fetch(window.apiUrl('/api/config'));
  assert.deepEqual(calls.map((call) => call.url), ['https://shop.example/api/config']);
});

test('sbSafeImageUrl loads web uploads from the site origin and rejects unsafe schemes', async () => {
  const { window } = loadResolver();
  await window.SB_API.connectionReady;

  // Product photos ship with Firebase Hosting, so the browser keeps them on the
  // same origin instead of pulling every image through the phone tunnel.
  assert.equal(
    window.sbSafeImageUrl('/uploads/bikroy/SBP-B01.jpg'),
    'https://sb-power-demo.web.app/uploads/bikroy/SBP-B01.jpg'
  );
  assert.equal(
    window.sbSafeImageUrl('https://sb-power-marketplace.web.app/uploads/bikroy/SBP-B01.jpg'),
    'https://sb-power-marketplace.web.app/uploads/bikroy/SBP-B01.jpg'
  );
  assert.equal(window.sbSafeImageUrl('javascript:alert(1)'), '/icons/icon-512.png');
  assert.equal(
    window.sbImageCrossOrigin('https://phone-tunnel.example/uploads/bikroy/SBP-B01.jpg'),
    'anonymous'
  );
  assert.equal(
    window.sbImageCrossOriginAttr('https://phone-tunnel.example/uploads/bikroy/SBP-B01.jpg'),
    'crossorigin="anonymous"'
  );
  assert.equal(
    window.sbImageCrossOrigin('https://images.unsplash.com/photo-1555041469-a586c61ea9bc'),
    ''
  );
  assert.equal(window.sbImageCrossOrigin('/icons/icon-512.png'), '');
});

test('native builds still load /uploads/ from the phone API', async () => {
  const { window } = loadResolver({ capacitor: true });
  await window.SB_API.connectionReady;

  assert.equal(
    window.sbSafeImageUrl('/uploads/bikroy/SBP-B01.jpg'),
    'https://phone-tunnel.example/uploads/bikroy/SBP-B01.jpg'
  );
});

test('concurrent read requests both switch when a stale cached tunnel fails', async () => {
  const { window } = loadResolver({
    cachedApiUrl: 'https://old-phone.example',
    firestoreDocument: { fields: {
      apiUrl: { stringValue: 'https://new-phone.example' },
      status: { stringValue: 'online' }
    } },
    apiResponder: async (url) => {
      if (url.startsWith('https://old-phone.example')) throw new TypeError('Failed to fetch');
      return { ok: true, status: 200 };
    }
  });
  await window.SB_API.connectionReady;

  const [productsRes, configRes] = await Promise.all([
    window.fetch(window.apiUrl('/api/products')),
    window.fetch(window.apiUrl('/api/config'))
  ]);
  assert.equal(productsRes.status, 200);
  assert.equal(configRes.status, 200);
  assert.equal(window.SB_API.getBaseUrl(), 'https://new-phone.example');
});

test('dead Firestore tunnel falls back to configured APP_CONFIG.apiUrl and updates active origin', async () => {
  const { window, storage } = loadResolver({
    configuredApiUrl: 'https://live-fallback.example',
    firestoreDocument: { fields: {
      apiUrl: { stringValue: 'https://dead-firestore.example' },
      status: { stringValue: 'online' }
    } },
    apiResponder: async (url) => {
      if (url.startsWith('https://dead-firestore.example')) throw new TypeError('Failed to fetch');
      return { ok: true, status: 200 };
    }
  });
  await window.SB_API.connectionReady;

  const response = await window.fetch(window.apiUrl('/api/products'));
  assert.equal(response.status, 200);
  assert.equal(response.url, 'https://live-fallback.example/api/products');
  assert.equal(window.SB_API.getBaseUrl(), 'https://live-fallback.example');
  assert.equal(storage.get('sb_active_phone_api_url:sb-power-demo'), 'https://live-fallback.example');
});

test('stale service worker cache fallback refreshes Firestore and retries live tunnel when online', async () => {
  const { window, calls, getFirestoreReads } = loadResolver({
    cachedApiUrl: 'https://old-phone.example',
    firestoreDocument: { fields: {
      apiUrl: { stringValue: 'https://new-phone.example' },
      status: { stringValue: 'online' }
    } },
    apiResponder: async (url) => {
      if (url.startsWith('https://old-phone.example')) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'X-SB-SW-Cache': '1' })
        };
      }
      return { ok: true, status: 200 };
    }
  });
  await window.SB_API.connectionReady;

  const response = await window.fetch(window.apiUrl('/api/products'));
  assert.equal(response.status, 200);
  assert.equal(response.url, 'https://new-phone.example/api/products');
  assert.equal(getFirestoreReads(), 1);
  assert.equal(calls.some((call) => call.url === 'https://new-phone.example/api/products'), true);
});

test('multi-tunnel apiUrls failover switches silently from broken DNS primary to working backup', async () => {
  const events = [];
  const { window, calls, storage } = loadResolver({
    // No stable Worker here: this test covers the direct-tunnel failover path.
    configuredApiUrl: '',
    firestoreDocument: {
      fields: {
        apiUrl: { stringValue: 'https://blocked-dns.trycloudflare.com' },
        apiUrls: {
          arrayValue: {
            values: [
              { stringValue: 'https://blocked-dns.trycloudflare.com' },
              { stringValue: 'https://working-backup.lhr.life' }
            ]
          }
        },
        status: { stringValue: 'online' }
      }
    },
    apiResponder: async (url) => {
      if (url.startsWith('https://blocked-dns.trycloudflare.com')) {
        throw new TypeError('Failed to fetch');
      }
      return { ok: true, status: 200 };
    }
  });
  window.CustomEvent = function CustomEvent(name, init) {
    return { type: name, detail: init && init.detail };
  };
  window.dispatchEvent = (evt) => events.push(evt.detail.status);
  await window.SB_API.connectionReady;

  const response = await window.fetch(window.apiUrl('/api/products'));
  assert.equal(response.status, 200);
  assert.equal(response.url, 'https://working-backup.lhr.life/api/products');
  assert.equal(window.SB_API.getBaseUrl(), 'https://working-backup.lhr.life');
  assert.equal(storage.get('sb_active_phone_api_url:sb-power-demo'), 'https://working-backup.lhr.life');
  assert.equal(events.includes('offline'), false);
  assert.equal(calls.some((c) => c.url === 'https://working-backup.lhr.life/api/products'), true);
});

test('a configured stable Worker URL is used without a Firestore lookup', async () => {
  const { window, getFirestoreReads } = loadResolver({
    configuredApiUrl: 'https://stable-api.example',
    firestoreDocument: {
      fields: {
        apiUrl: { stringValue: 'https://phone-tunnel.example/' },
        status: { stringValue: 'online' }
      }
    }
  });
  await window.SB_API.connectionReady;

  const response = await window.fetch(window.apiUrl('/api/products'));
  assert.equal(response.status, 200);
  assert.equal(response.url, 'https://stable-api.example/api/products');
  assert.equal(getFirestoreReads(), 0);
});

test('a dead stable Worker URL fails over to the published tunnel', async () => {
  const { window } = loadResolver({
    configuredApiUrl: 'https://stable-api.example',
    firestoreDocument: {
      fields: {
        apiUrl: { stringValue: 'https://phone-tunnel.example/' },
        status: { stringValue: 'online' }
      }
    },
    apiResponder: async (url) => {
      if (url.startsWith('https://stable-api.example')) {
        throw new TypeError('Failed to fetch');
      }
      return { ok: true, status: 200 };
    }
  });
  await window.SB_API.connectionReady;

  const response = await window.fetch(window.apiUrl('/api/products'));
  assert.equal(response.status, 200);
  assert.equal(response.url, 'https://phone-tunnel.example/api/products');
  assert.equal(window.SB_API.getBaseUrl(), 'https://phone-tunnel.example');
});
