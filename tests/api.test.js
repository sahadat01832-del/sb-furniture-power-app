require('./testEnv');

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const app = require('../src/server');
const { initDb, run, get, query } = require('../src/db');
const { seedData } = require('../src/seed');
const config = require('../src/config');

let server;
let baseUrl;

// Helper to make JSON HTTP requests
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
  // Clean transactional test data for fresh test isolation
  await run('DELETE FROM order_items');
  await run('DELETE FROM wallet_transactions');
  await run('DELETE FROM payout_requests');
  await run('DELETE FROM orders');
  await run("UPDATE users SET referred_by_id = NULL");
  await run("DELETE FROM users WHERE role != 'admin'");
  await run("DELETE FROM products WHERE sku LIKE 'SBF-999%'");

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
});

test('1. Health check endpoint responds healthy', async () => {
  const res = await request('/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'healthy');
  assert.ok(res.body.uptime >= 0);
});

test('2. Public brand config returns contacts and delivery rules', async () => {
  const res = await request('/api/config');
  assert.equal(res.status, 200);
  assert.equal(res.body.furniture.phone, '01929621855');
  assert.equal(res.body.power.phone, '01634664224');
  assert.equal(res.body.delivery.INSIDE_DHAKA_FURNITURE, 500);
  assert.equal(res.body.delivery.OUTSIDE_DHAKA_FURNITURE, 1000);
  assert.ok(!res.body.announcement.headline.includes('৫০৳'));
  assert.ok(!res.body.announcement.subtext.includes('প্রাইজ'));
});

test('3. Explicit demo catalog seed has 30 sample items and fixture prices', async () => {
  const res = await request('/api/products');
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.ok(res.body.count >= 30, `Expected at least 30 products, got ${res.body.count}`);

  // Check Section A: Shop decoration
  const shopDecoRes = await request('/api/products?category=' + encodeURIComponent('দোকান ডেকোরেশন'));
  assert.equal(shopDecoRes.body.count, 10);

  // Check Section B: Home & Office furniture
  const homeRes = await request('/api/products?category=' + encodeURIComponent('হোম ও অফিস ফার্নিচার'));
  assert.equal(homeRes.body.count, 10);

  // Check Section C: SB POWER gadgets
  const gadgetRes = await request('/api/products?brand=' + encodeURIComponent('SB POWER'));
  assert.equal(gadgetRes.body.count, 10);

  // Check stable test fixture values, not market or supplier pricing.
  const blackAirpods = gadgetRes.body.products.find((p) => p.sku === 'SBP-101');
  assert.ok(blackAirpods, 'AirPods Pro 2 Black must exist');
  assert.equal(blackAirpods.regular_price, 500, 'AirPods Pro 2 Black price must strictly be 500 TK');

  const whiteAirpods = gadgetRes.body.products.find((p) => p.sku === 'SBP-102');
  assert.ok(whiteAirpods, 'AirPods Pro 2 White must exist');
  assert.equal(whiteAirpods.regular_price, 450, 'AirPods Pro 2 White price must strictly be 450 TK');

  const p9Headset = gadgetRes.body.products.find((p) => p.sku === 'SBP-103');
  assert.ok(p9Headset, 'P9 Wireless Headset must exist');
  assert.equal(p9Headset.regular_price, 420, 'P9 Headset price must strictly be 420 TK');
  assert.ok(p9Headset.finish.includes('৪টি কালার') || p9Headset.description.includes('৪টি কালার'));
});

test('4. Reseller Commission Tabs filtering works correctly', async () => {
  const tabs = ['50tk', '100tk', '500tk', '1000tk'];
  for (const tab of tabs) {
    const res = await request(`/api/products?tab=${tab}`);
    assert.equal(res.status, 200);
    assert.ok(res.body.products.length > 0, `Tab ${tab} should contain products`);
    res.body.products.forEach((p) => {
      assert.equal(p.commission_tab, tab);
    });
  }
});

test('5. Auth: User registration and validation edge cases', async () => {
  // Empty name rejection
  const invalidNameRes = await request('/api/auth/register', {
    method: 'POST',
    body: { name: '', phone: '01711111111', password: 'password123' }
  });
  assert.equal(invalidNameRes.status, 400);

  // Short phone rejection
  const shortPhoneRes = await request('/api/auth/register', {
    method: 'POST',
    body: { name: 'রহিম', phone: '01711', password: 'password123' }
  });
  assert.equal(shortPhoneRes.status, 400);

  // Short password rejection
  const shortPassRes = await request('/api/auth/register', {
    method: 'POST',
    body: { name: 'রহিম', phone: '01711111111', password: '123' }
  });
  assert.equal(shortPassRes.status, 400);

  // Valid Registration: User 1 (Referrer)
  const phone1 = '01711000001';
  const reg1 = await request('/api/auth/register', {
    method: 'POST',
    body: { name: 'ম্যানেজার রহিম', phone: phone1, password: 'password123' }
  });
  assert.equal(reg1.status, 201);
  assert.ok(reg1.body.token);
  assert.ok(reg1.body.user.referral_code);
  const referrerCode = reg1.body.user.referral_code;

  // Duplicate phone rejection
  const dupRes = await request('/api/auth/register', {
    method: 'POST',
    body: { name: 'ডুপ্লিকেট রহিম', phone: phone1, password: 'password123' }
  });
  assert.equal(dupRes.status, 400);

  // Valid Registration: User 2 (Referred by User 1)
  const phone2 = '01711000002';
  const reg2 = await request('/api/auth/register', {
    method: 'POST',
    body: {
      name: 'রিসেলার করিম',
      phone: phone2,
      password: 'password123',
      referral_code: referrerCode
    }
  });
  assert.equal(reg2.status, 201);
  assert.equal(reg2.body.user.referred_by_id, reg1.body.user.id);

  // Login test
  const loginRes = await request('/api/auth/login', {
    method: 'POST',
    body: { phone: phone2, password: 'password123' }
  });
  assert.equal(loginRes.status, 200);
  assert.ok(loginRes.body.token);

  // Bad credentials login
  const badLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { phone: phone2, password: 'wrongpassword' }
  });
  assert.equal(badLogin.status, 401);
});

