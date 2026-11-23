require('./testEnv');

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const app = require('../src/server');
const { initDb, run, get } = require('../src/db');
const { hashPassword } = require('../src/auth');

let server;
let baseUrl;
let adminToken;
let resellerToken;
let adminUserId;
let sampleResellerId;
const isolatedAdminPassword = crypto.randomBytes(24).toString('hex');
const nextAdminPassword = crypto.randomBytes(24).toString('hex');

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

  // Start test server on dynamic port
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  // Ensure isolated test admin exists for this test suite
  const adminHash = await hashPassword(isolatedAdminPassword);
  let admin = await get("SELECT * FROM users WHERE phone = '01999887766'");
  if (!admin) {
    const res = await run(
      "INSERT INTO users (name, phone, password_hash, role, referral_code) VALUES ('Admin User Isolated', '01999887766', ?, 'admin', 'SBISOADMIN01')",
      [adminHash]
    );
    adminUserId = res.lastID;
  } else {
    adminUserId = admin.id;
    await run("UPDATE users SET password_hash = ?, role = 'admin' WHERE id = ?", [adminHash, adminUserId]);
  }

  // Login as isolated admin
  const adminLoginRes = await request('/api/auth/login', {
    method: 'POST',
    body: { phone: '01999887766', password: isolatedAdminPassword }
  });
  assert.equal(adminLoginRes.status, 200);
  adminToken = adminLoginRes.body.token;

  // Create or reset isolated sample reseller
  const resellerHash = await hashPassword('reseller123');
  const existingReseller = await get("SELECT * FROM users WHERE phone = '01999887755'");
  if (existingReseller) {
    sampleResellerId = existingReseller.id;
    await run("UPDATE users SET role = 'reseller', password_hash = ? WHERE id = ?", [resellerHash, sampleResellerId]);
  } else {
    const res = await run(
      "INSERT INTO users (name, phone, password_hash, role, referral_code) VALUES ('Sample Reseller Isolated', '01999887755', ?, 'reseller', 'SBISORSL01')",
      [resellerHash]
    );
    sampleResellerId = res.lastID;
  }

  // Login as isolated reseller
  const resLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { phone: '01999887755', password: 'reseller123' }
  });
  assert.equal(resLogin.status, 200);
  resellerToken = resLogin.body.token;
});

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Admin Users 1: Authentication & Authorization controls', async () => {
  // Unauthenticated request should be 401
  const unauthRes = await request('/api/admin/users');
  assert.equal(unauthRes.status, 401);

  // Reseller token should be forbidden (403)
  const forbiddenRes = await request('/api/admin/users', {
    headers: { Authorization: `Bearer ${resellerToken}` }
  });
  assert.equal(forbiddenRes.status, 403);

  // Admin token should succeed (200)
  const okRes = await request('/api/admin/users', {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(okRes.status, 200);
  assert.equal(okRes.body.success, true);
  assert(Array.isArray(okRes.body.users));
  assert(okRes.body.pagination);
});

