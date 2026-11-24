require('./testEnv');

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const app = require('../src/server');
const { initDb, run, get, closeDb } = require('../src/db');
const { hashPassword } = require('../src/auth');
const { calculateCutlist, generateParametricCutlist } = require('../src/services/cutlistCalculator');
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

test('Furniture AI 2: Parametric Baseline Cutlist Generator for Furniture Types', () => {
  const shelfParts = generateParametricCutlist('বুকশেলফ', { height: 72, width: 36, depth: 12 });
  assert.ok(Array.isArray(shelfParts));
  assert.ok(shelfParts.length >= 3, 'Shelf should have multiple parts');
  assert.ok(shelfParts[0].name.includes('সাইড প্যানেল'));

  const tableParts = generateParametricCutlist('কম্পিউটার টেবিল', { height: 30, width: 48, depth: 24 });
  assert.ok(Array.isArray(tableParts));
  assert.ok(tableParts.length >= 3, 'Table should have multiple parts');
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
  assert.equal(getRes.body.product.furniture_cutlist.total_boards, 1);
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
