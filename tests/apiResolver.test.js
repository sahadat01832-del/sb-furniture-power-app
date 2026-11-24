const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const resolverSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'api.js'), 'utf8');

function loadResolver({
  hostname = 'sb-power-demo.web.app',
  projectId = '',
  configuredApiUrl = 'https://fallback.example',
  firestoreDocument = { fields: {
    apiUrl: { stringValue: 'https://phone-tunnel.example/' },
    status: { stringValue: 'online' }
  } },
  firestoreStatus = 200
} = {}) {
  const storage = new Map();
  const calls = [];
  const nativeFetch = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, init });
    if (url.startsWith('https://firestore.googleapis.com/')) {
      return {
        ok: firestoreStatus >= 200 && firestoreStatus < 300,
        status: firestoreStatus,
        async json() { return firestoreDocument; }
      };
    }
    return { ok: true, status: 200, url, async json() { return { success: true }; } };
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
    setInterval,
    clearInterval,
    console
  });
  return { window, calls, storage };
}

test('API calls discover the current phone URL and preserve paths and query strings', async () => {
  const { window, calls, storage } = loadResolver();
  await window.SB_API.connectionReady;

  assert.equal(window.SB_API.getBaseUrl(), 'https://phone-tunnel.example');
  const response = await window.fetch(window.apiUrl('/api/orders?status=pending'));
  assert.equal(response.ok, true);
  assert.equal(calls.at(-1).url, 'https://phone-tunnel.example/api/orders?status=pending');
  assert.equal(storage.get('sb_active_phone_api_url:sb-power-demo'), 'https://phone-tunnel.example');
});

test('invalid Firebase endpoint values cannot replace the configured fallback', async () => {
  const { window, calls } = loadResolver({
    firestoreDocument: { fields: { apiUrl: { stringValue: 'http://unsafe.example' } } }
  });
  await window.SB_API.connectionReady;

  assert.equal(window.SB_API.getBaseUrl(), 'https://fallback.example');
  await window.fetch(window.apiUrl('/api/config'));
  assert.equal(calls.at(-1).url, 'https://fallback.example/api/config');
});

test('Firestore lookup failure keeps the app usable with its configured fallback', async () => {
  const { window, calls } = loadResolver({ firestoreStatus: 503 });
  await window.SB_API.connectionReady;

  await window.fetch(window.apiUrl('/api/health'));
  assert.equal(calls.at(-1).url, 'https://fallback.example/api/health');
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
