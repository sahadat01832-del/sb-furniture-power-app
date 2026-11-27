require('./testEnv');

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const app = require('../src/server');
const { initDb, run, get, closeDb } = require('../src/db');
const { hashPassword } = require('../src/auth');
const fs = require('node:fs');
const path = require('node:path');
const { calculateCutlist, generateParametricCutlist, detectFurnitureType } = require('../src/services/cutlistCalculator');
const { estimateFurniturePartsAndBoards } = require('../src/services/aiRouter');

let server;
let baseUrl;
let adminToken;
const testAdminPassword = crypto.randomBytes(24).toString('hex');

const request = (path, options = {}) => {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const reqOptions = {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    };

    const req = http.request(url, reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        let json;
        try {
          json = JSON.parse(data);
        } catch (e) {
          json = data;
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: json
        });
      });
    });

    req.on('error', reject);

    if (options.body) {
      req.write(JSON.stringify(options.body));
    }
    req.end();
  });
};

before(async () => {
  await initDb();

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  const adminHash = await hashPassword(testAdminPassword);
  const admin = await get("SELECT * FROM users WHERE phone = '01999887766'");
  if (!admin) {
    await run(
      "INSERT INTO users (name, phone, password_hash, role, referral_code) VALUES ('Admin User', '01999887766', ?, 'admin', 'SBADMINFURN')",
      [adminHash]
    );
  } else {
    await run("UPDATE users SET password_hash = ?, role = 'admin' WHERE phone = '01999887766'", [adminHash]);
  }

  const loginRes = await request('/api/auth/login', {
    method: 'POST',
    body: { phone: '01999887766', password: testAdminPassword }
  });
  assert.equal(loginRes.status, 200);
  adminToken = loginRes.body.token;
});

after(() => {
  if (server) server.close();
  closeDb();
});

test('Furniture AI 1: Board Cutlist Math Engine (4ft x 8ft Standard Boards)', () => {
  const parts = [
    { name: 'উভয় পাশের প্যানেল', length: 72, width: 18, qty: 2 },
    { name: 'টপ প্যানেল', length: 36, width: 18, qty: 1 },
    { name: 'বটম বেস প্যানেল', length: 36, width: 18, qty: 1 },
    { name: 'অভ্যন্তরীণ তাক', length: 34.5, width: 17, qty: 3 }
  ];

  const calc = calculateCutlist(parts, { boardPrice: 1800 });
  assert.ok(calc.total_boards > 0, 'Total boards should be greater than zero');
  assert.equal(typeof calc.total_boards, 'number');
  assert.equal(typeof calc.efficiency_pct, 'number');
  assert.equal(typeof calc.wastage_pct, 'number');
  assert.equal(calc.efficiency_pct + calc.wastage_pct, 100);
  assert.equal(calc.estimated_board_cost, calc.total_boards * 1800);
  assert.ok(calc.total_area_sqft > 0);
  assert.equal(calc.parts.length, 4);

  // Test empty parts
  const emptyCalc = calculateCutlist([], { boardPrice: 1800 });
  assert.equal(emptyCalc.total_boards, 0);
  assert.equal(emptyCalc.estimated_board_cost, 0);
  assert.equal(emptyCalc.parts.length, 0);
});

test('Furniture AI 1b: Packing respects sheet size, blade kerf and oversized parts', () => {
  // Two 24" x 96" strips need 48" plus a blade kerf across the board, so they
  // cannot come from one sheet (the old area-only math counted them as 1).
  const strips = calculateCutlist([{ name: 'স্ট্রিপ', length: 96, width: 24, qty: 2 }], { boardPrice: 1800 });
  assert.equal(strips.total_boards, 2);
  assert.equal(strips.parts[0].fits, true);
  assert.equal(strips.warnings.length, 0);

  // Longer than 8 feet: report that it must be joined and budget those boards
  // instead of silently counting a part no sheet can produce.
  const oversize = calculateCutlist([{ name: 'লম্বা ব্যাক প্যানেল', length: 100, width: 20, qty: 1 }], { boardPrice: 1800 });
  assert.equal(oversize.parts[0].fits, false);
  assert.equal(oversize.warnings.length, 1);
  assert.ok(oversize.warnings[0].includes('জোড়া'));
  assert.ok(oversize.total_boards >= 1);
  assert.equal(oversize.estimated_board_cost, oversize.total_boards * 1800);

  // Exactly one full sheet is exactly one board.
  assert.equal(calculateCutlist([{ length: 96, width: 48, qty: 1 }], {}).total_boards, 1);

  // Rows without usable dimensions must not invent a board.
  const blank = calculateCutlist([{ name: 'খালি', length: 0, width: 0, qty: 2 }], { boardPrice: 1800 });
  assert.equal(blank.total_boards, 0);
  assert.equal(blank.estimated_board_cost, 0);
  assert.equal(blank.parts.length, 0);

  // Four 47" x 23" shelves nest on a single board; efficiency stays a real ratio.
  const packed = calculateCutlist([{ length: 47, width: 23, qty: 4 }], { boardPrice: 1000 });
  assert.equal(packed.total_boards, 1);
  assert.equal(packed.estimated_board_cost, 1000);
  assert.ok(packed.efficiency_pct > 0 && packed.efficiency_pct <= 100);
  assert.equal(packed.efficiency_pct + packed.wastage_pct, 100);
});

