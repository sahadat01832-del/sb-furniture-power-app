const test = require('node:test');
const assert = require('node:assert/strict');

// The Worker is an ES module. Node can import it directly; the helpers used
// here never touch Workers-only globals such as caches or fetch.
const workerPromise = import('../worker/src/index.js');

test('Worker accepts only https quick-tunnel origins', async () => {
  const { isAllowedOrigin } = await workerPromise;

  assert.equal(isAllowedOrigin('https://abc-def.trycloudflare.com'), true);
  assert.equal(isAllowedOrigin('https://abc-def.trycloudflare.com/'), true);

  assert.equal(isAllowedOrigin('http://abc-def.trycloudflare.com'), false);
  assert.equal(isAllowedOrigin('https://evil.example.com'), false);
  assert.equal(isAllowedOrigin('https://abc.trycloudflare.com.evil.com'), false);
  assert.equal(isAllowedOrigin('https://user:pass@abc.trycloudflare.com'), false);
  assert.equal(isAllowedOrigin('https://abc.trycloudflare.com:8443'), false);
  assert.equal(isAllowedOrigin('https://abc.trycloudflare.com/admin'), false);
  assert.equal(isAllowedOrigin(''), false);
  assert.equal(isAllowedOrigin(null), false);
});

test('Worker proxies only the phone API surface', async () => {
  const { isAllowedPath } = await workerPromise;

  assert.equal(isAllowedPath('/api/products'), true);
  assert.equal(isAllowedPath('/api/admin/orders'), true);
  assert.equal(isAllowedPath('/uploads/products/SBP-106.jpg'), true);
  assert.equal(isAllowedPath('/health'), true);
  assert.equal(isAllowedPath('/download/reseller-apk'), true);

  assert.equal(isAllowedPath('/'), false);
  assert.equal(isAllowedPath('/admin.html'), false);
  assert.equal(isAllowedPath('/js/api.js'), false);
});

test('Worker caches only anonymous catalog reads', async () => {
  const { isCacheableRequest } = await workerPromise;
  const anonymous = new Headers();

  assert.equal(isCacheableRequest('GET', '/api/products', anonymous), true);
  assert.equal(isCacheableRequest('GET', '/api/products/meta/categories', anonymous), true);

  assert.equal(
    isCacheableRequest('GET', '/api/products', new Headers({ authorization: 'Bearer token' })),
    false
  );
  assert.equal(
    isCacheableRequest('GET', '/api/products', new Headers({ cookie: 'token=abc' })),
    false
  );
  assert.equal(isCacheableRequest('POST', '/api/products', anonymous), false);
  assert.equal(isCacheableRequest('GET', '/api/orders', anonymous), false);
  assert.equal(isCacheableRequest('GET', '/api/admin/orders', anonymous), false);
});
