require('./testEnv');

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const app = require('../src/server');
const { initDb, run, get, query, withTransaction, closeDb } = require('../src/db');
const { seedData } = require('../src/seed');
const { BACKUP_DIR } = require('../src/backup');
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
    if (options.body) {
      if (typeof options.body === 'string' || Buffer.isBuffer(options.body)) {
        req.write(options.body);
      } else {
        req.write(JSON.stringify(options.body));
      }
    }
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

test('Features 1: Auth - Session, Profile Update, and Password Change', async () => {
  const phone = '01799112233';
  const initialPassword = 'Password123';
  const newPassword = 'NewSecretPassword456';

  // 1. Session check before auth
  const noSession = await request('/api/auth/session');
  assert.equal(noSession.status, 200);
  assert.equal(noSession.body.authenticated, false);
  assert.equal(noSession.body.user, null);

  // 2. Register new reseller
  const regRes = await request('/api/auth/register', {
    method: 'POST',
    body: {
      name: 'হাসান মাহমুদ',
      phone,
      password: initialPassword
    }
  });
  assert.equal(regRes.status, 201);
  const token = regRes.body.token;
  assert.ok(token);

  // 3. Session check with valid token
  const validSession = await request('/api/auth/session', {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(validSession.status, 200);
  assert.equal(validSession.body.authenticated, true);
  assert.equal(validSession.body.user.phone, phone);

  // 4. Profile update via PUT /api/auth/me
  const updateRes = await request('/api/auth/me', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` },
    body: {
      name: 'হাসান মাহমুদ চৌধুরী'
    }
  });
  assert.equal(updateRes.status, 200);
  assert.equal(updateRes.body.success, true);
  assert.equal(updateRes.body.user.name, 'হাসান মাহমুদ চৌধুরী');

  // 5. Password change with wrong old password
  const badPassRes = await request('/api/auth/change-password', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: {
      old_password: 'WrongPassword999',
      new_password: newPassword
    }
  });
  assert.equal(badPassRes.status, 400);
  assert.ok(badPassRes.body.message.includes('বর্তমান পাসওয়ার্ড সঠিক নয়'));

  // 6. Password change with correct credentials
  const goodPassRes = await request('/api/auth/change-password', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: {
      old_password: initialPassword,
      new_password: newPassword
    }
  });
  assert.equal(goodPassRes.status, 200);
  assert.equal(goodPassRes.body.success, true);
  assert.ok(goodPassRes.body.token, 'Password change must return a fresh token');

  // 6a. The pre-change token is revoked, so a stolen session cannot keep using it.
  const staleSession = await request('/api/auth/me', {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(staleSession.status, 401);

  const staleCookieCheck = await request('/api/auth/session', {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(staleCookieCheck.body.authenticated, false);

  // 6b. The token issued by the change keeps this device signed in.
  const refreshedSession = await request('/api/auth/me', {
    headers: { Authorization: `Bearer ${goodPassRes.body.token}` }
  });
  assert.equal(refreshedSession.status, 200);
  assert.equal(refreshedSession.body.user.phone, phone);

  // 7. Verify login works with new password
  const newLoginRes = await request('/api/auth/login', {
    method: 'POST',
    body: {
      phone,
      password: newPassword
    }
  });
  assert.equal(newLoginRes.status, 200);
  assert.ok(newLoginRes.body.token);
});

test('Features 2: Product Catalog - Price Range, Sorting, Categories Meta & Pagination', async () => {
  // 1. Categories meta
  const metaRes = await request('/api/products/meta/categories');
  assert.equal(metaRes.status, 200);
  assert.ok(Array.isArray(metaRes.body.categories));
  assert.ok(metaRes.body.categories.length > 0);

  // 2. Price range filtering
  const rangeRes = await request('/api/products?min_price=2000&max_price=10000');
  assert.equal(rangeRes.status, 200);
  assert.ok(rangeRes.body.products.length > 0);
  rangeRes.body.products.forEach(p => {
    assert.ok(p.regular_price >= 2000 && p.regular_price <= 10000, `Product price ${p.regular_price} out of range`);
  });

  // 3. Sorting by price asc
  const ascRes = await request('/api/products?sort=price_asc&limit=10');
  assert.equal(ascRes.status, 200);
  for (let i = 0; i < ascRes.body.products.length - 1; i++) {
    assert.ok(ascRes.body.products[i].regular_price <= ascRes.body.products[i + 1].regular_price);
  }

  // 4. Sorting by commission desc
  const reseller = await registerReseller(request, {
    name: 'কমিশন সাজানোর পরীক্ষা',
    phone: '01712340002',
    password: 'password123'
  });
  const commDescRes = await request('/api/products?sort=commission_desc&limit=10', {
    headers: { Authorization: `Bearer ${reseller.body.token}` }
  });
  assert.equal(commDescRes.status, 200);
  for (let i = 0; i < commDescRes.body.products.length - 1; i++) {
    assert.ok(commDescRes.body.products[i].reseller_commission >= commDescRes.body.products[i + 1].reseller_commission);
  }

  // 5. Pagination structure
  const pageRes = await request('/api/products?page=2&limit=5');
  assert.equal(pageRes.status, 200);
  assert.equal(pageRes.body.current_page, 2);
  assert.equal(pageRes.body.limit, 5);
  assert.ok(pageRes.body.total >= 30);
  assert.ok(pageRes.body.total_pages >= 6);
  assert.equal(pageRes.body.products.length, 5);
});

test('Features 3: Order History, Phone-Based Search, and Reseller Sales List', async () => {
  // 1. Get an existing product
  const prods = await query('SELECT * FROM products LIMIT 1');
  assert.ok(prods.length > 0);
  const sampleProd = prods[0];

  // 2. Register reseller
  const resPhone = '01799223344';
  const reg = await registerReseller(request, { name: 'আসিফ ইকবাল', phone: resPhone, password: 'password123' });
  const resToken = reg.body.token;

  // 3. Place order with reseller referral
  const customerPhone = '01855667788';
  const orderRes = await request('/api/orders', {
    method: 'POST',
    body: {
      customer_name: 'কাস্টমার রফিক',
      customer_phone: customerPhone,
      delivery_address: 'মিরপুর ১২, ঢাকা',
      delivery_city: 'inside_dhaka',
      advance_paid: 500,
      advance_trx_id: 'TRX-FEAT-999',
      referral_code: reg.body.user.referral_code,
      items: [{ product_id: sampleProd.id, quantity: 1 }]
    }
  });
  assert.equal(orderRes.status, 201);
  const orderNumber = orderRes.body.order.order_number;
  assert.ok(orderNumber);

  // Phone-only history is private; only the signed-in reseller can view owned orders.
  const privateOrders = await request(`/api/orders/my-orders?phone=${customerPhone}`);
  assert.equal(privateOrders.status, 401);
  const queryTokenOrders = await request(`/api/orders/my-orders?token=${encodeURIComponent(resToken)}`);
  assert.equal(queryTokenOrders.status, 401);

  // 4. Authenticated order history for the reseller's orders
  const custOrders = await request('/api/orders/my-orders', {
    headers: { Authorization: `Bearer ${resToken}` }
  });
  assert.equal(custOrders.status, 200);
  assert.ok(custOrders.body.orders.length >= 1);
  assert.equal(custOrders.body.orders[0].customer_phone, customerPhone);

  // 5. Order tracking requires both the order number and customer phone.
  const noPhoneTrack = await request('/api/orders/track', {
    method: 'POST',
    body: { order_number: orderNumber }
  });
  assert.equal(noPhoneTrack.status, 400);

  const wrongPhoneTrack = await request('/api/orders/track', {
    method: 'POST',
    body: { order_number: orderNumber, phone: '01700000000' }
  });
  assert.equal(wrongPhoneTrack.status, 404);

  // 6. Direct tracking by order number
  const singleTrack = await request('/api/orders/track', {
    method: 'POST',
    body: { order_number: orderNumber, phone: customerPhone }
  });
  assert.equal(singleTrack.status, 200);
  assert.equal(singleTrack.body.order.order_number, orderNumber);
  assert.ok(Array.isArray(singleTrack.body.order.items));

  // 7. Reseller sales list via GET /api/orders/reseller-sales
  const salesList = await request('/api/orders/reseller-sales', {
    headers: { Authorization: `Bearer ${resToken}` }
  });
  assert.equal(salesList.status, 200);
  assert.ok(salesList.body.orders.length >= 1);
  assert.equal(salesList.body.orders[0].order_number, orderNumber);
  assert.ok(salesList.body.orders[0].reseller_commission >= 0);
});

test('Features 4: Order Audit Trail & Real-Time Reseller Notification on Status Transition', async () => {
  const prods = await query('SELECT * FROM products LIMIT 1');
  const resPhone = '01799334455';
  const reg = await registerReseller(request, { name: 'সুমাইয়া জাহান', phone: resPhone, password: 'password123' });
  const resToken = reg.body.token;

  const orderRes = await request('/api/orders', {
    method: 'POST',
    body: {
      customer_name: 'তাহমিন আক্তার',
      customer_phone: '01911445566',
      delivery_address: 'ধানমন্ডি, ঢাকা',
      delivery_city: 'inside_dhaka',
      advance_paid: 500,
      advance_trx_id: 'TRX-AUDIT-123',
      referral_code: reg.body.user.referral_code,
      items: [{ product_id: prods[0].id, quantity: 1 }]
    }
  });
  assert.equal(orderRes.status, 201);
  const orderId = orderRes.body.order.id;

  // 2. Admin logs in
  const adminLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { phone: config.ADMIN.phone, password: config.ADMIN.password }
  });
  const adminToken = adminLogin.body.token;
  assert.ok(adminToken);

  // 3. Admin updates order status to 'confirmed' with note
  const updateRes1 = await request(`/api/admin/orders/${orderId}/status`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: { status: 'confirmed', notes: 'কারখানা থেকে ডেলিভারির জন্য প্রস্তুত করা হচ্ছে' }
  });
  assert.equal(updateRes1.status, 200);

  // 4. Verify audit trail via GET /api/admin/orders/:id/audit-trail
  const auditRes = await request(`/api/admin/orders/${orderId}/audit-trail`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(auditRes.status, 200);
  assert.ok(Array.isArray(auditRes.body.audit_trail));
  assert.ok(auditRes.body.audit_trail.length >= 2); // Initial pending + confirmed
  const confirmedLog = auditRes.body.audit_trail.find(log => log.new_status === 'confirmed');
  assert.ok(confirmedLog);
  assert.equal(confirmedLog.notes, 'কারখানা থেকে ডেলিভারির জন্য প্রস্তুত করা হচ্ছে');

  // 5. Admin updates to 'delivered'
  const updateRes2 = await request(`/api/admin/orders/${orderId}/status`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: { status: 'delivered', notes: 'গ্রাহক পণ্য বুঝে পেয়েছেন' }
  });
  assert.equal(updateRes2.status, 200);

  // 6. Check reseller notifications via GET /api/auth/notifications
  const notifRes = await request('/api/auth/notifications', {
    headers: { Authorization: `Bearer ${resToken}` }
  });
  assert.equal(notifRes.status, 200);
  assert.ok(Array.isArray(notifRes.body.notifications));
  assert.ok(notifRes.body.notifications.length >= 2);
  const deliveredNotif = notifRes.body.notifications.find(n => n.message.includes('delivered'));
  assert.ok(deliveredNotif);
  assert.equal(deliveredNotif.is_read, 0);

  // 7. Mark notification as read via PUT /api/auth/notifications/:id/read
  const readRes = await request(`/api/auth/notifications/${deliveredNotif.id}/read`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${resToken}` }
  });
  assert.equal(readRes.status, 200);
  assert.equal(readRes.body.success, true);
});