test('6. Order placement, optional advance, and delivery fee calculation', async () => {
  // Get product SBF-101 (Furniture) and SBP-101 (Gadget)
  const sbf = await get("SELECT * FROM products WHERE sku = 'SBF-101'");
  const sbp = await get("SELECT * FROM products WHERE sku = 'SBP-101'");

  // Place order containing furniture inside Dhaka -> delivery fee should be 500 TK
  const orderInsideDhaka = await request('/api/orders', {
    method: 'POST',
    body: {
      customer_name: 'কাস্টমার শাকিল',
      customer_phone: '01811223344',
      delivery_address: 'মিরপুর ১০, ঢাকা',
      delivery_city: 'inside_dhaka',
      advance_paid: 500,
      advance_trx_id: 'TRX987654321',
      items: [{ product_id: sbf.id, quantity: 1 }]
    }
  });
  assert.equal(orderInsideDhaka.status, 201);
  assert.equal(orderInsideDhaka.body.order.delivery_fee, 500);
  assert.equal(orderInsideDhaka.body.order.advance_paid, 500);

  // A furniture order can also use COD when no advance is agreed.
  const orderOutsideDhaka = await request('/api/orders', {
    method: 'POST',
    body: {
      customer_name: 'কাস্টমার রফিক',
      customer_phone: '01811223355',
      delivery_address: 'কালীগঞ্জ বাজার, গাজীপুর',
      delivery_city: 'outside_dhaka',
      advance_paid: 0,
      items: [{ product_id: sbf.id, quantity: 1 }]
    }
  });
  assert.equal(orderOutsideDhaka.status, 201);
  assert.equal(orderOutsideDhaka.body.order.delivery_fee, 1000);
  assert.equal(orderOutsideDhaka.body.order.advance_paid, 0);

  // Track order
  const trackRes = await request('/api/orders/track', {
    method: 'POST',
    body: {
      order_number: orderInsideDhaka.body.order.order_number,
      phone: '01811223344'
    }
  });
  assert.equal(trackRes.status, 200);
  assert.equal(trackRes.body.order.customer_name, 'কাস্টমার শাকিল');
  assert.equal(trackRes.body.order.items.length, 1);
});

