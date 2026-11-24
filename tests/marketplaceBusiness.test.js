require('./testEnv');

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const app = require('../src/server');
const { initDb, run, get, query, closeDb } = require('../src/db');
const { seedData } = require('../src/seed');
const config = require('../src/config');
const { registerReseller } = require('./resellerTestHelpers');

let server;
let baseUrl;

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
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
};

before(async () => {
  await initDb();
  await seedData({ includeDemoProducts: true });

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
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

test('Marketplace 1: 3-Way Profit Engine & Order Accounting Snapshot', async () => {
  // Login as admin
  const adminLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { phone: config.ADMIN.phone, password: config.ADMIN.password }
  });
  assert.equal(adminLogin.status, 200);
  const adminToken = adminLogin.body.token;

  // 1. Create a partner shop product with explicit wholesale_price: ৳400, selling_price: ৳600, commission: ৳100
  const createProdRes = await request('/api/admin/products', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: {
      title: 'টেস্ট পার্টনার স্মার্ট লাইট',
      sku: 'TEST-PLIGHT-01',
      brand: 'SB POWER',
      category: 'ওয়্যারলেস অডিও ও গ্যাজেটস',
      regular_price: 600,
      reseller_commission: 100,
      wholesale_price: 400,
      shop_name: 'আলিফ গ্যাজেট শপ',
      stock: 50
    }
  });
  assert.equal(createProdRes.status, 201);
  const partnerProdId = createProdRes.body.product_id;

  // 2. Register a reseller
  const resReg = await registerReseller(request, { name: 'রিসেলার রাসেল', phone: '01888001122', password: 'password123' });
  assert.equal(resReg.status, 201);
  const resellerToken = resReg.body.token;
  const resellerId = resReg.body.user.id;

  // 3. Reseller places order for a customer (quantity: 2)
  const orderRes = await request('/api/orders', {
    method: 'POST',
    headers: { Authorization: `Bearer ${resellerToken}` },
    body: {
      customer_name: 'কাস্টমার কবির',
      customer_phone: '01799887766',
      delivery_address: 'উত্তরা সেক্টর ৭, ঢাকা',
      delivery_city: 'inside_dhaka',
      items: [{ product_id: partnerProdId, quantity: 2 }]
    }
  });
  assert.equal(orderRes.status, 201);
  const orderId = orderRes.body.order.id;
  assert.equal(orderRes.body.order.total_amount, 1280); // 600*2 + 80 delivery
  assert.equal(orderRes.body.order.reseller_commission, 200); // 100*2

  // 4. Verify Database Snapshot Values:
  // Selling: 600*2 = 1200, Wholesale: 400*2 = 800, Commission: 100*2 = 200, Net Profit = 1200 - 800 - 200 = 200
  const orderDb = await get('SELECT * FROM orders WHERE id = ?', [orderId]);
  assert.equal(orderDb.total_wholesale_amount, 80000); // 800 paisa
  assert.equal(orderDb.total_reseller_commission, 20000); // 200 paisa
  assert.equal(orderDb.platform_net_profit, 20000); // 200 paisa
  assert.equal(orderDb.commission_released, 0);

  const itemDb = await get('SELECT * FROM order_items WHERE order_id = ?', [orderId]);
  assert.equal(itemDb.unit_selling_price, 60000);
  assert.equal(itemDb.unit_wholesale_price, 40000);
  assert.equal(itemDb.unit_commission, 10000);
  assert.equal(itemDb.platform_net_profit, 20000); // (600 - 400 - 100) * 2 = 200
  assert.equal(itemDb.shop_type, 'partner');
  assert.equal(itemDb.shop_name, 'আলিফ গ্যাজেট শপ');

  // 5. Verify Pending commission in wallet_transactions
  const walletTx = await get('SELECT * FROM wallet_transactions WHERE order_id = ?', [orderId]);
  assert.ok(walletTx);
  assert.equal(walletTx.amount, 20000);
  assert.equal(walletTx.status, 'pending');

  // 6. Cleanup
  await run('DELETE FROM order_items WHERE order_id = ?', [orderId]);
  await run('DELETE FROM wallet_transactions WHERE order_id = ?', [orderId]);
  await run('DELETE FROM order_status_logs WHERE order_id = ?', [orderId]);
  await run('DELETE FROM orders WHERE id = ?', [orderId]);
  await run('DELETE FROM products WHERE id = ?', [partnerProdId]);
});

