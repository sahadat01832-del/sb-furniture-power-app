require('./testEnv');

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');

const algorithm = require('../public/js/catalog-algorithm');
const app = require('../src/server');
const { initDb, closeDb } = require('../src/db');
const { seedData } = require('../src/seed');

let server;
let baseUrl;

const request = (reqPath) => new Promise((resolve, reject) => {
  const url = new URL(reqPath, baseUrl);
  const req = http.request(url, { method: 'GET' }, (res) => {
    let data = '';
    res.on('data', (chunk) => {
      data += chunk;
    });
    res.on('end', () => {
      let json = data;
      try {
        json = JSON.parse(data);
      } catch (e) {}
      resolve({ status: res.statusCode, headers: res.headers, body: json });
    });
  });
  req.on('error', reject);
  req.end();
});

const SAMPLE_CATALOG = [
  { id: 1, sku: 'SBF-101', brand: 'SB Furniture', category: 'দোকান ডেকোরেশন', title: 'কাউন্টার টেবিল স্ট্যান্ডার্ড', regular_price: 9500, stock: 5, image_url: 'https://example.com/a.jpg', description: 'Solid melamine board counter' },
  { id: 2, sku: 'SBF-102', brand: 'SB Furniture', category: 'দোকান ডেকোরেশন', title: 'কাউন্টার টেবিল ডিলাক্স', regular_price: 12000, stock: 4, image_url: 'https://example.com/b.jpg', description: 'Heavy counter table' },
  { id: 3, sku: 'SBF-103', brand: 'SB Furniture', category: 'হোম ও অফিস ফার্নিচার', title: 'অফিস ওয়ার্কস্টেশন ডেস্ক', regular_price: 8500, stock: 0, image_url: '/uploads/desk.jpg', description: 'Out of stock popular office desk with cable tray' },
  { id: 4, sku: 'SBF-104', brand: 'SB Furniture', category: 'হোম ও অফিস ফার্নিচার', title: 'কম্পিউটার স্টাডি টেবিল', regular_price: 6200, stock: 8, image_url: '/uploads/study.jpg', description: 'Compact workstation table for students and professionals' },
  { id: 5, sku: 'SBP-201', brand: 'SB POWER', category: 'ওয়্যারলেস অডিও ও গ্যাজেটস', title: 'AirPods Pro TWS Black', regular_price: 1450, stock: 12, image_url: '/uploads/airpods.jpg', description: 'Active noise cancellation wireless earbuds' },
  { id: 6, sku: 'SBP-202', brand: 'SB POWER', category: 'ওয়্যারলেস অডিও ও গ্যাজেটস', title: 'AirPods Pro White Edition', regular_price: 1490, stock: 9, image_url: '/uploads/airpods-w.jpg', description: 'Wireless charging case earbuds' },
  { id: 7, sku: 'SBP-203', brand: 'SB POWER', category: 'ওয়াচ ও ফ্যাশন', title: 'Smart Watch Ultra Series 9', regular_price: 2100, stock: 7, image_url: '/uploads/watch.jpg', description: 'AMOLED display Bluetooth calling smartwatch' },
  { id: 8, sku: 'SBP-204', brand: 'SB POWER', category: 'পাওয়ার টুলস ও ইলেকট্রিক্যাল', title: 'Cordless Drill 21V Heavy Duty', regular_price: 3800, stock: 6, image_url: '/uploads/drill.jpg', description: 'Dual battery heavy duty hammer drill kit' },
  { id: 9, sku: 'SBP-205', brand: 'SB POWER', category: 'ওয়াচ ও ফ্যাশন', title: 'Smart Watch Leather Strap', regular_price: 1750, stock: 0, image_url: '/uploads/watch-l.jpg', description: 'Out of stock smartwatch variant' },
  { id: 10, sku: 'SBF-105', brand: 'SB Furniture', category: 'হোম ও অফিস ফার্নিচার', title: 'বুকশেলফ মডার্ন ৪ স্তর', regular_price: 7300, stock: 3, image_url: '/uploads/shelf.jpg', description: 'Tall modern bookshelf for living room or shop' }
];