test('Admin Users 2: List users with search, role filter, and pagination', async () => {
  // Filter by role=admin
  const adminsRes = await request('/api/admin/users?role=admin', {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(adminsRes.status, 200);
  assert(adminsRes.body.users.every((u) => u.role === 'admin'));

  // Filter by role=reseller
  const resellersRes = await request('/api/admin/users?role=reseller', {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(resellersRes.status, 200);
  assert(resellersRes.body.users.every((u) => u.role === 'reseller'));

  // Search by phone
  const searchPhoneRes = await request('/api/admin/users?q=01999887755', {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(searchPhoneRes.status, 200);
  assert.equal(searchPhoneRes.body.users.length >= 1, true);
  assert.equal(searchPhoneRes.body.users[0].phone, '01999887755');
  assert(searchPhoneRes.body.users[0].balance !== undefined);
  assert(searchPhoneRes.body.users[0].total_orders !== undefined);

  // Pagination verification
  const pageRes = await request('/api/admin/users?page=1&limit=2', {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  assert.equal(pageRes.status, 200);
  assert.equal(pageRes.body.pagination.limit, 2);
  assert(pageRes.body.users.length <= 2);
});

test('Admin Users 3: Validation and creation of new user or admin (POST /api/admin/users)', async () => {
  // Test invalid name
  const invalidNameRes = await request('/api/admin/users', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: { name: '', phone: '01711223344', password: 'password123', role: 'admin' }
  });
  assert.equal(invalidNameRes.status, 400);

  // Test invalid phone (not 11 digits / not BD format)
  const invalidPhoneRes = await request('/api/admin/users', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: { name: 'Test User', phone: '12345', password: 'password123', role: 'admin' }
  });
  assert.equal(invalidPhoneRes.status, 400);

  // Test short password
  const shortPassRes = await request('/api/admin/users', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: { name: 'Test User', phone: '01711223344', password: '123', role: 'admin' }
  });
  assert.equal(shortPassRes.status, 400);

  // Test invalid role
  const invalidRoleRes = await request('/api/admin/users', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: { name: 'Test User', phone: '01711223344', password: 'password123', role: 'supergod' }
  });
  assert.equal(invalidRoleRes.status, 400);

  // Create new Admin successfully
  const testAdminPhone = `017${Math.floor(10000000 + Math.random() * 90000000)}`;
  const createAdminRes = await request('/api/admin/users', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: {
      name: 'সহকারী এডমিন রফিক',
      phone: testAdminPhone,
      password: 'adminSecuredPassword123',
      role: 'admin'
    }
  });
  assert.equal(createAdminRes.status, 201);
  assert.equal(createAdminRes.body.success, true);
  assert.equal(createAdminRes.body.user.role, 'admin');
  assert.equal(createAdminRes.body.user.phone, testAdminPhone);
  assert(createAdminRes.body.user.referral_code);

  // Test duplicate phone rejection
  const dupRes = await request('/api/admin/users', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: {
      name: 'ডুপ্লিকেট ইউজার',
      phone: testAdminPhone,
      password: 'password123',
      role: 'reseller'
    }
  });
  assert.equal(dupRes.status, 400);
  assert.match(dupRes.body.message, /ইতিমধ্যে নিবন্ধিত/);

  // Verify created admin can actually log in
  const newAdminLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { phone: testAdminPhone, password: 'adminSecuredPassword123' }
  });
  assert.equal(newAdminLogin.status, 200);
  assert.equal(newAdminLogin.body.user.role, 'admin');
});

test('Admin Users 4: Role toggling, promotion and demotion protection (PUT /api/admin/users/:id/role)', async () => {
  // Promote reseller to admin
  const promoteRes = await request(`/api/admin/users/${sampleResellerId}/role`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: { role: 'admin' }
  });
  assert.equal(promoteRes.status, 200);
  assert.equal(promoteRes.body.success, true);
  assert.equal(promoteRes.body.role, 'admin');

  // Verify DB record updated
  const updatedUser = await get('SELECT role FROM users WHERE id = ?', [sampleResellerId]);
  assert.equal(updatedUser.role, 'admin');

  // Demote back to reseller
  const demoteRes = await request(`/api/admin/users/${sampleResellerId}/role`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: { role: 'reseller' }
  });
  assert.equal(demoteRes.status, 200);
  assert.equal(demoteRes.body.role, 'reseller');

  // Safety: Prevent admin from demoting themselves
  const selfDemoteRes = await request(`/api/admin/users/${adminUserId}/role`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: { role: 'reseller' }
  });
  assert.equal(selfDemoteRes.status, 400);
  assert.match(selfDemoteRes.body.message, /নিজের এডমিন পদবি/);
});

test('Admin Users 5: Admin profile password update (PUT /api/admin/profile/password)', async () => {
  // Attempt with a password below the 8-byte minimum
  const shortPass = await request('/api/admin/profile/password', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: { old_password: isolatedAdminPassword, new_password: '123' }
  });
  assert.equal(shortPass.status, 400);

  // Attempt with wrong old password
  const wrongOldPass = await request('/api/admin/profile/password', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: { old_password: 'completely_wrong_pass', new_password: 'newSecretPass789' }
  });
  assert.equal(wrongOldPass.status, 400);
  assert.match(wrongOldPass.body.message, /বর্তমান পাসওয়ার্ডটি সঠিক নয়/);

  // Successfully update password
  const successPass = await request('/api/admin/profile/password', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${adminToken}` },
    body: { old_password: isolatedAdminPassword, new_password: nextAdminPassword }
  });
  assert.equal(successPass.status, 200);
  assert.equal(successPass.body.success, true);

  // Verify login works with the new password
  const newLogin = await request('/api/auth/login', {
    method: 'POST',
    body: { phone: '01999887766', password: nextAdminPassword }
  });
  assert.equal(newLogin.status, 200);

  // Reset password back to original so subsequent tests/logins work
  const resetPass = await request('/api/admin/profile/password', {
    method: 'PUT',
    headers: { Authorization: `Bearer ${newLogin.body.token}` },
    body: { old_password: nextAdminPassword, new_password: isolatedAdminPassword }
  });
  assert.equal(resetPass.status, 200);
});