test('Marketplace 2: Strict Privacy - Reseller APIs NEVER leak wholesale or profit numbers', async () => {
  // Login as admin to fetch a real product
  const adminLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { phone: config.ADMIN.phone, password: config.ADMIN.password }
  });
  const adminToken = adminLogin.body.token;

  // Create product with wholesale price
  const prodRes = await request('/api/admin/products', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: {
      title: 'সিক্রেট মার্জিন পণ্য',
      sku: 'SECRET-001',
      brand: 'SB Furniture',
      category: 'হোম ও অফিস ফার্নিচার',
      regular_price: 10000,
      reseller_commission: 1000,
      wholesale_price: 7000,
      stock: 20
    }
  });
  assert.equal(prodRes.status, 201);
  const prodId = prodRes.body.product_id;

  // 1. Public customers see original prices; reseller commission is private.
  const publicList = await request('/api/products?search=SECRET-001');
  assert.equal(publicList.status, 200);
  const foundItem = publicList.body.products.find((p) => p.sku === 'SECRET-001');
  assert.ok(foundItem);
  assert.equal(foundItem.regular_price, 10000);
  assert.equal(foundItem.reseller_commission, undefined);
  assert.equal(foundItem.wholesale_price, undefined, 'wholesale_price must NEVER leak to public/resellers');
  assert.equal(foundItem.platform_net_profit, undefined, 'platform_net_profit must NEVER leak to public/resellers');

  const reseller = await registerReseller(request, {
    name: 'অনুমোদিত প্রাইভেসি পরীক্ষক',
    phone: '01888001123',
    password: 'password123'
  });
  const resellerList = await request('/api/products?search=SECRET-001', {
    headers: { Authorization: `Bearer ${reseller.body.token}` }
  });
  const resellerItem = resellerList.body.products.find((p) => p.sku === 'SECRET-001');
  assert.equal(resellerItem.reseller_commission, 1000);
  assert.equal(resellerItem.wholesale_price, undefined);

  // 2. Check Single Product Endpoint: GET /api/products/:sku
  const singleItem = await request('/api/products/SECRET-001', {
    headers: { Authorization: `Bearer ${reseller.body.token}` }
  });
  assert.equal(singleItem.status, 200);
  assert.equal(singleItem.body.product.wholesale_price, undefined);
  assert.equal(singleItem.body.product.platform_net_profit, undefined);

  // 3. Admin product endpoint DOES show wholesale_price and platform_net_profit
  const adminList = await request('/api/admin/products?search=SECRET-001', {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(adminList.status, 200);
  const adminItem = adminList.body.products.find((p) => p.sku === 'SECRET-001');
  assert.ok(adminItem);
  assert.equal(adminItem.wholesale_price, 7000);
  assert.equal(adminItem.platform_net_profit, 2000); // 10000 - 7000 - 1000 = 2000

  // 4. Cleanup
  await run('DELETE FROM products WHERE id = ?', [prodId]);
});

