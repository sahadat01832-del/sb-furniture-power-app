require('./testEnv');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const app = require('../src/server');
const { seedData } = require('../src/seed');
const { run } = require('../src/db');

let server;
let baseUrl;
let adminToken;

async function req(routePath, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const res = await fetch(`${baseUrl}${routePath}`, {
    ...options,
    headers,
    body: options.body && typeof options.body === 'object' ? JSON.stringify(options.body) : options.body
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: res.status, body, text };
}

test.before(async () => {
  await seedData({ includeDemoProducts: true });
  await new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  const login = await req('/api/auth/login', {
    method: 'POST',
    body: {
      phone: process.env.ADMIN_PHONE,
      password: process.env.ADMIN_PASSWORD
    }
  });
  adminToken = login.body.token;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('Frontend 1: Every browser JS script in public/js and public-admin/js has valid JS syntax', () => {
  for (const dirRel of ['public/js', 'public-admin/js']) {
    const dirAbs = path.join(__dirname, '..', dirRel);
    const files = fs.readdirSync(dirAbs).filter((f) => f.endsWith('.js'));
    assert.ok(files.length > 0, `Expected JS files in ${dirRel}`);
    for (const file of files) {
      const fullPath = path.join(dirAbs, file);
      assert.doesNotThrow(
        () => execFileSync(process.execPath, ['--check', fullPath], { stdio: 'pipe' }),
        `Syntax check failed for ${dirRel}/${file}`
      );
    }
  }
});

test('Frontend 2: Service Worker ASSETS_TO_CACHE entries all exist in public/ and public-admin/', () => {
  for (const folder of ['public', 'public-admin']) {
    const swPath = path.join(__dirname, '..', folder, 'sw.js');
    const content = fs.readFileSync(swPath, 'utf8');
    const match = content.match(/ASSETS_TO_CACHE\s*=\s*\[([\s\S]*?)\]/);
    assert.ok(match, `ASSETS_TO_CACHE not found in ${folder}/sw.js`);
    const entries = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    assert.ok(entries.length > 0);
    for (const entry of entries) {
      if (entry === '/') continue;
      const targetPath = path.join(__dirname, '..', folder, entry.replace(/^\/+/, ''));
      assert.ok(fs.existsSync(targetPath), `Missing SW cached asset ${folder}${entry}`);
    }
  }
});

test('Auth & Admin 3: Logout invalidates Bearer JWT immediately and admin can reset customer password', async () => {
  const uniquePhone = `017${String(Math.floor(10000000 + Math.random() * 89999999))}`;
  const reg = await req('/api/auth/register', {
    method: 'POST',
    body: {
      name: 'রিসেট টেস্ট ক্রেতা',
      phone: uniquePhone,
      password: 'OldPassword123'
    }
  });
  assert.equal(reg.status, 201);
  const oldToken = reg.body.token;
  const userId = reg.body.user.id;

  const logoutRes = await req('/api/auth/logout', {
    method: 'POST',
    headers: { Authorization: `Bearer ${oldToken}` }
  });
  assert.equal(logoutRes.status, 200);

  const afterLogout = await req('/api/auth/session', {
    headers: { Authorization: `Bearer ${oldToken}` }
  });
  assert.equal(afterLogout.body.authenticated, false);

  const resetRes = await req(`/api/admin/users/${userId}/password`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: { new_password: 'NewPassword123' }
  });
  assert.equal(resetRes.status, 200);

  const loginNew = await req('/api/auth/login', {
    method: 'POST',
    body: { phone: uniquePhone, password: 'NewPassword123' }
  });
  assert.equal(loginNew.status, 200);

  await run('DELETE FROM users WHERE id = ?', [userId]);
});

test('Product Lifecycle 4: Soft delete, re-activate, permanent delete frees SKU and cleans unused upload', async () => {
  // Upload a valid 1x1 PNG draft photo
  const tinyPngBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const upTemp = await req('/api/admin/upload-image', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: { image: tinyPngBase64 }
  });
  assert.equal(upTemp.status, 200);
  const tempUrl = upTemp.body.url;
  const tempFile = path.join(__dirname, '..', 'public', tempUrl.replace(/^\/+/, ''));
  assert.ok(fs.existsSync(tempFile));

  // Delete abandoned draft upload directly
  const delTemp = await req('/api/admin/upload-image', {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: { url: tempUrl }
  });
  assert.equal(delTemp.status, 200);
  assert.equal(delTemp.body.deleted, true);
  assert.equal(fs.existsSync(tempFile), false);

  // Upload photo for an actual product
  const upProd = await req('/api/admin/upload-image', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: { image: tinyPngBase64 }
  });
  assert.equal(upProd.status, 200);
  const prodImageUrl = upProd.body.url;
  const prodImageFile = path.join(__dirname, '..', 'public', prodImageUrl.replace(/^\/+/, ''));

  const testSku = `SBP-LIFE-${Date.now()}`;
  const created = await req('/api/admin/products', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: {
      title: 'লাইফসাইকেল টেস্ট প্রোডাক্ট',
      sku: testSku,
      brand: 'SB POWER',
      category: 'ওয়্যারলেস অডিও ও গ্যাজেটস',
      regular_price: 900,
      wholesale_price: 600,
      reseller_commission: 100,
      commission_tab: '100tk',
      image_url: prodImageUrl,
      stock: 10
    }
  });
  assert.equal(created.status, 201);
  const pid = created.body.product_id;

  // Trying to clean an image still referenced by a product must refuse
  const refusedCleanup = await req('/api/admin/upload-image', {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: { url: prodImageUrl }
  });
  assert.equal(refusedCleanup.body.deleted, false);
  assert.ok(fs.existsSync(prodImageFile));

  // Soft delete -> inactive
  const softDel = await req(`/api/admin/products/${pid}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(softDel.status, 200);
  assert.equal(softDel.body.softDeleted, true);

  // Re-activate cleanly
  const reactivate = await req(`/api/admin/products/${pid}/status`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: { is_active: 1 }
  });
  assert.equal(reactivate.status, 200);
  assert.equal(reactivate.body.is_active, 1);

  // Permanent delete removes row, frees SKU, and deletes unreferenced upload file
  const permDel = await req(`/api/admin/products/${pid}?permanent=true`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(permDel.status, 200);
  assert.equal(permDel.body.softDeleted, false);
  assert.equal(fs.existsSync(prodImageFile), false);

  const checkAfter = await req(`/api/products/sku/${encodeURIComponent(testSku)}`);
  assert.equal(checkAfter.status, 404);
});
