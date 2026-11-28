require('./testEnv');

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const app = require('../src/server');
const { initDb, run, closeDb } = require('../src/db');
const { seedData } = require('../src/seed');
const config = require('../src/config');

let server;
let baseUrl;

const request = (path, options = {}) => new Promise((resolve, reject) => {
  const url = new URL(path, baseUrl);
  const req = http.request(url, {
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  }, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      try {
        resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body) });
      } catch {
        resolve({ status: res.statusCode, headers: res.headers, body });
      }
    });
  });
  req.on('error', reject);
  if (options.body) req.write(JSON.stringify(options.body));
  req.end();
});

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
  if (server) await new Promise((resolve) => server.close(resolve));
  await closeDb();
});

test('customer accounts see only product prices until an admin grants reseller permission', async () => {
  const adminLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { phone: config.ADMIN.phone, password: config.ADMIN.password }
  });
  assert.equal(adminLogin.status, 200);
  const adminToken = adminLogin.body.token;

  const productCreate = await request('/api/admin/products', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: {
      title: 'গোপন পার্টনার পণ্য',
      sku: 'PERM-SB-01',
      brand: 'SB POWER',
      category: 'ওয়্যারলেস অডিও ও গ্যাজেটস',
      regular_price: 990,
      reseller_commission: 150,
      wholesale_price: 700,
      stock: 10,
      shop_name: 'গোপন ভেন্ডর নাম',
      vendor_phone: '01870000222',
      vendor_address: 'গোপন ভেন্ডর ঠিকানা',
      vendor_badge: 'গোপন ব্যাজ'
    }
  });
  assert.equal(productCreate.status, 201);
  const productId = productCreate.body.product_id;

  const customerRegister = await request('/api/auth/register', {
    method: 'POST',
    body: { name: 'সাধারণ ক্রেতা', phone: '01870000111', password: 'customer123' }
  });
  assert.equal(customerRegister.status, 201);
  assert.equal(customerRegister.body.user.role, 'customer');
  const customerToken = customerRegister.body.token;

  const publicList = await request('/api/products?search=PERM-SB-01');
  assert.equal(publicList.status, 200);
  assert.equal(publicList.body.reseller_access, false);
  const publicProduct = publicList.body.products[0];
  assert.equal(publicProduct.regular_price, 990);
  for (const field of ['reseller_commission', 'commission_tab', 'wholesale_price', 'shop_id', 'shop_name', 'shop_type', 'vendor_phone', 'vendor_badge', 'vendor_address']) {
    assert.equal(publicProduct[field], undefined, `${field} must stay private on the customer catalog`);
  }
  // Anonymous catalog responses are safe to cache briefly; signed-in responses
  // can carry reseller-only fields and must never be shared.
  assert.match(publicList.headers['cache-control'], /public, max-age=60/);

  const customerList = await request('/api/products?search=PERM-SB-01', {
    headers: { Authorization: `Bearer ${customerToken}` }
  });
  assert.equal(customerList.status, 200);
  assert.match(customerList.headers['cache-control'], /no-store/);
  assert.equal(customerList.body.account_role, 'customer');
  assert.equal(customerList.body.products[0].reseller_commission, undefined);

  const customerDetail = await request(`/api/products/${productId}`, {
    headers: { Authorization: `Bearer ${customerToken}` }
  });
  assert.equal(customerDetail.status, 200);
  assert.equal(customerDetail.body.product.reseller_commission, undefined);
  assert.doesNotMatch(customerDetail.body.product.share_copy, /গোপন ভেন্ডর নাম|গোপন ভেন্ডর ঠিকানা|01870000222/);

  const customerCommissionSort = await request('/api/products?sort=commission_desc', {
    headers: { Authorization: `Bearer ${customerToken}` }
  });
  assert.equal(customerCommissionSort.status, 403);
  const customerWallet = await request('/api/wallet/summary', {
    headers: { Authorization: `Bearer ${customerToken}` }
  });
  assert.equal(customerWallet.status, 403);

  const customerOrder = await request('/api/orders', {
    method: 'POST',
    headers: { Authorization: `Bearer ${customerToken}` },
    body: {
      customer_name: 'সাধারণ ক্রেতা',
      customer_phone: '01870000111',
      delivery_address: 'কালীগঞ্জ, গাজীপুর',
      delivery_city: 'inside_dhaka',
      items: [{ product_id: productId, quantity: 1, unit_price: 1 }]
    }
  });
  assert.equal(customerOrder.status, 201);
  assert.equal(customerOrder.body.order.subtotal_amount, 990);
  assert.equal(customerOrder.body.order.total_amount, 1070);
  assert.equal(customerOrder.body.order.reseller_commission, undefined);
  assert.equal(customerOrder.body.order.reseller_id, undefined);

  const customerTracking = await request('/api/orders/track', {
    method: 'POST',
    body: { order_number: customerOrder.body.order.order_number, phone: '01870000111' }
  });
  assert.equal(customerTracking.status, 200);
  assert.equal(customerTracking.body.order.items[0].unit_price, 990);
  for (const field of ['commission_per_unit', 'unit_commission', 'unit_wholesale_price', 'shop_name', 'shop_type', 'shop_id']) {
    assert.equal(customerTracking.body.order.items[0][field], undefined, `${field} must stay private in customer order tracking`);
  }

  const meta = await request('/api/products/meta/categories');
  assert.equal(meta.status, 200);
  assert.equal(meta.body.shops, undefined);

  const grantPermission = await request(`/api/admin/users/${customerRegister.body.user.id}/role`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: { role: 'reseller' }
  });
  assert.equal(grantPermission.status, 200);

  const resellerList = await request('/api/products?search=PERM-SB-01', {
    headers: { Authorization: `Bearer ${customerToken}` }
  });
  assert.equal(resellerList.status, 200);
  assert.equal(resellerList.body.reseller_access, true);
  assert.equal(resellerList.body.account_role, 'reseller');
  assert.equal(resellerList.body.products[0].reseller_commission, 150);
  assert.equal(resellerList.body.products[0].shop_name, undefined);
  assert.equal(resellerList.body.products[0].vendor_address, undefined);

  const resellerWallet = await request('/api/wallet/summary', {
    headers: { Authorization: `Bearer ${customerToken}` }
  });
  assert.equal(resellerWallet.status, 200);

  const revokePermission = await request(`/api/admin/users/${customerRegister.body.user.id}/role`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: { role: 'customer' }
  });
  assert.equal(revokePermission.status, 200);

  const revokedList = await request('/api/products?search=PERM-SB-01', {
    headers: { Authorization: `Bearer ${customerToken}` }
  });
  assert.equal(revokedList.body.reseller_access, false);
  assert.equal(revokedList.body.products[0].reseller_commission, undefined);
  const revokedWallet = await request('/api/wallet/summary', {
    headers: { Authorization: `Bearer ${customerToken}` }
  });
  assert.equal(revokedWallet.status, 403);

  await run('DELETE FROM order_status_logs WHERE order_id = ?', [customerOrder.body.order.id]);
  await run('DELETE FROM order_items WHERE order_id = ?', [customerOrder.body.order.id]);
  await run('DELETE FROM orders WHERE id = ?', [customerOrder.body.order.id]);
  await run('DELETE FROM products WHERE id = ?', [productId]);
});