test('Features 5: Downline Team Breakdown & Admin Analytics', async () => {
  // 1. Parent reseller registers
  const parentPhone = '01799445566';
  const parentReg = await registerReseller(request, { name: 'টিম লিডার তানভীর', phone: parentPhone, password: 'password123' });
  const parentToken = parentReg.body.token;
  const parentRefCode = parentReg.body.user.referral_code;

  // 2. Child reseller registers using parent's referral code
  const childPhone = '01799556677';
  const childReg = await registerReseller(request, {
    name: 'সদস্য কামরুল',
    phone: childPhone,
    password: 'password123',
    referral_code: parentRefCode
  });
  assert.equal(childReg.status, 201);

  // 3. Parent checks downline team via GET /api/wallet/downline
  const downlineRes = await request('/api/wallet/downline', {
    headers: { Authorization: `Bearer ${parentToken}` }
  });
  assert.equal(downlineRes.status, 200);
  assert.equal(downlineRes.body.success, true);
  assert.ok(Array.isArray(downlineRes.body.team));
  assert.equal(downlineRes.body.count, 1);
  const member = downlineRes.body.team[0];
  assert.equal(member.name, 'সদস্য কামরুল');

  // 4. Admin Analytics via GET /api/admin/analytics
  const adminLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { phone: config.ADMIN.phone, password: config.ADMIN.password }
  });
  const analyticsRes = await request('/api/admin/analytics', {
    headers: { Authorization: `Bearer ${adminLogin.body.token}` }
  });
  assert.equal(analyticsRes.status, 200);
  assert.ok(analyticsRes.body.analytics);
  assert.ok(analyticsRes.body.analytics.total_orders >= 1);
  assert.ok(Array.isArray(analyticsRes.body.analytics.top_products));
  assert.ok(Array.isArray(analyticsRes.body.analytics.top_resellers));
});