test('7. Direct Reseller Commission and Payout Workflow', async () => {
  // Login as admin
  const adminLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { phone: config.ADMIN.phone, password: config.ADMIN.password }
  });
  const adminToken = adminLogin.body.token;

  // Login as Reseller 2 (who was referred by User 1)
  const resellerLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { phone: '01711000002', password: 'password123' }
  });
  const reseller2Token = resellerLogin.body.token;
  const reseller2Id = resellerLogin.body.user.id;
  const referrerId = resellerLogin.body.user.referred_by_id;

  // Reseller 2 places an order for a 1000tk commission product
  const sbf101 = await get("SELECT * FROM products WHERE sku = 'SBF-101'");
  const placeOrderRes = await request('/api/orders', {
    method: 'POST',
    headers: { Authorization: `Bearer ${reseller2Token}` },
    body: {
      customer_name: 'হাসান আহমেদ',
      customer_phone: '01799887766',
      delivery_address: 'উত্তরা, ঢাকা',
      delivery_city: 'inside_dhaka',
      advance_paid: 500,
      advance_trx_id: 'TRX-COMMISSION-TEST',
      items: [{ product_id: sbf101.id, quantity: 1 }]
    }
  });
  assert.equal(placeOrderRes.status, 201);
  const createdOrderId = placeOrderRes.body.order.id;

  // Check Reseller 2 wallet summary -> pending commission should be 1000 TK, available 0 TK
  let walletRes = await request('/api/wallet/summary', {
    headers: { Authorization: `Bearer ${reseller2Token}` }
  });
  assert.equal(walletRes.body.summary.pending_commission, 1000);
  assert.equal(walletRes.body.summary.available_balance, 0);

  // Admin updates order status to 'delivered'
  const updateStatusRes = await request(`/api/admin/orders/${createdOrderId}/status`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: { status: 'delivered' }
  });
  assert.equal(updateStatusRes.status, 200);

  // Now Reseller 2's wallet should have 1000 TK available balance!
  walletRes = await request('/api/wallet/summary', {
    headers: { Authorization: `Bearer ${reseller2Token}` }
  });
  assert.equal(walletRes.body.summary.available_balance, 1000);
  assert.equal(walletRes.body.summary.pending_commission, 0);

  // Inviting a reseller does not create a team bonus; earnings are from direct sales.
  const refLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { phone: '01711000001', password: 'password123' }
  });
  const referrerToken = refLogin.body.token;

  const referrerWallet = await request('/api/wallet/summary', {
    headers: { Authorization: `Bearer ${referrerToken}` }
  });
  assert.equal(referrerWallet.body.summary.available_balance, 0);

  // Reseller 2 requests a Cashout (Payout) of 500 TK via bKash
  const payoutReq = await request('/api/wallet/payout-request', {
    method: 'POST',
    headers: { Authorization: `Bearer ${reseller2Token}` },
    body: {
      amount: 500,
      payment_method: 'bkash',
      account_number: '01711000002'
    }
  });
  assert.equal(payoutReq.status, 201);
  const payoutId = payoutReq.body.payout_id;

  // After requesting 500 TK payout, available balance decreases to 500 TK
  walletRes = await request('/api/wallet/summary', {
    headers: { Authorization: `Bearer ${reseller2Token}` }
  });
  assert.equal(walletRes.body.summary.available_balance, 500);

  // Admin approves payout with TrxID
  const approvePayout = await request(`/api/admin/payouts/${payoutId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: {
      status: 'approved',
      admin_trx_id: 'BKASH_PAY_998877'
    }
  });
  assert.equal(approvePayout.status, 200);

  // Admin Stats Check
  const statsRes = await request('/api/admin/stats', {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(statsRes.status, 200);
  assert.ok(statsRes.body.stats.total_orders >= 1);
  assert.ok(statsRes.body.stats.delivered_orders >= 1);
});

test('8. Idempotent Direct Commission Delivery & Cancellation Reversal', async () => {
  // Login as admin
  const adminLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { phone: config.ADMIN.phone, password: config.ADMIN.password }
  });
  const adminToken = adminLogin.body.token;

  // Create another order for Reseller 2
  const sbf102 = await get("SELECT * FROM products WHERE sku = 'SBF-102'");
  const resellerLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { phone: '01711000002', password: 'password123' }
  });
  const reseller2Token = resellerLogin.body.token;

  const orderRes = await request('/api/orders', {
    method: 'POST',
    headers: { Authorization: `Bearer ${reseller2Token}` },
    body: {
      customer_name: 'আব্দুল করিম',
      customer_phone: '01711223399',
      delivery_address: 'বনানী, ঢাকা',
      delivery_city: 'inside_dhaka',
      advance_paid: 500,
      advance_trx_id: 'TRX_BONUS_TEST',
      items: [{ product_id: sbf102.id, quantity: 1 }]
    }
  });
  assert.equal(orderRes.status, 201);
  const testOrderId = orderRes.body.order.id;

  // 1. Deliver order
  await request(`/api/admin/orders/${testOrderId}/status`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: { status: 'delivered' }
  });

  // Direct-sale-only model: no team bonus is awarded.
  let teamBonuses = await query(
    "SELECT * FROM wallet_transactions WHERE order_id = ? AND type = 'team_bonus'",
    [testOrderId]
  );
  assert.equal(teamBonuses.length, 0);

  // 2. Change status to 'shipped' (reverted from delivered)
  await request(`/api/admin/orders/${testOrderId}/status`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: { status: 'shipped' }
  });

  // 3. Mark delivered AGAIN
  await request(`/api/admin/orders/${testOrderId}/status`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: { status: 'delivered' }
  });

  // Verify re-delivery still does not create a team bonus.
  teamBonuses = await query(
    "SELECT * FROM wallet_transactions WHERE order_id = ? AND type = 'team_bonus'",
    [testOrderId]
  );
  assert.equal(teamBonuses.length, 0, 'No team bonus should be created');

  // 4. Cancel order and verify all wallet transactions for this order are cancelled
  await request(`/api/admin/orders/${testOrderId}/status`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: { status: 'cancelled' }
  });

  const allOrderTx = await query(
    "SELECT * FROM wallet_transactions WHERE order_id = ?",
    [testOrderId]
  );
  allOrderTx.forEach((tx) => {
    assert.equal(tx.status, 'cancelled', `Transaction ${tx.id} must be cancelled`);
  });
});

test('9. Payout Isolation: Multiple payouts of the same amount remain distinct', async () => {
  const adminLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { phone: config.ADMIN.phone, password: config.ADMIN.password }
  });
  const adminToken = adminLogin.body.token;

  // Register isolated user for payout testing
  const pUserPhone = '01711999888';
  const regRes = await request('/api/auth/register', {
    method: 'POST',
    body: { name: 'পেআউট টেস্ট ইউজার', phone: pUserPhone, password: 'password123' }
  });
  const pUserToken = regRes.body.token;
  const pUserId = regRes.body.user.id;

  // Credit 2000 TK directly to wallet
  await run(
    "INSERT INTO wallet_transactions (user_id, amount, type, status, notes) VALUES (?, 2000, 'commission', 'available', 'Manual credit for test')",
    [pUserId]
  );

  // Submit two separate payout requests of 500 TK each
  const pReq1 = await request('/api/wallet/payout-request', {
    method: 'POST',
    headers: { Authorization: `Bearer ${pUserToken}` },
    body: { amount: 500, payment_method: 'bkash', account_number: pUserPhone }
  });
  assert.equal(pReq1.status, 201);
  const payout1Id = pReq1.body.payout_id;

  const pReq2 = await request('/api/wallet/payout-request', {
    method: 'POST',
    headers: { Authorization: `Bearer ${pUserToken}` },
    body: { amount: 500, payment_method: 'bkash', account_number: pUserPhone }
  });
  assert.equal(pReq2.status, 201);
  const payout2Id = pReq2.body.payout_id;

  assert.notEqual(payout1Id, payout2Id);

  // Admin approves ONLY Payout 1
  const approveRes = await request(`/api/admin/payouts/${payout1Id}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: { status: 'approved', admin_trx_id: 'TRX_ISOLATED_01' }
  });
  assert.equal(approveRes.status, 200);

  // Verify in database:
  // Payout 1 transaction is completed
  const tx1 = await get('SELECT * FROM wallet_transactions WHERE payout_id = ?', [payout1Id]);
  assert.equal(tx1.status, 'completed');
  assert.ok(tx1.notes.includes('TRX_ISOLATED_01'));

  // Payout 2 transaction MUST STILL BE PENDING!
  const tx2 = await get('SELECT * FROM wallet_transactions WHERE payout_id = ?', [payout2Id]);
  assert.equal(tx2.status, 'pending', 'Payout 2 must not be prematurely approved!');

  // Admin rejects Payout 2
  const rejectRes = await request(`/api/admin/payouts/${payout2Id}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: { status: 'rejected', notes: 'ভুল অ্যাকাউন্ট' }
  });
  assert.equal(rejectRes.status, 200);

  const tx2After = await get('SELECT * FROM wallet_transactions WHERE payout_id = ?', [payout2Id]);
  assert.equal(tx2After.status, 'cancelled');
});

test('10. Multi-tier Downline Referral Chain & Single Product SKU Fetch', async () => {
  // Register User A -> User B -> User C
  const phoneA = '01711888001';
  const phoneB = '01711888002';
  const phoneC = '01711888003';

  const regA = await request('/api/auth/register', {
    method: 'POST',
    body: { name: 'লিডার আলম', phone: phoneA, password: 'password123' }
  });
  const codeA = regA.body.user.referral_code;

  const regB = await request('/api/auth/register', {
    method: 'POST',
    body: { name: 'রিসেলার বাবুল', phone: phoneB, password: 'password123', referral_code: codeA }
  });
  assert.equal(regB.body.user.referred_by_id, regA.body.user.id);
  const codeB = regB.body.user.referral_code;

  const regC = await request('/api/auth/register', {
    method: 'POST',
    body: { name: 'রিসেলার চন্দন', phone: phoneC, password: 'password123', referral_code: codeB }
  });
  assert.equal(regC.body.user.referred_by_id, regB.body.user.id);

  // Single product fetch by SKU with ref query parameter
  const prodRes = await request(`/api/products/SBP-101?ref=${codeB}`);
  assert.equal(prodRes.status, 200);
  assert.equal(prodRes.body.product.sku, 'SBP-101');
  assert.ok(prodRes.body.product.share_copy.includes(`ref=${codeB}`));
  assert.ok(prodRes.body.product.share_copy.includes('01634664224'));
});

test('11. Dynamic Cloud Catalog: Admin Product CRUD & Single Item Retrieval', async () => {
  const adminLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { phone: config.ADMIN.phone, password: config.ADMIN.password }
  });
  const adminToken = adminLogin.body.token;

  // 1. Create a new custom product
  const newProductRes = await request('/api/admin/products', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: {
      title: 'টেস্ট কাস্টম শোকেস (Test Custom Showcase) — Code: SBF-999',
      sku: 'SBF-999',
      brand: 'SB Furniture',
      category: 'হোম ও অফিস ফার্নিচার',
      regular_price: 15000,
      reseller_commission: 1000,
      commission_tab: '1000tk',
      image_url: 'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?auto=format&fit=crop&w=800&q=80',
      description: 'টেস্ট বিবরণ',
      materials: 'সুপার এস বোর্ড',
      finish: 'Golden Burma Teak',
      stock: 25
    }
  });
  assert.equal(newProductRes.status, 201);
  const createdProdId = newProductRes.body.product_id;

  const unsafeProductRes = await request('/api/admin/products', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: {
      title: 'অবৈধ ছবি পরীক্ষা',
      sku: 'SBF-999-UNSAFE',
      brand: 'SB Furniture',
      category: 'হোম ও অফিস ফার্নিচার',
      regular_price: 5000,
      image_url: 'javascript:alert(1)'
    }
  });
  assert.equal(unsafeProductRes.status, 400);

  const invalidPriceRes = await request(`/api/admin/products/${createdProdId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: { regular_price: -1 }
  });
  assert.equal(invalidPriceRes.status, 400);

  // 2. Fetch created product by SKU
  const getProdRes = await request('/api/products/SBF-999');
  assert.equal(getProdRes.status, 200);
  assert.equal(getProdRes.body.product.title, 'টেস্ট কাস্টম শোকেস (Test Custom Showcase) — Code: SBF-999');
  assert.equal(getProdRes.body.product.regular_price, 15000);

  // 3. Update product regular_price and SKU
  const updateProdRes = await request(`/api/admin/products/${createdProdId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: {
      regular_price: 16500,
      sku: 'SBF-999-UPDATED'
    }
  });
  assert.equal(updateProdRes.status, 200);

  const getUpdatedRes = await request(`/api/products/${createdProdId}`);
  assert.equal(getUpdatedRes.body.product.regular_price, 16500);
  assert.equal(getUpdatedRes.body.product.sku, 'SBF-999-UPDATED');

  // 4. Deactivate (Delete) Product
  const deleteRes = await request(`/api/admin/products/${createdProdId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(deleteRes.status, 200);

  // Deleted product should not appear in active catalog
  const getDeletedRes = await request(`/api/products/${createdProdId}`);
  assert.equal(getDeletedRes.status, 404);

  // Clean test row from db
  await run('DELETE FROM products WHERE id = ?', [createdProdId]);
});