before(async () => {
  await initDb();
  await seedData({ includeDemoProducts: true });
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  await closeDb();
});

test('1. Discovery algorithm rotates starting lineup across different seeds and stays deterministic per seed', () => {
  const firstIds = new Set();
  for (let seed = 10; seed < 40; seed += 1) {
    const ranked = algorithm.rankCatalogProducts(SAMPLE_CATALOG, { sort: 'default', seed });
    assert.equal(ranked.length, SAMPLE_CATALOG.length);
    firstIds.add(ranked[0].sku);
  }
  assert.ok(firstIds.size >= 4, `Expected multiple distinct top products across seeds, saw only: ${[...firstIds].join(', ')}`);

  const runA = algorithm.rankCatalogProducts(SAMPLE_CATALOG, { sort: 'default', seed: 987654 });
  const runB = algorithm.rankCatalogProducts(SAMPLE_CATALOG, { sort: 'default', seed: 987654 });
  assert.deepEqual(
    runA.map((item) => item.id),
    runB.map((item) => item.id)
  );
});

test('2. Out-of-stock products remain below all in-stock items during discovery browsing', () => {
  for (const seed of [1, 42, 777, 99991]) {
    const ranked = algorithm.rankCatalogProducts(SAMPLE_CATALOG, { sort: 'default', seed });
    const firstOutOfStockIdx = ranked.findIndex((p) => Number(p.stock) <= 0);
    assert.ok(firstOutOfStockIdx > 0);
    const allTrailingAreOutOfStock = ranked.slice(firstOutOfStockIdx).every((p) => Number(p.stock) <= 0);
    assert.equal(allTrailingAreOutOfStock, true);
  }
});

test('3. Brand and category diversity interleaving prevents long homogeneous product streaks', () => {
  const ranked = algorithm.rankCatalogProducts(SAMPLE_CATALOG, { sort: 'default', seed: 555 });
  const inStockRanked = ranked.filter((p) => Number(p.stock) > 0);
  let longestSameBrandStreak = 1;
  let currentStreak = 1;
  for (let i = 1; i < inStockRanked.length; i += 1) {
    if (inStockRanked[i].brand === inStockRanked[i - 1].brand) {
      currentStreak += 1;
      longestSameBrandStreak = Math.max(longestSameBrandStreak, currentStreak);
    } else {
      currentStreak = 1;
    }
  }
  assert.ok(longestSameBrandStreak <= 2, `Expected mixed brand streak <= 2 while mixed stock remains, got ${longestSameBrandStreak}`);
});

test('4. Search relevance ranks exact SKU and Bangla/English title matches first, and explicit sorts stay monotonic', () => {
  const exactSkuSearch = algorithm.rankCatalogProducts(SAMPLE_CATALOG, {
    sort: 'default',
    seed: 123,
    searchQuery: 'SBF-103'
  });
  assert.equal(exactSkuSearch[0].sku, 'SBF-103');

  const banglaTitleSearch = algorithm.rankCatalogProducts(SAMPLE_CATALOG, {
    sort: 'default',
    seed: 123,
    searchQuery: 'বুকশেলফ'
  });
  assert.equal(banglaTitleSearch[0].sku, 'SBF-105');

  const priceAsc = algorithm.rankCatalogProducts(SAMPLE_CATALOG, { sort: 'price_asc', seed: 123 });
  for (let i = 1; i < priceAsc.length; i += 1) {
    assert.ok(priceAsc[i - 1].regular_price <= priceAsc[i].regular_price);
  }

  const newest = algorithm.rankCatalogProducts(SAMPLE_CATALOG, { sort: 'newest', seed: 123 });
  assert.equal(newest[0].id, 10);
  assert.equal(newest[newest.length - 1].id, 1);
});