test('Features 6: Dynamic Announcements CRUD & Public Config Propagation', async () => {
  const adminLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { phone: config.ADMIN.phone, password: config.ADMIN.password }
  });
  const adminToken = adminLogin.body.token;
  assert.ok(adminToken);

  // 1. Create announcement
  const createRes = await request('/api/admin/announcements', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: {
      title: 'টেস্ট ফ্ল্যাশ সেল ২০২৬',
      message: 'সকল প্রিমিয়াম সোফায় ২০% বাড়তি কমিশন ও নিশ্চিত ক্যাশব্যাক!',
      type: 'flash_deal',
      is_active: 1
    }
  });
  assert.equal(createRes.status, 201);
  const announcementId = createRes.body.id;
  assert.ok(announcementId);

  // 2. Verify active announcement in public /api/config
  const configRes = await request('/api/config');
  assert.equal(configRes.status, 200);
  assert.ok(Array.isArray(configRes.body.announcements));
  const foundInConfig = configRes.body.announcements.find(a => a.id === announcementId);
  assert.ok(foundInConfig, 'Announcement should propagate into public /api/config');
  assert.equal(foundInConfig.title, 'টেস্ট ফ্ল্যাশ সেল ২০২৬');

  // 3. Update announcement
  const updateRes = await request(`/api/admin/announcements/${announcementId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: {
      title: 'আপডেটেড ফ্ল্যাশ সেল ২০২৬',
      message: 'অফারটি সীমিত সময়ের জন্য বর্ধিত করা হলো!',
      type: 'flash_deal',
      is_active: 1
    }
  });
  assert.equal(updateRes.status, 200);

  // 4. Verify updated title in public /api/config
  const updatedConfig = await request('/api/config');
  const foundUpdated = updatedConfig.body.announcements.find(a => a.id === announcementId);
  assert.equal(foundUpdated.title, 'আপডেটেড ফ্ল্যাশ সেল ২০২৬');

  // 5. Delete announcement
  const deleteRes = await request(`/api/admin/announcements/${announcementId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(deleteRes.status, 200);

  // 6. Verify removed from public /api/config
  const cleanConfig = await request('/api/config');
  const deletedStillExists = cleanConfig.body.announcements.some(a => a.id === announcementId);
  assert.equal(deletedStillExists, false, 'Deleted announcement should not appear in /api/config');
});