test('Furniture AI 2: Parametric Baseline Cutlist Generator for Furniture Types', () => {
  const shelfParts = generateParametricCutlist('বুকশেলফ', { height: 72, width: 36, depth: 12 });
  assert.ok(Array.isArray(shelfParts));
  assert.ok(shelfParts.some((part) => part.name.includes('তাক')), 'A Bangla book-shelf must produce shelves');
  assert.equal(shelfParts[0].qty, 2, 'Shelf type starts with its two side panels');

  const tableParts = generateParametricCutlist('কম্পিউটার টেবিল', { height: 30, width: 48, depth: 24 });
  assert.ok(Array.isArray(tableParts));
  assert.ok(tableParts.length >= 3, 'Table should have multiple parts');
});

test('Furniture AI 2b: A table product is estimated as a table, not a wardrobe', async () => {
  // Bangla and English titles map onto the parametric types.
  assert.equal(detectFurnitureType('টেস্ট এআই কম্পিউটার টেবিল'), 'table');
  assert.equal(detectFurnitureType('Computer Desk'), 'table');
  assert.equal(detectFurnitureType('বুকশেলফ'), 'rack');
  assert.equal(detectFurnitureType('খাট'), 'bed');
  assert.equal(detectFurnitureType('ফার্নিচার'), 'wardrobe');

  const tableParts = generateParametricCutlist('টেস্ট এআই কম্পিউটার টেবিল', { height: 30, width: 48, depth: 24 });
  assert.ok(tableParts.some((part) => part.name.includes('টেবিল টপ')));
  assert.ok(!tableParts.some((part) => part.name.includes('সাইড প্যানেল (Left')));

  // Both admin bundles must send the detected type, never the raw product title.
  for (const file of ['public/js/admin.js', 'public-admin/js/admin.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.ok(
      source.includes('furniture_type: window.SBCutlistCalculator.detectFurnitureType('),
      `${file} must send a detected furniture type`
    );
    assert.ok(!source.includes('furniture_type: title'), `${file} still sends the product title as the furniture type`);
  }
});

test('Furniture AI 3: AI Router returns valid calculation even if PC OmniRoute is unreachable', async () => {
  const result = await estimateFurniturePartsAndBoards({
    furniture_type: 'অফিস আলমিরা',
    height: 72,
    width: 36,
    depth: 18,
    board_price: 2000
  });

  assert.equal(result.success, true);
  assert.ok(result.parts.length > 0, 'Should return parts breakdown');
  assert.ok(result.total_boards > 0, 'Should return total boards needed');
  assert.equal(result.estimated_board_cost, result.total_boards * 2000);
  assert.ok(result.provider_used, 'Should identify provider used');
});

