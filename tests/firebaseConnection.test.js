const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  CONFIG_COLLECTION,
  CONFIG_DOCUMENT,
  createConnectionPublisher,
  extractQuickTunnelUrl,
  normalizePublicApiUrl
} = require('../src/firebaseConnection');

test('phone connection publisher stores a validated online URL in the public config document', async () => {
  let writtenPath;
  let writtenData;
  let mergeOptions;
  const firestore = {
    collection(name) {
      return {
        doc(id) {
          writtenPath = `${name}/${id}`;
          return { async set(data, options) { writtenData = data; mergeOptions = options; } };
        }
      };
    }
  };
  const publisher = createConnectionPublisher({ firestore });
  const result = await publisher.publish('https://phone-tunnel.example/');

  assert.equal(result.success, true);
  assert.equal(result.apiUrl, 'https://phone-tunnel.example');
  assert.equal(writtenPath, `${CONFIG_COLLECTION}/${CONFIG_DOCUMENT}`);
  assert.equal(writtenData.apiUrl, 'https://phone-tunnel.example');
  assert.equal(writtenData.status, 'online');
  assert.deepEqual(mergeOptions, { merge: true });
  assert.equal(typeof writtenData.updatedAt, 'string');
  assert.equal(Object.hasOwn(writtenData, 'token'), false);
});

test('phone connection publisher rejects insecure or malformed URLs', async () => {
  assert.throws(() => normalizePublicApiUrl('http://phone.example'), { code: 'invalid_public_api_url' });
  assert.throws(() => normalizePublicApiUrl('https://user:pass@phone.example'), { code: 'invalid_public_api_url' });
  assert.throws(() => normalizePublicApiUrl('https://phone.example/api'), { code: 'invalid_public_api_url' });
});

test('Quick Tunnel URL parsing extracts only a trycloudflare HTTPS origin', () => {
  assert.equal(
    extractQuickTunnelUrl('\u001b[32mhttps://amber-bird-123.trycloudflare.com\u001b[0m'),
    'https://amber-bird-123.trycloudflare.com'
  );
  assert.equal(extractQuickTunnelUrl('http://amber-bird.trycloudflare.com'), '');
  assert.equal(extractQuickTunnelUrl('https://trycloudflare.com.evil.example'), '');
});

test('watchdog status updates retain the last public URL while offline', async () => {
  let writtenData;
  const firestore = {
    collection() {
      return { doc() { return { async set(data) { writtenData = data; } }; } };
    }
  };
  const publisher = createConnectionPublisher({ firestore });
  await publisher.setStatus('offline', 'https://phone-tunnel.example');

  assert.equal(writtenData.status, 'offline');
  assert.equal(writtenData.apiUrl, 'https://phone-tunnel.example');
  assert.equal(typeof writtenData.updatedAt, 'string');
});