test('12. Multi-Vendor / Partner Shop Promotion: Admin Creation, Filtering & WhatsApp Copy Generation', async () => {
  const adminLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { phone: config.ADMIN.phone, password: config.ADMIN.password }
  });
  const adminToken = adminLogin.body.token;

  // 1. Create a partner shop product
  const partnerProductRes = await request('/api/admin/products', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: {
      title: 'পার্টনার কাঠের আলমারি (Partner Wooden Wardrobe)',
      sku: 'VND-101',
      brand: 'SB Furniture',
      category: 'হোম ও অফিস ফার্নিচার',
      regular_price: 22000,
      reseller_commission: 1000,
      commission_tab: '1000tk',
      image_url: 'https://images.unsplash.com/photo-1595428774223-ef52624120d2?auto=format&fit=crop&w=800&q=80',
      description: 'অরিজিনাল সেগুন কাঠের আলমারি',
      materials: 'চিটাগাং সেগুন কাঠ',
      finish: 'Natural Glossy Teak',
      stock: 10,
      shop_name: 'ভাই ভাই ফার্নিচার',
      vendor_phone: '01811223344',
      vendor_badge: 'পার্টনার শপ',
      vendor_address: 'মিরপুর ১০, ঢাকা'
    }
  });
  assert.equal(partnerProductRes.status, 201);
  const createdId = partnerProductRes.body.product_id;

  // 2. Filter products by partner shops
  const partnerFilterRes = await request('/api/products?shop=partner');
  assert.equal(partnerFilterRes.status, 200);
  assert.equal(partnerFilterRes.body.success, true);
  const foundPartnerItem = partnerFilterRes.body.products.find((p) => p.sku === 'VND-101');
  assert.ok(foundPartnerItem, 'Partner product should be returned when shop=partner');
  assert.equal(foundPartnerItem.shop_name, 'ভাই ভাই ফার্নিচার');
  assert.equal(foundPartnerItem.vendor_phone, '01811223344');

  // Verify all items under shop=partner are NOT SB Furniture / SB POWER
  partnerFilterRes.body.products.forEach((p) => {
    assert.ok(!['SB Furniture', 'SB POWER'].includes(p.shop_name));
  });

  // 3. Filter by exact shop name
  const exactShopRes = await request(`/api/products?shop=${encodeURIComponent('ভাই ভাই ফার্নিচার')}`);
  assert.equal(exactShopRes.status, 200);
  assert.ok(exactShopRes.body.products.some((p) => p.sku === 'VND-101'));

  // 4. Fetch single product by SKU and check dynamic vendor copy
  const singleProdRes = await request('/api/products/VND-101?ref=SBPROMO');
  assert.equal(singleProdRes.status, 200);
  const prod = singleProdRes.body.product;
  assert.equal(prod.shop_name, 'ভাই ভাই ফার্নিচার');
  assert.equal(prod.vendor_phone, '01811223344');
  assert.equal(prod.contact_phone, '01811223344');
  assert.ok(prod.share_copy.includes('ভাই ভাই ফার্নিচার'), 'Share copy should highlight partner shop name');
  assert.ok(prod.share_copy.includes('পার্টনার শপ'), 'Share copy should include vendor badge');
  assert.ok(!prod.share_copy.includes('100% অরিজিনাল'), 'Share copy should not claim unverified product authenticity');
  assert.ok(prod.share_copy.includes('01811223344'), 'Share copy should direct customer calls to vendor phone');
  assert.ok(prod.share_copy.includes('ref=SBPROMO'), 'Share copy should embed reseller referral code');

  // 5. Admin updates vendor badge and clears vendor phone
  const updateRes = await request(`/api/admin/products/${createdId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: {
      vendor_badge: 'Super Verified Partner',
      vendor_phone: ''
    }
  });
  assert.equal(updateRes.status, 200);

  const updatedProdRes = await request(`/api/products/${createdId}`);
  assert.equal(updatedProdRes.body.product.vendor_badge, 'Super Verified Partner');
  assert.equal(updatedProdRes.body.product.vendor_phone, null, 'Vendor phone should be cleared to null when updated with empty string');

  // Cleanup
  await run('DELETE FROM products WHERE id = ?', [createdId]);
});

test('13. Reseller Leaderboard: Real delivered sales only, no invented prizes', async () => {
  const res = await request('/api/leaderboard');
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);

  // This endpoint only shows actual delivered sales.
  assert.ok(res.body.campaign, 'Campaign title must be present');
  assert.ok(res.body.rules, 'Campaign rules must be present');
  assert.equal(res.body.prizes, undefined, 'Unconfirmed prizes should not be advertised');

  // Validate leaders structure
  assert.ok(Array.isArray(res.body.leaders), 'Leaders should be an array');
  for (const leader of res.body.leaders) {
    assert.ok(leader.name, 'Leader must have a name');
    assert.ok(leader.rank >= 1, 'Leader rank must be positive');
    assert.ok(leader.total_sales > 0, 'Leaderboard entries must have real completed sales');
  }
});

