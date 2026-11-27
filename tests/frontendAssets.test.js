require('./testEnv');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');
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

test('Frontend 5: Storefront SEO files, Open Graph metadata, JSON-LD schema, and admin noindex', () => {
  const rootDir = path.join(__dirname, '..');
  const robotsTxt = fs.readFileSync(path.join(rootDir, 'public', 'robots.txt'), 'utf8');
  assert.match(robotsTxt, /^Allow:\s*\/$/m);
  assert.match(robotsTxt, /^Disallow:\s*\/admin$/m);
  assert.match(robotsTxt, /^Sitemap:\s*https:\/\/sb-power-marketplace\.web\.app\/sitemap\.xml$/m);

  const sitemapXml = fs.readFileSync(path.join(rootDir, 'public', 'sitemap.xml'), 'utf8');
  assert.match(sitemapXml, /<loc>https:\/\/sb-power-marketplace\.web\.app\/<\/loc>/);

  const indexHtml = fs.readFileSync(path.join(rootDir, 'public', 'index.html'), 'utf8');
  assert.match(indexHtml, /<title>SB Power BD/);
  assert.match(indexHtml, /rel="canonical" href="https:\/\/sb-power-marketplace\.web\.app\/"/);
  assert.match(indexHtml, /property="og:title" content="SB Power BD/);
  assert.match(indexHtml, /property="og:image" content="https:\/\/sb-power-marketplace\.web\.app\/icons\/icon-512\.png"/);

  const ldMatch = indexHtml.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(ldMatch, 'Expected JSON-LD structured data script in public/index.html');
  const schema = JSON.parse(ldMatch[1]);
  assert.equal(schema['@type'], 'Store');
  assert.equal(schema.name, 'SB Power BD');
  assert.equal(schema.url, 'https://sb-power-marketplace.web.app/');

  for (const adminFile of ['public/admin.html', 'public-admin/index.html']) {
    const adminHtml = fs.readFileSync(path.join(rootDir, adminFile), 'utf8');
    assert.match(adminHtml, /<meta name="robots" content="noindex, nofollow">/);
  }
});

test('Frontend 6: Admin modals, light-mode isolation, native prompt replacement, and public-admin parity', () => {
  const rootDir = path.join(__dirname, '..');
  const adminCss = fs.readFileSync(path.join(rootDir, 'public', 'css', 'admin.css'), 'utf8');
  for (const selector of [
    '.modal-overlay',
    '.modal-overlay.active',
    '.modal-dialog',
    '#toast.toast-msg',
    '#toast.toast-msg.show',
    '.product-toolbar',
    '.status-badge',
    'html:has(body.admin-mode)'
  ]) {
    assert.ok(adminCss.includes(selector), `Expected ${selector} in public/css/admin.css`);
  }

  for (const adminFile of ['public/admin.html', 'public-admin/index.html']) {
    const html = fs.readFileSync(path.join(rootDir, adminFile), 'utf8');
    for (const token of [
      'class="admin-mode"',
      'id="adminLoginForm"',
      'id="btnToggleAdminPass"',
      'id="adminActionPromptModal"',
      'cutlist-calculator.js',
      'id="cutDbWarnings"',
      'id="furnCutlistWarnings"',
      'id="furnBoardPrice"',
      'id="cutDbBoardPrice"'
    ]) {
      assert.ok(html.includes(token), `Expected ${token} in ${adminFile}`);
    }
  }

  const adminJs = fs.readFileSync(path.join(rootDir, 'public', 'js', 'admin.js'), 'utf8');
  assert.doesNotMatch(adminJs, /\bwindow\.prompt\s*\(|\bconst\s+\w+\s*=\s*prompt\(/);
  assert.ok(adminJs.includes('openAdminPromptModal'));

  for (const relPath of [
    'css/admin.css',
    'css/style.css',
    'js/admin.js',
    'js/admin-users.js',
    'js/admin-referrals.js',
    'js/app-config.js'
  ]) {
    const pubContent = fs.readFileSync(path.join(rootDir, 'public', relPath), 'utf8');
    const apkContent = fs.readFileSync(path.join(rootDir, 'public-admin', relPath), 'utf8');
    assert.equal(apkContent, pubContent, `Expected public-admin/${relPath} to match public/${relPath}`);
  }
});

test('Frontend 7: app-config.js keeps Capacitor APKs off 127.0.0.1 and commission_tab resolves tiers', async () => {
  const rootDir = path.join(__dirname, '..');
  for (const cfgFile of ['public/js/app-config.js', 'public-admin/js/app-config.js']) {
    const code = fs.readFileSync(path.join(rootDir, cfgFile), 'utf8');
    const runConfig = (location, capacitor) => {
      const ctx = {
        window: {
          location,
          ...(capacitor !== undefined ? { Capacitor: capacitor } : {})
        }
      };
      ctx.window.window = ctx.window;
      vm.runInNewContext(code, ctx);
      return ctx.window.APP_CONFIG.VITE_DEV_API_URL;
    };

    assert.equal(runConfig({ protocol: 'http:', hostname: 'localhost' }), 'http://127.0.0.1:3000');
    assert.equal(runConfig({ protocol: 'http:', hostname: '127.0.0.1' }), 'http://127.0.0.1:3000');
    assert.equal(
      runConfig({ protocol: 'https:', hostname: 'localhost' }, { isNativePlatform: () => true }),
      ''
    );
    assert.equal(runConfig({ protocol: 'https:', hostname: 'localhost' }), '');
    assert.equal(runConfig({ protocol: 'https:', hostname: 'sb-power-marketplace.web.app' }), '');
  }

  const testSku = `TIER-TST-${Date.now()}`;
  const created = await req('/api/admin/products', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      title: 'Commission Tier Test Cabinet',
      sku: testSku,
      brand: 'SB Furniture',
      category: 'ফার্নিচার',
      regular_price: 5500,
      wholesale_price: 4000,
      reseller_commission: 250,
      stock: 5,
      image_url: '/uploads/tier-test.png',
      furniture_cutlist: {
        board_price: 1900,
        dimensions: { height: 70, width: 32, depth: 18 },
        parts: [{ name: 'Side Panel', length: 70, width: 18, qty: 2 }]
      }
    })
  });
  assert.equal(created.status, 201);
  const createdId = created.body.product_id;
  assert.ok(createdId);

  const prodRes = await req(`/api/products/${encodeURIComponent(testSku)}`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(prodRes.status, 200);
  assert.equal(prodRes.body.product.commission_tab, '200tk');
  assert.deepEqual(prodRes.body.product.furniture_cutlist.dimensions, { height: 70, width: 32, depth: 18 });

  const updated = await req(`/api/admin/products/${createdId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({
      furniture_cutlist: {
        board_price: 2000,
        dimensions: { height: 84, width: 42, depth: 20 },
        parts: [{ name: 'Side Panel', length: 70, width: 18, qty: 2 }]
      }
    })
  });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.body.furniture_cutlist.dimensions, { height: 84, width: 42, depth: 20 });

  await req(`/api/admin/products/${createdId}?permanent=true`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${adminToken}` }
  });
});