test('Marketplace 3: Instant Release Commission & Delivery Idempotency (No Double-Credit)', async () => {
  const adminLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { phone: config.ADMIN.phone, password: config.ADMIN.password }
  });
  const adminToken = adminLogin.body.token;

  // Register reseller
  const regRes = await registerReseller(request, { name: 'রিসেলার রিফাত', phone: '01877665544', password: 'password123' });
  const resToken = regRes.body.token;
  const resellerId = regRes.body.user.id;

  // Get a product
  const prod = await get("SELECT * FROM products WHERE is_active = 1 LIMIT 1");

  // Place order
  const ordRes = await request('/api/orders', {
    method: 'POST',
    headers: { Authorization: `Bearer ${resToken}` },
    body: {
      customer_name: 'গ্রাহক তারেক',
      customer_phone: '01711223344',
      delivery_address: 'মিরপুর ২, ঢাকা',
      delivery_city: 'inside_dhaka',
      items: [{ product_id: prod.id, quantity: 1 }]
    }
  });
  assert.equal(ordRes.status, 201);
  const orderId = ordRes.body.order.id;

  // Reseller wallet summary: pending should be positive, available 0
  let summaryRes = await request('/api/wallet/summary', {
    headers: { Authorization: `Bearer ${resToken}` }
  });
  assert.equal(summaryRes.status, 200);
  assert.equal(summaryRes.body.summary.available_balance, 0);
  assert.ok(summaryRes.body.summary.pending_commission > 0);
  const commAmount = summaryRes.body.summary.pending_commission;

  // Admin executes Instant Release Commission: POST /api/admin/orders/:id/release-commission
  const releaseRes = await request(`/api/admin/orders/${orderId}/release-commission`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(releaseRes.status, 200);
  assert.equal(releaseRes.body.success, true);

  // Reseller wallet summary: available must now have commAmount, pending must be 0
  summaryRes = await request('/api/wallet/summary', {
    headers: { Authorization: `Bearer ${resToken}` }
  });
  assert.equal(summaryRes.body.summary.available_balance, commAmount);
  assert.equal(summaryRes.body.summary.pending_commission, 0);

  // Calling Instant Release a SECOND time must be rejected (idempotent / fraud safe)
  const secondRelease = await request(`/api/admin/orders/${orderId}/release-commission`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(secondRelease.status, 400);

  // Later, when order is marked 'delivered', verify NO double-credit
  const deliverRes = await request(`/api/admin/orders/${orderId}/status`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: { status: 'delivered' }
  });
  assert.equal(deliverRes.status, 200);

  summaryRes = await request('/api/wallet/summary', {
    headers: { Authorization: `Bearer ${resToken}` }
  });
  assert.equal(summaryRes.body.summary.available_balance, commAmount, 'Balance must not double on status delivered');
});

test('Marketplace 4: Withdrawal Request, Admin Approval & Rejection with Wallet Integrity', async () => {
  const adminLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { phone: config.ADMIN.phone, password: config.ADMIN.password }
  });
  const adminToken = adminLogin.body.token;

  // Register reseller
  const phone = '01855443322';
  const regRes = await registerReseller(request, { name: 'ক্যাশআউট পরীক্ষক', phone, password: 'password123' });
  const resToken = regRes.body.token;
  const resellerId = regRes.body.user.id;

  // Credit 500 Taka directly to available balance for testing
  await run(
    `INSERT INTO wallet_transactions (user_id, amount, type, status, notes)
     VALUES (?, 50000, 'commission', 'available', 'টেস্ট ব্যালেন্স')`,
    [resellerId]
  );

  // Check summary: available = 500
  let summary = await request('/api/wallet/summary', { headers: { Authorization: `Bearer ${resToken}` } });
  assert.equal(summary.body.summary.available_balance, 500);

  // 1. Reseller requests payout of 200 Taka via bKash
  const payoutReq = await request('/api/wallet/payout-request', {
    method: 'POST',
    headers: { Authorization: `Bearer ${resToken}` },
    body: {
      amount: 200,
      payment_method: 'bkash',
      account_number: '01855443322'
    }
  });
  assert.equal(payoutReq.status, 201);
  const payoutId = payoutReq.body.payout_id;

  // Available balance should immediately drop to 300
  summary = await request('/api/wallet/summary', { headers: { Authorization: `Bearer ${resToken}` } });
  assert.equal(summary.body.summary.available_balance, 300);

  // 2. Admin rejects this payout request (with reason)
  const rejectRes = await request(`/api/admin/payouts/${payoutId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: { status: 'rejected', notes: 'ভুল পার্সোনাল নম্বর' }
  });
  assert.equal(rejectRes.status, 200);

  // Available balance should be refunded atomically back to 500
  summary = await request('/api/wallet/summary', { headers: { Authorization: `Bearer ${resToken}` } });
  assert.equal(summary.body.summary.available_balance, 500);

  // 3. Reseller requests payout of 300 Taka via Nagad
  const secondPayoutReq = await request('/api/wallet/payout-request', {
    method: 'POST',
    headers: { Authorization: `Bearer ${resToken}` },
    body: {
      amount: 300,
      payment_method: 'nagad',
      account_number: '01855443322'
    }
  });
  assert.equal(secondPayoutReq.status, 201);
  const secondPayoutId = secondPayoutReq.body.payout_id;

  // 4. Admin approves this payout with TrxID
  const approveRes = await request(`/api/admin/payouts/${secondPayoutId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: { status: 'approved', admin_trx_id: 'NAGAD12345678' }
  });
  assert.equal(approveRes.status, 200);

  // Balance remains 200 and total withdrawn is 300
  summary = await request('/api/wallet/summary', { headers: { Authorization: `Bearer ${resToken}` } });
  assert.equal(summary.body.summary.available_balance, 200);
  assert.equal(summary.body.summary.total_withdrawn, 300);
});