test('Furniture AI 4: Admin API POST /api/admin/furniture/estimate Endpoint', async () => {
  // Unauthenticated request should fail
  const unauthRes = await request('/api/admin/furniture/estimate', {
    method: 'POST',
    body: { furniture_type: 'ওয়ারড্রোব', height: 72, width: 36, depth: 18 }
  });
  assert.equal(unauthRes.status, 401);

  // Authenticated request with valid dimensions
  const res = await request('/api/admin/furniture/estimate', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: {
      furniture_type: 'ওয়ারড্রোব',
      height: 72,
      width: 36,
      depth: 18,
      board_price: 1800
    }
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.ok(Array.isArray(res.body.parts));
  assert.ok(res.body.parts.length > 0);
  assert.ok(res.body.total_boards > 0);
  assert.equal(typeof res.body.estimated_board_cost, 'number');
});

test('Furniture AI 5: Product CRUD with furniture_cutlist persistence in database', async () => {
  const cutlistPayload = {
    parts: [
      { name: 'টপ বোর্ড', length: 48, width: 24, qty: 1 },
      { name: 'সাইড প্যানেল', length: 30, width: 24, qty: 2 }
    ],
    total_boards: 1,
    board_price: 1800,
    estimated_board_cost: 1800,
    total_area_sqft: '18.0',
    wastage_pct: 44
  };

  const createRes = await request('/api/admin/products', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: {
      title: 'টেস্ট এআই কম্পিউটার টেবিল',
      sku: 'FURN-TEST-AI-999',
      brand: 'SB Furniture',
      category: 'হোম ও অফিস ফার্নিচার',
      commission_tab: '100tk',
      regular_price: 4500,
      wholesale_price: 1800,
      reseller_commission: 500,
      stock: 15,
      materials: 'পার্টেক্স মেলামাইন বোর্ড',
      finish: 'ন্যাচারাল টিক',
      description: 'টেস্ট এআই ফার্নিচার প্রডাক্ট',
      furniture_cutlist: cutlistPayload
    }
  });

  assert.equal(createRes.status, 201);
  assert.equal(createRes.body.success, true);
  const createdId = createRes.body.product_id;

  // Verify fetch by ID has furniture_cutlist parsed
  const getRes = await request(`/api/products/${createdId}`);
  assert.equal(getRes.status, 200);
  assert.ok(getRes.body.product.furniture_cutlist);
  // The sent total_boards: 1 is ignored; the server packs these parts into 2 sheets.
  assert.equal(getRes.body.product.furniture_cutlist.total_boards, 2);
  assert.equal(getRes.body.product.furniture_cutlist.parts.length, 2);
  assert.equal(getRes.body.product.furniture_cutlist.parts[0].name, 'টপ বোর্ড');

  // Verify update works
  cutlistPayload.total_boards = 2;
  cutlistPayload.estimated_board_cost = 3600;
  const updateRes = await request(`/api/admin/products/${createdId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: {
      title: 'টেস্ট এআই কম্পিউটার টেবিল (আপডেটেড)',
      sku: 'FURN-TEST-AI-999',
      brand: 'SB Furniture',
      category: 'হোম ও অফিস ফার্নিচার',
      commission_tab: '100tk',
      regular_price: 5500,
      wholesale_price: 3600,
      reseller_commission: 600,
      stock: 10,
      furniture_cutlist: cutlistPayload
    }
  });

  assert.equal(updateRes.status, 200);
  assert.equal(updateRes.body.success, true);

  const getUpdatedRes = await request(`/api/products/${createdId}`);
  assert.equal(getUpdatedRes.body.product.furniture_cutlist.total_boards, 2);
  assert.equal(getUpdatedRes.body.product.furniture_cutlist.estimated_board_cost, 3600);

  // Clean up
  await run('DELETE FROM products WHERE id = ?', [createdId]);
});

test('Furniture AI 7: board rate is a shop setting used by the server recompute', async () => {
  const auth = { Authorization: `Bearer ${adminToken}` };
  const readRate = async () => {
    const res = await request('/api/admin/shop-settings', { headers: auth });
    assert.equal(res.status, 200);
    return res.body.settings.board_price;
  };

  assert.equal(await readRate(), 1800, 'a fresh database seeds the default board rate');
  assert.equal((await request('/api/admin/shop-settings')).status, 401);
  const invalid = await request('/api/admin/shop-settings', {
    method: 'PUT',
    headers: auth,
    body: { board_price: -5 }
  });
  assert.equal(invalid.status, 400);

  let createdId = null;
  try {
    const put = await request('/api/admin/shop-settings', {
      method: 'PUT',
      headers: auth,
      body: { board_price: 2500 }
    });
    assert.equal(put.status, 200);
    assert.equal(await readRate(), 2500);

    const create = await request('/api/admin/products', {
      method: 'POST',
      headers: auth,
      body: {
        title: 'টেস্ট শপ বোর্ড রেট টেবিল',
        sku: 'FURN-TEST-SHOPRATE-1',
        brand: 'SB Furniture',
        category: 'হোম ও অফিস ফার্নিচার',
        commission_tab: '100tk',
        regular_price: 4000,
        wholesale_price: 2000,
        reseller_commission: 500,
        stock: 5,
        furniture_cutlist: { parts: [{ name: 'টপ বোর্ড', length: 48, width: 24, qty: 1 }] }
      }
    });
    assert.equal(create.status, 201);
    createdId = create.body.product_id;

    const stored = (await request(`/api/products/${createdId}`)).body.product.furniture_cutlist;
    assert.equal(stored.board_price, 2500, 'a cut-list saved without a rate uses the shop rate');
    assert.equal(stored.estimated_board_cost, stored.total_boards * 2500);
  } finally {
    if (createdId) await run('DELETE FROM products WHERE id = ?', [createdId]);
    await request('/api/admin/shop-settings', { method: 'PUT', headers: auth, body: { board_price: 1800 } });
  }
  assert.equal(await readRate(), 1800, 'the board rate is restored for later tests');
});

test('Furniture AI 6: Server recomputes cut-list totals on save (hand-edited totals are ignored)', async () => {
  const parts = [
    { name: 'টপ বোর্ড', length: 48, width: 24, qty: 1 },
    { name: 'সাইড প্যানেল', length: 30, width: 24, qty: 2 }
  ];
  const expected = calculateCutlist(parts, { boardPrice: 1800 });

  const createRes = await request('/api/admin/products', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: {
      title: 'টেস্ট রিকম্পিউট ফার্নিচার',
      sku: 'FURN-TEST-RECOMP-001',
      brand: 'SB Furniture',
      category: 'হোম ও অফিস ফার্নিচার',
      commission_tab: '100tk',
      regular_price: 4500,
      wholesale_price: 1800,
      reseller_commission: 500,
      stock: 10,
      furniture_cutlist: {
        parts,
        total_boards: 1,
        estimated_board_cost: 1,
        total_area_sqft: '999.9',
        wastage_pct: 0,
        efficiency_pct: 100
      }
    }
  });
  assert.equal(createRes.status, 201);
  const createdId = createRes.body.product_id;

  try {
    const getRes = await request(`/api/products/${createdId}`);
    const stored = getRes.body.product.furniture_cutlist;
    assert.deepEqual(stored, expected, 'stored cut-list must be the server recomputation, not the posted totals');
    assert.equal(stored.total_boards, 2);
    assert.equal(stored.estimated_board_cost, 3600);

    // String payloads are recomputed too, and a changed board rate reprices the boards.
    const updateRes = await request(`/api/admin/products/${createdId}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: {
        title: 'টেস্ট রিকম্পিউট ফার্নিচার (আপডেটেড)',
        sku: 'FURN-TEST-RECOMP-001',
        brand: 'SB Furniture',
        category: 'হোম ও অফিস ফার্নিচার',
        commission_tab: '100tk',
        regular_price: 5000,
        wholesale_price: 2000,
        reseller_commission: 500,
        stock: 10,
        furniture_cutlist: JSON.stringify({
          parts: [
            { name: 'টপ বোর্ড', length: 48, width: 24, qty: 1 },
            { name: 'লম্বা ব্যাক প্যানেল', length: 100, width: 20, qty: 1 }
          ],
          board_price: 2000,
          total_boards: 99,
          estimated_board_cost: 1
        })
      }
    });
    assert.equal(updateRes.status, 200);

    const updated = (await request(`/api/products/${createdId}`)).body.product.furniture_cutlist;
    const expectedUpdate = calculateCutlist(
      [
        { name: 'টপ বোর্ড', length: 48, width: 24, qty: 1 },
        { name: 'লম্বা ব্যাক প্যানেল', length: 100, width: 20, qty: 1 }
      ],
      { boardPrice: 2000 }
    );
    assert.deepEqual(updated, expectedUpdate);
    assert.equal(updated.board_price, 2000);
    assert.equal(updated.estimated_board_cost, updated.total_boards * 2000);
    assert.equal(updated.parts[1].fits, false, 'an oversize part is persisted with fits: false');
    assert.equal(updated.warnings.length, 1);
  } finally {
    await run('DELETE FROM products WHERE id = ?', [createdId]);
  }
});