test('Features 7: Concurrency & Transaction Serialization (withTransaction Queue)', async () => {
  // Test running 10 concurrent transactions that write to announcements or notifications
  const results = await Promise.all(
    Array.from({ length: 10 }).map((_, i) =>
      withTransaction(async ({ run: txRun }) => {
        const res = await txRun(
          'INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)',
          [1, `কনকারেন্ট টেস্ট ${i}`, `মেসেজ কনটেন্ট ${i}`]
        );
        return res.lastID;
      })
    )
  );

  assert.equal(results.length, 10);
  results.forEach((id) => assert.ok(id > 0));

  // Clean up
  await run("DELETE FROM notifications WHERE title LIKE 'কনকারেন্ট টেস্ট%'");
});

test('Features 8: Admin Products Filter (Active vs Inactive) & Status Update', async () => {
  const adminLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { phone: config.ADMIN.phone, password: config.ADMIN.password }
  });
  const adminToken = adminLogin.body.token;
  assert.ok(adminToken);

  // 1. Create a product specifically to deactivate
  const dynamicSku = `TEST-INACT-${Date.now()}`;
  const createProdRes = await request('/api/admin/products', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: {
      sku: dynamicSku,
      title: 'টেস্ট নিষ্ক্রিয় সোফা',
      regular_price: 15000,
      reseller_price: 13000,
      category: 'Home & Living',
      brand: 'SB Furniture',
      stock: 5,
      is_active: 1
    }
  });
  assert.equal(createProdRes.status, 201);
  const prodId = createProdRes.body.product_id;
  assert.ok(prodId);

  // 2. Deactivate the product
  const deactRes = await request(`/api/admin/products/${prodId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: {
      is_active: 0
    }
  });
  assert.equal(deactRes.status, 200);

  // 3. Customer /api/products should NOT return this inactive product
  const publicProdsRes = await request('/api/products');
  const foundInPublic = publicProdsRes.body.products.some((p) => p.id === prodId);
  assert.equal(foundInPublic, false, 'Inactive product must be hidden from customer /api/products');

  // 4. Admin /api/admin/products?status=inactive MUST return it
  const adminInactiveRes = await request('/api/admin/products?status=inactive', {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(adminInactiveRes.status, 200);
  const foundInAdminInactive = adminInactiveRes.body.products.some((p) => p.id === prodId);
  assert.equal(foundInAdminInactive, true, 'Inactive product must be visible in admin filter status=inactive');

  // 5. Clean up product
  await request(`/api/admin/products/${prodId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${adminToken}` }
  });
});

test('Features 9: Admin Payout Approval/Rejection with Atomic Notifications & Balance Reconciliation', async () => {
  // 1. Register a reseller with available balance
  const phone = `0188${Math.floor(1000000 + Math.random() * 9000000)}`;
  const regRes = await registerReseller(request, { name: 'রিসেলার জামিল', phone, password: 'Password123' });
  assert.equal(regRes.status, 201);
  const resellerToken = regRes.body.token;
  const user = await get('SELECT id FROM users WHERE phone = ?', [phone]);

  // Give reseller 1000 TK available balance directly in wallet_transactions
  await run(
    `INSERT INTO wallet_transactions (user_id, amount, type, status, notes)
     VALUES (?, 100000, 'commission', 'available', 'সরাসরি টেস্ট কমিশন')`,
    [user.id]
  );

  // Reseller requests 500 TK payout
  const payoutReqRes = await request('/api/wallet/payout-request', {
    method: 'POST',
    headers: { Authorization: `Bearer ${resellerToken}` },
    body: {
      amount: 500,
      payment_method: 'bkash',
      account_number: phone
    }
  });
  assert.equal(payoutReqRes.status, 201);
  const payoutId = payoutReqRes.body.payout_id;
  assert.ok(payoutId);

  // Verify wallet summary shows available_balance = 500 (1000 - 500)
  const walletSummary1 = await request('/api/wallet/summary', {
    headers: { Authorization: `Bearer ${resellerToken}` }
  });
  assert.equal(walletSummary1.body.summary.available_balance, 500);

  // Admin approves the payout
  const adminLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { phone: config.ADMIN.phone, password: config.ADMIN.password }
  });
  const adminToken = adminLogin.body.token;

  const approveRes = await request(`/api/admin/payouts/${payoutId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: {
      status: 'approved',
      admin_trx_id: 'BKASH_PAY_TRX_9999'
    }
  });
  assert.equal(approveRes.status, 200);

  const duplicateApproveRes = await request(`/api/admin/payouts/${payoutId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: { status: 'approved', admin_trx_id: 'BKASH_PAY_TRX_9999' }
  });
  assert.equal(duplicateApproveRes.status, 409);

  // Check reseller notifications: should have approval notification
  const notifRes1 = await request('/api/auth/notifications', {
    headers: { Authorization: `Bearer ${resellerToken}` }
  });
  assert.equal(notifRes1.status, 200);
  assert.ok(notifRes1.body.notifications.some((n) => n.message.includes('BKASH_PAY_TRX_9999')));
  assert.equal(notifRes1.body.notifications.filter((n) => n.message.includes('BKASH_PAY_TRX_9999')).length, 1);

  // Now reseller requests remaining 500 TK payout
  const payoutReqRes2 = await request('/api/wallet/payout-request', {
    method: 'POST',
    headers: { Authorization: `Bearer ${resellerToken}` },
    body: {
      amount: 500,
      payment_method: 'nagad',
      account_number: phone
    }
  });
  assert.equal(payoutReqRes2.status, 201);
  const payoutId2 = payoutReqRes2.body.payout_id;

  // Available balance is now 0 (1000 - 500 - 500)
  const walletSummary2 = await request('/api/wallet/summary', {
    headers: { Authorization: `Bearer ${resellerToken}` }
  });
  assert.equal(walletSummary2.body.summary.available_balance, 0);

  // Admin rejects payout 2
  const rejectRes = await request(`/api/admin/payouts/${payoutId2}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: {
      status: 'rejected',
      notes: 'ভুল নগদ নম্বর দেওয়া হয়েছে'
    }
  });
  assert.equal(rejectRes.status, 200);

  // Available balance must be restored to 500!
  const walletSummary3 = await request('/api/wallet/summary', {
    headers: { Authorization: `Bearer ${resellerToken}` }
  });
  assert.equal(walletSummary3.body.summary.available_balance, 500, 'Rejected payout must restore available balance');

  // Check reseller notifications: should have rejection notification with reason
  const notifRes2 = await request('/api/auth/notifications', {
    headers: { Authorization: `Bearer ${resellerToken}` }
  });
  assert.ok(notifRes2.body.notifications.some((n) => n.message.includes('ভুল নগদ নম্বর দেওয়া হয়েছে')));
});

