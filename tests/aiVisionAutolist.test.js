require('./testEnv');

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const app = require('../src/server');
const { initDb, run, get, closeDb } = require('../src/db');
const { hashPassword } = require('../src/auth');
const { inspectProductImageWithAi } = require('../src/services/aiRouter');

let server;
let baseUrl;
let adminToken;
let testProductId;
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
      "INSERT INTO users (name, phone, password_hash, role, referral_code) VALUES ('Admin User', '01999887766', ?, 'admin', 'SBADMINVISION')",
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

  // Insert a test product for quick-update testing
  const pResult = await run(
    `INSERT INTO products (title, sku, brand, category, regular_price, wholesale_price, reseller_commission, stock, image_url)
     VALUES ('Quick Update Test Product', 'QUICK-TEST-001', 'SB Furniture', 'হোম ও অফিস ফার্নিচার', 500000, 300000, 50000, 20, 'https://images.unsplash.com/photo-1594026112284-02bb6f3352fe')`
  );
  testProductId = pResult.lastID;
});

after(async () => {
  if (testProductId) {
    await run('DELETE FROM products WHERE id = ?', [testProductId]);
  }
  if (server) server.close();
  closeDb();
});

test('AI Vision 1: inspectProductImageWithAi extracts structured attributes and cut-list', async () => {
  const result = await inspectProductImageWithAi({
    imageUrl: 'https://images.unsplash.com/photo-1594026112284-02bb6f3352fe?w=400',
    boardPrice: 1800
  });

  assert.equal(result.success, true);
  assert.ok(result.title);
  assert.ok(result.category);
  assert.equal(typeof result.is_furniture, 'boolean');
  assert.ok(result.materials);
  assert.ok(result.finish);
  assert.ok(result.description);
  assert.ok(result.provider_used);

  if (result.is_furniture) {
    assert.ok(result.cutlist);
    assert.equal(typeof result.cutlist.total_boards, 'number');
  }
});

test('AI Vision 2: POST /api/admin/ai/inspect-image endpoint authentication and payload validation', async () => {
  // Unauthorized request should fail
  const unauthRes = await request('/api/admin/ai/inspect-image', {
    method: 'POST',
    body: { image_url: 'https://images.unsplash.com/photo-1594026112284-02bb6f3352fe' }
  });
  assert.equal(unauthRes.status, 401);

  // Missing image should return 400
  const badRes = await request('/api/admin/ai/inspect-image', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: {}
  });
  assert.equal(badRes.status, 400);

  // Valid image URL inspect request
  const res = await request('/api/admin/ai/inspect-image', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: {
      image_url: 'https://images.unsplash.com/photo-1594026112284-02bb6f3352fe?w=400',
      board_price: 1800
    }
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.ok(res.body.analysis);
  assert.ok(res.body.analysis.title);
  assert.ok(res.body.analysis.category);
});

test('AI Vision 3: PATCH /api/admin/products/:id/quick-update updates stock and price cleanly', async () => {
  // Update stock to 45 and price to 5500
  const updateRes = await request(`/api/admin/products/${testProductId}/quick-update`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: {
      stock: 45,
      regular_price: 5500
    }
  });

  assert.equal(updateRes.status, 200);
  assert.equal(updateRes.body.success, true);
  assert.equal(updateRes.body.product.stock, 45);
  assert.equal(updateRes.body.product.regular_price, 5500);

  // Verify in database directly
  const dbProd = await get('SELECT stock, regular_price FROM products WHERE id = ?', [testProductId]);
  assert.equal(dbProd.stock, 45);
  assert.equal(dbProd.regular_price, 550000); // Paisa conversion checked
});