test('5. Browser catalog integration runs discovery ordering and reshuffleCatalogFeed rotates lineup', async () => {
  const apiSource = fs.readFileSync(path.join(__dirname, '../public/js/api.js'), 'utf8');
  const algoSource = fs.readFileSync(path.join(__dirname, '../public/js/catalog-algorithm.js'), 'utf8');
  const catalogSource = fs.readFileSync(path.join(__dirname, '../public/js/catalog.js'), 'utf8');

  const storage = new Map();
  const sortEl = { value: 'default' };
  const toastMessages = [];

  const mockFetch = async () => ({
    status: 200,
    json: async () => ({
      success: true,
      reseller_access: false,
      account_role: null,
      products: SAMPLE_CATALOG.slice()
    })
  });

  const sandbox = {
    window: {
      location: { origin: 'https://sb-power-marketplace.web.app', search: '' },
      fetch: mockFetch
    },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v))
    },
    document: {
      getElementById: (id) => {
        if (id === 'productGrid') return { innerHTML: '' };
        if (id === 'productResultCount') return { textContent: '' };
        if (id === 'sortSelect') return sortEl;
        return null;
      },
      querySelectorAll: () => []
    },
    fetch: mockFetch,
    currentUser: null,
    updateAuthUI: () => {},
    showToast: (msg) => toastMessages.push(msg),
    setTimeout,
    clearTimeout,
    URLSearchParams,
    crypto: require('crypto').webcrypto,
    console
  };
  sandbox.globalThis = sandbox;
  sandbox.window.window = sandbox.window;

  vm.createContext(sandbox);
  vm.runInContext(apiSource, sandbox);
  vm.runInContext(algoSource, sandbox);
  vm.runInContext(catalogSource, sandbox);

  assert.ok(sandbox.window.SBCatalogAlgorithm, 'SBCatalogAlgorithm should attach to window');

  await sandbox.loadProducts();
  const initialRenderedOrder = vm.runInContext('allProducts.map((p) => p.sku)', sandbox);
  assert.equal(initialRenderedOrder.length, SAMPLE_CATALOG.length);

  const distinctTopSkus = new Set([initialRenderedOrder[0]]);
  for (let i = 0; i < 8; i += 1) {
    sandbox.reshuffleCatalogFeed();
    distinctTopSkus.add(vm.runInContext('allProducts[0].sku', sandbox));
  }
  assert.ok(distinctTopSkus.size >= 2, 'Expected reshuffleCatalogFeed to change the hero product across clicks');
  assert.ok(toastMessages.length >= 1);
});

test('6. Backend GET /api/products applies seeded discovery ordering without breaking pagination or explicit sorts', async () => {
  const seedARes = await request('/api/products?seed=11111&limit=10');
  const seedBRes = await request('/api/products?seed=22222&limit=10');

  assert.equal(seedARes.status, 200);
  assert.equal(seedBRes.status, 200);
  assert.equal(seedARes.body.discovery_seed, 11111);
  assert.equal(seedBRes.body.discovery_seed, 22222);
  assert.notDeepEqual(
    seedARes.body.products.map((p) => p.id),
    seedBRes.body.products.map((p) => p.id),
    'Different discovery seeds should yield varied top products'
  );

  // Explicit pagination with a shared seed has zero duplicate product IDs between pages
  const page1 = await request('/api/products?seed=44444&page=1&limit=8');
  const page2 = await request('/api/products?seed=44444&page=2&limit=8');
  assert.equal(page1.status, 200);
  assert.equal(page2.status, 200);
  const page1Ids = new Set(page1.body.products.map((p) => p.id));
  for (const p of page2.body.products) {
    assert.equal(page1Ids.has(p.id), false, `Duplicate product ID ${p.id} across discovery pages`);
  }

  // Explicit id_asc preserves sequential order; invalid seed is rejected cleanly
  const seqRes = await request('/api/products?sort=id_asc&limit=5');
  assert.equal(seqRes.status, 200);
  for (let i = 1; i < seqRes.body.products.length; i += 1) {
    assert.ok(seqRes.body.products[i - 1].id < seqRes.body.products[i].id);
  }

  const badSeedRes = await request('/api/products?seed=abc');
  assert.equal(badSeedRes.status, 400);
});