test('Features 10: Notifications Unread Count & Bulk Read-All', async () => {
  const phone = `0191${Math.floor(1000000 + Math.random() * 9000000)}`;
  const regRes = await request('/api/auth/register', {
    method: 'POST',
    body: { name: 'রিসেলার সাঈদ', phone, password: 'Password123' }
  });
  const token = regRes.body.token;
  const user = await get('SELECT id FROM users WHERE phone = ?', [phone]);

  // Insert 3 unread notifications
  await run('INSERT INTO notifications (user_id, title, message, is_read) VALUES (?, ?, ?, 0)', [user.id, 'নোটিফ ১', 'টেস্ট বার্তা ১']);
  await run('INSERT INTO notifications (user_id, title, message, is_read) VALUES (?, ?, ?, 0)', [user.id, 'নোটিফ ২', 'টেস্ট বার্তা ২']);
  await run('INSERT INTO notifications (user_id, title, message, is_read) VALUES (?, ?, ?, 0)', [user.id, 'নোটিফ ৩', 'টেস্ট বার্তা ৩']);

  // Check unread_count
  const notifRes = await request('/api/auth/notifications', {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(notifRes.status, 200);
  assert.equal(notifRes.body.unread_count, 3);

  // Call bulk read-all
  const readAllRes = await request('/api/auth/notifications/read-all', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(readAllRes.status, 200);
  assert.equal(readAllRes.body.success, true);

  // Re-verify unread_count is 0
  const afterRes = await request('/api/auth/notifications', {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(afterRes.status, 200);
  assert.equal(afterRes.body.unread_count, 0);
  assert.ok(afterRes.body.notifications.every((n) => n.is_read === 1));
});

test('Features 11: Anti-Fraud Advance Paid Validation', async () => {
  const prod = await get("SELECT * FROM products WHERE brand = 'SB Furniture' AND is_active = 1 ORDER BY id LIMIT 1");
  const gadget = await get("SELECT * FROM products WHERE brand = 'SB POWER' AND is_active = 1 ORDER BY id LIMIT 1");
  assert.ok(prod);
  assert.ok(gadget);

  const furnitureCodOrder = await request('/api/orders', {
    method: 'POST',
    body: {
      customer_name: 'আরিফুল ইসলাম',
      customer_phone: '01712345678',
      delivery_address: 'কালীগঞ্জ, গাজীপুর',
      delivery_city: 'inside_dhaka',
      advance_paid: 0,
      items: [{ product_id: prod.id, quantity: 1 }]
    }
  });
  assert.equal(furnitureCodOrder.status, 201, 'Furniture orders should allow COD when no advance is requested');
  assert.equal(furnitureCodOrder.body.order.advance_paid, 0);

  // 1. Order with advance_paid > 0 but NO advance_trx_id should fail (400)
  const failOrderRes = await request('/api/orders', {
    method: 'POST',
    body: {
      customer_name: 'আরিফুল ইসলাম',
      customer_phone: '01712345678',
      delivery_address: 'মিরপুর ১০, ঢাকা',
      delivery_city: 'inside_dhaka',
      advance_paid: 500,
      advance_trx_id: '',
      items: [{ product_id: prod.id, quantity: 1 }]
    }
  });
  assert.equal(failOrderRes.status, 400);
  assert.ok(failOrderRes.body.message.includes('TrxID'));

  // 2. Order with advance_paid > 0 and valid advance_trx_id should succeed (201)
  const successOrderRes = await request('/api/orders', {
    method: 'POST',
    body: {
      customer_name: 'আরিফুল ইসলাম',
      customer_phone: '01712345678',
      delivery_address: 'মিরপুর ১০, ঢাকা',
      delivery_city: 'inside_dhaka',
      advance_paid: 500,
      advance_trx_id: 'TRX_TEST_ADVANCE_1234',
      items: [{ product_id: prod.id, quantity: 1 }]
    }
  });
  assert.equal(successOrderRes.status, 201);
  assert.equal(successOrderRes.body.order.advance_paid, 500);
  assert.equal(successOrderRes.body.order.advance_trx_id, 'TRX_TEST_ADVANCE_1234');

  const gadgetCodOrder = await request('/api/orders', {
    method: 'POST',
    body: {
      customer_name: 'আরিফুল ইসলাম',
      customer_phone: '01712345678',
      delivery_address: 'মিরপুর ১০, ঢাকা',
      delivery_city: 'inside_dhaka',
      advance_paid: 0,
      items: [{ product_id: gadget.id, quantity: 1 }]
    }
  });
  assert.equal(gadgetCodOrder.status, 201);
  assert.equal(gadgetCodOrder.body.order.advance_trx_id, null);
});

test('Features 11a: Concurrent cashouts cannot exceed the available balance', async () => {
  const phone = '01844000001';
  const registration = await registerReseller(request, { name: 'নিরাপদ ক্যাশআউট পরীক্ষা', phone, password: 'Password123' });
  assert.equal(registration.status, 201);
  const user = await get('SELECT id FROM users WHERE phone = ?', [phone]);
  await run(
    `INSERT INTO wallet_transactions (user_id, amount, type, status, notes)
     VALUES (?, 100000, 'commission', 'available', 'সমান্তরাল ক্যাশআউট পরীক্ষা')`,
    [user.id]
  );

  const options = {
    method: 'POST',
    headers: { Authorization: `Bearer ${registration.body.token}` },
    body: { amount: 700, payment_method: 'bkash', account_number: phone }
  };
  const results = await Promise.all([
    request('/api/wallet/payout-request', options),
    request('/api/wallet/payout-request', options)
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 400]);

  const summary = await request('/api/wallet/summary', {
    headers: { Authorization: `Bearer ${registration.body.token}` }
  });
  assert.equal(summary.body.summary.available_balance, 300);
});

test('Features 12: Database Backup & Data Safety (Admin Trigger, List, Download & Path Traversal Prevention)', async () => {
  const adminLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { phone: config.ADMIN.phone, password: config.ADMIN.password }
  });
  const adminToken = adminLogin.body.token;
  assert.ok(adminToken);

  // 1. Trigger backup via Admin API
  const backupRes = await request('/api/admin/backup', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(backupRes.status, 200);
  assert.equal(backupRes.body.success, true);
  assert.ok(backupRes.body.backup.filename.endsWith('.sqlite'));
  assert.ok(backupRes.body.backup.sizeBytes > 0);
  if (process.platform !== 'win32') {
    const backupPath = path.join(BACKUP_DIR, backupRes.body.backup.filename);
    assert.equal(fs.statSync(BACKUP_DIR).mode & 0o777, 0o700);
    assert.equal(fs.statSync(backupPath).mode & 0o777, 0o600);
  }

  // 2. List backups
  const listRes = await request('/api/admin/backups', {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(listRes.status, 200);
  assert.ok(listRes.body.count > 0);
  assert.ok(listRes.body.backups.some(b => b.filename === backupRes.body.backup.filename));

  // 3. Download valid backup via Authorization Header
  const downloadRes = await request(`/api/admin/backups/download/${backupRes.body.backup.filename}`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(downloadRes.status, 200);

  // 4. Query-string credentials are rejected to avoid leaking tokens in URLs and logs.
  const downloadQueryTokenRes = await request(
    `/api/admin/backups/download/${backupRes.body.backup.filename}?token=${encodeURIComponent(adminToken)}`
  );
  assert.equal(downloadQueryTokenRes.status, 401);

  // 5. Unauthenticated download attempt MUST be rejected with 401
  const unauthDownloadRes = await request(`/api/admin/backups/download/${backupRes.body.backup.filename}`);
  assert.equal(unauthDownloadRes.status, 401);

  // 6. Invalid query token is ignored and rejected as unauthenticated.
  const badTokenDownloadRes = await request(
    `/api/admin/backups/download/${backupRes.body.backup.filename}?token=invalid.jwt.token`
  );
  assert.equal(badTokenDownloadRes.status, 401);

  // 7. Invalid file extension security check
  const badDownloadRes = await request('/api/admin/backups/download/database.env', {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(badDownloadRes.status, 400);
});

test('Features 13: Direct APK Distribution Routes & Service Worker Cache Safety', async () => {
  // 1. Reseller APK direct download route
  const resellerApkRes = await request('/download/reseller-apk');
  assert.equal(resellerApkRes.status, 200);
  assert.ok(resellerApkRes.headers['content-type'].includes('application/vnd.android.package-archive'));

  // 2. Admin APK direct download route
  const adminApkRes = await request('/download/admin-apk');
  assert.equal(adminApkRes.status, 200);
  assert.ok(adminApkRes.headers['content-type'].includes('application/vnd.android.package-archive'));

  // 3. Verify public/sw.js excludes APK downloads and implements safe async navigation fallback
  const fs = require('fs');
  const path = require('path');
  const swContent = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf-8');
  assert.ok(swContent.includes('/download/'));
  assert.ok(swContent.includes('/dist-apk/'));
  assert.ok(swContent.includes('await caches.match(event.request)'));
});

test('Features 14: Reseller commissions follow incoming share links and exclude self-orders', async () => {
  const referrerPhone = '01799000001';
  const shopperPhone = '01799000002';
  const referrerReg = await registerReseller(request, { name: 'শেয়ারকারী', phone: referrerPhone, password: 'password123' });
  assert.equal(referrerReg.status, 201);

  const shopperReg = await registerReseller(request, {
    name: 'ক্রেতা ও রিসেলার',
    phone: shopperPhone,
    password: 'password123',
    referral_code: referrerReg.body.user.referral_code
  });
  assert.equal(shopperReg.status, 201);

  const product = await get("SELECT * FROM products WHERE brand = 'SB POWER' AND is_active = 1 LIMIT 1");
  const placeOrder = (customerPhone, referralCode, token) => request('/api/orders', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: {
      customer_name: 'অর্ডার ক্রেতা',
      customer_phone: customerPhone,
      delivery_address: 'মিরপুর, ঢাকা',
      delivery_city: 'inside_dhaka',
      referral_code: referralCode,
      items: [{ product_id: product.id, quantity: 1 }]
    }
  });

  // A logged-in shopper who buys for their own phone earns no commission.
  const ownOrderRes = await placeOrder(
    shopperPhone,
    referrerReg.body.user.referral_code,
    shopperReg.body.token
  );
  assert.equal(ownOrderRes.status, 201);
  const ownOrder = await get('SELECT reseller_id FROM orders WHERE id = ?', [ownOrderRes.body.order.id]);
  assert.equal(ownOrder.reseller_id, null);
  const ownCommission = await get(
    "SELECT id FROM wallet_transactions WHERE order_id = ? AND type = 'commission'",
    [ownOrderRes.body.order.id]
  );
  assert.equal(ownCommission, undefined);

  // The referral link wins over the logged-in shopper's own reseller identity.
  const referredOrderRes = await placeOrder(
    '01899000001',
    referrerReg.body.user.referral_code,
    shopperReg.body.token
  );
  assert.equal(referredOrderRes.status, 201);
  const referredOrder = await get('SELECT reseller_id FROM orders WHERE id = ?', [referredOrderRes.body.order.id]);
  assert.equal(referredOrder.reseller_id, referrerReg.body.user.id);

  // A reseller can still enter an order for a different customer's phone.
  const resellerOrderRes = await placeOrder(
    '01899000002',
    shopperReg.body.user.referral_code,
    shopperReg.body.token
  );
  assert.equal(resellerOrderRes.status, 201);
  const resellerOrder = await get('SELECT reseller_id FROM orders WHERE id = ?', [resellerOrderRes.body.order.id]);
  assert.equal(resellerOrder.reseller_id, shopperReg.body.user.id);
});

test('Features 15: Stock is reserved atomically and decimal prices stay exact', async () => {
  const adminLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { phone: config.ADMIN.phone, password: config.ADMIN.password }
  });
  const adminToken = adminLogin.body.token;
  assert.ok(adminToken);

  const createRes = await request('/api/admin/products', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: {
      sku: `TEST-PAISA-${Date.now()}`,
      title: 'দশমিক দামের টেস্ট পণ্য',
      brand: 'SB POWER',
      category: 'ওয়্যারলেস অডিও ও গ্যাজেটস',
      regular_price: 1999.99,
      reseller_commission: 100.5,
      stock: 2,
      is_active: 1
    }
  });
  assert.equal(createRes.status, 201, JSON.stringify(createRes.body));
  const productId = createRes.body.product_id;
  assert.ok(productId);

  // Money is stored as exact integer paisa, not a float.
  const stored = await get('SELECT regular_price, reseller_commission, stock FROM products WHERE id = ?', [productId]);
  assert.equal(stored.regular_price, 199999);
  assert.equal(stored.reseller_commission, 10050);
  assert.equal(Number.isInteger(stored.regular_price), true);

  // The HTTP API still speaks taka, including the decimal places.
  const listed = await request(`/api/products/${productId}`);
  assert.equal(listed.body.product.regular_price, 1999.99);
  assert.equal(listed.body.product.reseller_commission, undefined);
  const resellerCatalog = await request(`/api/products/${productId}`, {
    headers: { Authorization: `Bearer ${(await registerReseller(request, {
      name: 'দশমিক কমিশন পরীক্ষা',
      phone: '01712340003',
      password: 'password123'
    })).body.token}` }
  });
  assert.equal(resellerCatalog.body.product.regular_price, 1999.99);
  assert.equal(resellerCatalog.body.product.reseller_commission, 100.5);

  const orderBody = {
    customer_name: 'স্টক টেস্ট ক্রেতা',
    customer_phone: '01712345679',
    delivery_address: 'কালীগঞ্জ, গাজীপুর',
    delivery_city: 'outside_dhaka'
  };

  // Two units: 2 × 1999.99 plus 150 delivery (gadget, outside Dhaka).
  const orderRes = await request('/api/orders', {
    method: 'POST',
    body: { ...orderBody, items: [{ product_id: productId, quantity: 2 }] }
  });
  assert.equal(orderRes.status, 201);
  assert.equal(orderRes.body.order.subtotal_amount, 3999.98);
  assert.equal(orderRes.body.order.delivery_fee, 150);
  assert.equal(orderRes.body.order.total_amount, 4149.98);

  const afterOrder = await get('SELECT stock FROM products WHERE id = ?', [productId]);
  assert.equal(afterOrder.stock, 0, 'Placing an order must decrement stock');

  // Selling stock that is gone must fail instead of overselling.
  const oversell = await request('/api/orders', {
    method: 'POST',
    body: { ...orderBody, items: [{ product_id: productId, quantity: 1 }] }
  });
  assert.equal(oversell.status, 409);
  assert.ok(oversell.body.message.includes('স্টক'));

  // Cancelling returns the reserved units.
  const cancelRes = await request(`/api/admin/orders/${orderRes.body.order.id}/status`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: { status: 'cancelled' }
  });
  assert.equal(cancelRes.status, 200);
  const afterCancel = await get('SELECT stock FROM products WHERE id = ?', [productId]);
  assert.equal(afterCancel.stock, 2, 'Cancelling must return the reserved stock');

  // Two simultaneous orders cannot both take the same two units.
  const concurrent = await Promise.all([
    request('/api/orders', { method: 'POST', body: { ...orderBody, items: [{ product_id: productId, quantity: 2 }] } }),
    request('/api/orders', { method: 'POST', body: { ...orderBody, items: [{ product_id: productId, quantity: 2 }] } })
  ]);
  assert.deepEqual(concurrent.map((result) => result.status).sort(), [201, 409]);

  await request(`/api/admin/products/${productId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${adminToken}` }
  });
});

test('Features 16: Admin Image Upload - Direct photo upload with magic byte verification', async () => {
  const adminLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { phone: config.ADMIN.phone, password: config.ADMIN.password }
  });
  const adminToken = adminLogin.body.token;
  assert.ok(adminToken);

  // 1. Unauthenticated request should fail
  const unauthRes = await request('/api/admin/upload-image', {
    method: 'POST',
    body: { image: 'data:image/png;base64,abc' }
  });
  assert.equal(unauthRes.status, 401);

  // 2. Missing body / image payload should fail
  const emptyRes = await request('/api/admin/upload-image', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: {}
  });
  assert.equal(emptyRes.status, 400);

  // 3. Invalid magic bytes (text masquerading as png) should fail
  const fakeImageRes = await request('/api/admin/upload-image', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: { image: 'data:image/png;base64,SGVsbG8gV29ybGQ=' }
  });
  assert.equal(fakeImageRes.status, 400);
  assert.ok(fakeImageRes.body.message.includes('ছবি'));

  // 4. Valid PNG upload with standard data URI
  const validPngBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const uploadRes = await request('/api/admin/upload-image', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: { image: validPngBase64 }
  });
  assert.equal(uploadRes.status, 200);
  assert.equal(uploadRes.body.success, true);
  assert.ok(uploadRes.body.url && uploadRes.body.url.startsWith('/uploads/'));
  assert.ok(uploadRes.body.url.endsWith('.png'));

  // 5. Base64 containing newlines, line wraps, and whitespace (regression test)
  const newlineBase64 = 'data:image/png;base64,\r\niVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk\n+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==\n';
  const newlineUploadRes = await request('/api/admin/upload-image', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: { image: newlineBase64 }
  });
  assert.equal(newlineUploadRes.status, 200);
  assert.equal(newlineUploadRes.body.success, true);
  assert.ok(newlineUploadRes.body.url.startsWith('/uploads/'));

  // 6. Valid WebP upload
  const validWebpBase64 = 'data:image/webp;base64,UklGRkAAAABXRUJQVlA4IDQAAADwAQCdASoBAAEAAQAcJaACdLoB+AA/v2eAAAD+/vz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/Pz8/AAA';
  const webpUploadRes = await request('/api/admin/upload-image', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: { image: validWebpBase64 }
  });
  assert.equal(webpUploadRes.status, 200);
  assert.equal(webpUploadRes.body.success, true);
  assert.ok(webpUploadRes.body.url.endsWith('.webp'));

  // 7. Valid JPEG upload
  const validJpegBase64 = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
  const jpegUploadRes = await request('/api/admin/upload-image', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: { image: validJpegBase64 }
  });
  assert.equal(jpegUploadRes.status, 200);
  assert.equal(jpegUploadRes.body.success, true);
  assert.ok(jpegUploadRes.body.url.endsWith('.jpg'));

  // 8. Multipart form data upload
  const boundary = '---------------------------sbpowertestboundary';
  const pngBinary = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const multipartHeader = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.png"\r\nContent-Type: image/png\r\n\r\n`,
    'binary'
  );
  const multipartFooter = Buffer.from(`\r\n--${boundary}--\r\n`, 'binary');
  const multipartBody = Buffer.concat([multipartHeader, pngBinary, multipartFooter]);

  const multipartRes = await request('/api/admin/upload-image', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`
    },
    body: multipartBody
  });
  assert.equal(multipartRes.status, 200);
  assert.equal(multipartRes.body.success, true);
  assert.ok(multipartRes.body.url.endsWith('.png'));

  // 9. Oversized image rejection (>5MB)
  const oversizeBuf = Buffer.alloc(6 * 1024 * 1024);
  oversizeBuf[0] = 0xFF;
  oversizeBuf[1] = 0xD8;
  oversizeBuf[2] = 0xFF;
  const oversizeRes = await request('/api/admin/upload-image', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: { image: oversizeBuf.toString('base64') }
  });
  assert.equal(oversizeRes.status, 400);
  assert.ok(oversizeRes.body.message.includes('মেগাবাইট'));

  // 10. Verify uploaded file is statically accessible via /uploads/
  const uploadedPath = uploadRes.body.url;
  const staticFileRes = await request(uploadedPath);
  assert.equal(staticFileRes.status, 200);

  // Clean up uploaded test files
  const cleanupUrls = [uploadRes.body.url, newlineUploadRes.body.url, webpUploadRes.body.url, jpegUploadRes.body.url, multipartRes.body.url];
  for (const u of cleanupUrls) {
    if (u && u.startsWith('/uploads/')) {
      const localFilePath = path.join(__dirname, '..', 'public', u.replace(/^\//, ''));
      if (fs.existsSync(localFilePath)) {
        fs.unlinkSync(localFilePath);
      }
    }
  }
});


