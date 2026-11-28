const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  CONFIG_COLLECTION,
  CONFIG_DOCUMENT,
  createConnectionPublisher,
  extractQuickTunnelUrl,
  extractTunnelUrl,
  normalizePublicApiUrl,
  normalizePublicApiUrls
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

test('extractTunnelUrl parses localhost.run, Serveo, and Quick Tunnel URLs while ignoring api.trycloudflare.com', () => {
  assert.equal(
    extractTunnelUrl('{"data":{"address":"abc123.app.lhr.life"},"message":"https://abc123.app.lhr.life"}'),
    'https://abc123.app.lhr.life'
  );
  assert.equal(
    extractTunnelUrl('Forwarding HTTP traffic from https://feed1234-210-1.serveousercontent.com'),
    'https://feed1234-210-1.serveousercontent.com'
  );
  assert.equal(
    extractTunnelUrl('failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": no such host'),
    ''
  );
  assert.equal(extractQuickTunnelUrl('https://api.trycloudflare.com/tunnel'), '');
});

test('publisher stores deduplicated apiUrls array when multiple healthy tunnels are active', async () => {
  let writtenData;
  const firestore = {
    collection() {
      return { doc() { return { async set(data) { writtenData = data; } }; } };
    }
  };
  const publisher = createConnectionPublisher({ firestore });
  await publisher.publish('https://primary.lhr.life/', [
    'https://primary.lhr.life',
    'https://backup.trycloudflare.com/',
    'http://insecure.invalid'
  ]);

  assert.equal(writtenData.apiUrl, 'https://primary.lhr.life');
  assert.deepEqual(writtenData.apiUrls, [
    'https://primary.lhr.life',
    'https://backup.trycloudflare.com'
  ]);
  assert.deepEqual(normalizePublicApiUrls(['https://a.example/', 'https://a.example']), ['https://a.example']);
});