test('Marketplace 5: Partner Shop Management & Wholesale Settlement Ledger', async () => {
  const adminLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { phone: config.ADMIN.phone, password: config.ADMIN.password }
  });
  const adminToken = adminLogin.body.token;

  // 1. Create a partner shop
  const shopRes = await request('/api/admin/shops', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: {
      name: 'ঢাকা ক্রাফট উড',
      shop_type: 'partner',
      phone: '01700112233',
      address: 'মিরপুর ২, ঢাকা',
      contact_person: 'কামাল হোসেন'
    }
  });
  assert.equal(shopRes.status, 201);
  const shopId = shopRes.body.id;

  // 2. Fetch shops list
  const listRes = await request('/api/admin/shops', {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(listRes.status, 200);
  const createdShop = listRes.body.shops.find((s) => s.id === shopId);
  assert.ok(createdShop);
  assert.equal(createdShop.name, 'ঢাকা ক্রাফট উড');
  assert.equal(createdShop.shop_type, 'partner');

  // 3. Settle wholesale payable for this partner shop
  const settleRes = await request(`/api/admin/shops/${shopId}/settle`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: {
      amount: 1500,
      trx_id: 'SETTLE-BKASH-9988',
      notes: 'নভেম্বর ১ম পক্ষ পাইকারি বিল পরিশোধ'
    }
  });
  assert.equal(settleRes.status, 200);

  // 4. Verify settlement history
  const historyRes = await request(`/api/admin/shops/${shopId}/settlements`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(historyRes.status, 200);
  assert.equal(historyRes.body.settlements.length, 1);
  assert.equal(historyRes.body.settlements[0].amount, 1500);
  assert.equal(historyRes.body.settlements[0].trx_id, 'SETTLE-BKASH-9988');
});

test('Marketplace 6: Suspended User Account Control', async () => {
  const adminLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { phone: config.ADMIN.phone, password: config.ADMIN.password }
  });
  const adminToken = adminLogin.body.token;

  // 1. Register a reseller
  const regRes = await registerReseller(request, { name: 'সাসপেন্ড ইউজার', phone: '01899112233', password: 'password123' });
  const userToken = regRes.body.token;
  const userId = regRes.body.user.id;

  // 2. User can access wallet initially
  let testRes = await request('/api/wallet/summary', {
    headers: { Authorization: `Bearer ${userToken}` }
  });
  assert.equal(testRes.status, 200);

  // 3. Admin suspends this reseller
  const suspendRes = await request(`/api/admin/resellers/${userId}/status`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: { status: 'suspended' }
  });
  assert.equal(suspendRes.status, 200);

  // 4. Token requests must now be blocked with 403
  testRes = await request('/api/wallet/summary', {
    headers: { Authorization: `Bearer ${userToken}` }
  });
  assert.equal(testRes.status, 403);

  // 5. User login attempt must be rejected with 403
  const loginRes = await request('/api/auth/login', {
    method: 'POST',
    body: { phone: '01899112233', password: 'password123' }
  });
  assert.equal(loginRes.status, 403);
});
