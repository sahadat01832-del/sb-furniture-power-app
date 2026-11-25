const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { query, get, run } = require('../db');
const { hashPassword, comparePassword, generateToken } = require('../auth');
const { takaFields } = require('../money');
const config = require('../config');

// Generate collision-resistant unique referral code
const generateReferralCode = async (phone) => {
  const cleanPhone = phone.replace(/\D/g, '').slice(-4);
  let code;
  let exists = true;
  while (exists) {
    const randomLetters = crypto.randomBytes(3).toString('hex').slice(0, 4).toUpperCase();
    code = `SB${cleanPhone}${randomLetters}`;
    const row = await get('SELECT id FROM users WHERE referral_code = ?', [code]);
    if (!row) exists = false;
  }
  return code;
};

// ==========================================
// 1. GET /api/admin/users
// List users with search, role filter, pagination, balance, and order stats
// ==========================================
router.get('/users', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;

    const searchTerm = (req.query.q || req.query.search || '').trim();
    const roleFilter = (req.query.role || 'all').trim().toLowerCase();

    const conditions = [];
    const params = [];

    if (searchTerm) {
      conditions.push('(u.name LIKE ? OR u.phone LIKE ? OR u.referral_code LIKE ?)');
      const wild = `%${searchTerm}%`;
      params.push(wild, wild, wild);
    }

    if (roleFilter && roleFilter !== 'all') {
      conditions.push('u.role = ?');
      params.push(roleFilter);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Count total matching users
    const countSql = `SELECT COUNT(*) as total FROM users u ${whereClause}`;
    const countRow = await get(countSql, params);
    const total = countRow ? countRow.total : 0;
    const totalPages = Math.ceil(total / limit) || 1;

    // Fetch paginated users with order volume and net wallet balance
    const listSql = `
      SELECT 
        u.id,
        u.name,
        u.phone,
        u.role,
        u.status,
        u.referral_code,
        u.referred_by_id,
        u.created_at,
        r.name as referred_by_name,
        COALESCE(ord.total_orders, 0) as total_orders,
        COALESCE(ord.total_sales, 0) as total_sales,
        MAX(0, COALESCE(bal.earned, 0) - COALESCE(bal.payout_committed, 0)) as balance
      FROM users u
      LEFT JOIN users r ON u.referred_by_id = r.id
      LEFT JOIN (
        SELECT reseller_id, COUNT(*) as total_orders, SUM(total_amount) as total_sales
        FROM orders
        GROUP BY reseller_id
      ) ord ON u.id = ord.reseller_id
      LEFT JOIN (
        SELECT user_id,
          SUM(CASE WHEN status IN ('available', 'completed') AND type IN ('commission', 'referral_commission', 'referral_bonus', 'team_bonus') THEN amount ELSE 0 END) as earned,
          SUM(CASE WHEN type = 'payout' AND status IN ('pending', 'approved', 'completed') THEN amount ELSE 0 END) as payout_committed
        FROM wallet_transactions
        GROUP BY user_id
      ) bal ON u.id = bal.user_id
      ${whereClause}
      ORDER BY u.id DESC
      LIMIT ? OFFSET ?
    `;

    const users = await query(listSql, [...params, limit, offset]);

    return res.json({
      success: true,
      users: users.map((user) => takaFields(user, ['total_sales', 'balance'])),
      pagination: {
        page,
        limit,
        total,
        totalPages
      }
    });
  } catch (error) {
    console.error('Admin List Users Error:', error);
    return res.status(500).json({ success: false, message: 'ইউজার তালিকা লোড করতে সমস্যা হয়েছে' });
  }
});

// ==========================================
// 2. POST /api/admin/users
// Create a new User or Admin with validation
// ==========================================
router.post('/users', async (req, res) => {
  try {
    const { name, phone, password, role } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length < 2) {
      return res.status(400).json({ success: false, message: 'সঠিক পূর্ণ নাম দিন (কমপক্ষে ২ অক্ষর)' });
    }

    if (!phone || typeof phone !== 'string') {
      return res.status(400).json({ success: false, message: 'ফোন নম্বর দিন' });
    }

    const cleanPhone = phone.trim().replace(/\s+/g, '');
    const phoneRegex = /^01[3-9]\d{8}$/;
    if (!phoneRegex.test(cleanPhone)) {
      return res.status(400).json({ success: false, message: 'সঠিক ১১ ডিজিটের বাংলাদেশী মোবাইল নম্বর দিন (যেমন: 01XXXXXXXXX)' });
    }

    if (typeof password !== 'string' || Buffer.byteLength(password, 'utf8') < 8 || Buffer.byteLength(password, 'utf8') > 72) {
      return res.status(400).json({ success: false, message: 'পাসওয়ার্ড ৮ থেকে ৭২ বাইটের মধ্যে হতে হবে' });
    }

    const targetRole = (role || 'customer').toLowerCase().trim();
    const validRoles = ['admin', 'reseller', 'customer'];
    if (!validRoles.includes(targetRole)) {
      return res.status(400).json({ success: false, message: 'অবৈধ পদবি/রোল। অনুমোদিত: admin, reseller, customer' });
    }

    // Duplicate Phone Check
    const existingUser = await get('SELECT id FROM users WHERE phone = ?', [cleanPhone]);
    if (existingUser) {
      return res.status(400).json({ success: false, message: 'এই ফোন নম্বরটি ইতিমধ্যে নিবন্ধিত রয়েছে' });
    }

    const passwordHash = await hashPassword(password);
    const referralCode = await generateReferralCode(cleanPhone);

    const result = await run(
      `INSERT INTO users (name, phone, password_hash, role, referral_code) VALUES (?, ?, ?, ?, ?)`,
      [name.trim(), cleanPhone, passwordHash, targetRole, referralCode]
    );

    return res.status(201).json({
      success: true,
      message: targetRole === 'admin' ? 'নতুন এডমিন সফলভাবে তৈরি করা হয়েছে!' : 'নতুন ইউজার সফলভাবে তৈরি করা হয়েছে!',
      user: {
        id: result.lastID,
        name: name.trim(),
        phone: cleanPhone,
        role: targetRole,
        referral_code: referralCode,
        created_at: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Admin Create User Error:', error);
    return res.status(500).json({ success: false, message: 'নতুন ইউজার তৈরিতে সমস্যা হয়েছে' });
  }
});

// ==========================================
// 3. PUT /api/admin/users/:id/role
// Update user role (promote to admin or demote)
// ==========================================
router.put('/users/:id/role', async (req, res) => {
  try {
    const targetUserId = parseInt(req.params.id, 10);
    const { role } = req.body;

    if (!Number.isSafeInteger(targetUserId) || targetUserId < 1) {
      return res.status(400).json({ success: false, message: 'অবৈধ ইউজার আইডি' });
    }

    const newRole = (role || '').toLowerCase().trim();
    const validRoles = ['admin', 'reseller', 'customer'];
    if (!validRoles.includes(newRole)) {
      return res.status(400).json({ success: false, message: 'অবৈধ পদবি/রোল। অনুমোদিত: admin, reseller, customer' });
    }

    // Verify target user exists
    const targetUser = await get('SELECT id, name, role, phone FROM users WHERE id = ?', [targetUserId]);
    if (!targetUser) {
      return res.status(404).json({ success: false, message: 'ইউজার পাওয়া যায়নি' });
    }

    // Safety 1: Prevent admin from demoting themselves
    if (req.user && req.user.id === targetUserId && newRole !== 'admin') {
      return res.status(400).json({ success: false, message: 'আপনি নিজের এডমিন পদবি বাতিল করতে পারবেন না' });
    }

    // Safety 2: Prevent demoting the last admin in the entire platform
    if (targetUser.role === 'admin' && newRole !== 'admin') {
      const adminCountRow = await get("SELECT COUNT(*) as count FROM users WHERE role = 'admin'");
      if (adminCountRow && adminCountRow.count <= 1) {
        return res.status(400).json({ success: false, message: 'সিস্টেমে ন্যূনতম একজন এডমিন থাকা আবশ্যক' });
      }
    }

    await run('UPDATE users SET role = ? WHERE id = ?', [newRole, targetUserId]);

    return res.json({
      success: true,
      message: `${targetUser.name}-এর রোল সফলভাবে '${newRole}' করা হয়েছে!`,
      userId: targetUserId,
      role: newRole
    });
  } catch (error) {
    console.error('Admin Update Role Error:', error);
    return res.status(500).json({ success: false, message: 'ইউজার রোল আপডেট করতে ব্যর্থ হয়েছে' });
  }
});

// ==========================================
// 3b. PUT /api/admin/users/:id/status
// Toggle user account status (active vs suspended)
// ==========================================
router.put('/users/:id/status', async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const { status } = req.body;
    if (!Number.isSafeInteger(userId) || userId < 1) {
      return res.status(400).json({ success: false, message: 'ইউজার আইডি সঠিক নয়' });
    }
    if (!['active', 'suspended'].includes(status)) {
      return res.status(400).json({ success: false, message: 'অবৈধ স্ট্যাটাস (active বা suspended হতে হবে)' });
    }

    const targetUser = await get('SELECT id, name, role FROM users WHERE id = ?', [userId]);
    if (!targetUser) {
      return res.status(404).json({ success: false, message: 'ইউজার খুঁজে পাওয়া যায়নি' });
    }

    if (targetUser.id === req.user.id && status === 'suspended') {
      return res.status(400).json({ success: false, message: 'নিজের অ্যাকাউন্ট স্থগিত করা যাবে না' });
    }

    await run('UPDATE users SET status = ? WHERE id = ?', [status, userId]);

    return res.json({
      success: true,
      message: `${targetUser.name}-এর অ্যাকাউন্ট সফলভাবে ${status === 'active' ? 'সক্রিয়' : 'স্থগিত'} করা হয়েছে!`,
      userId,
      status
    });
  } catch (error) {
    console.error('Admin Update User Status Error:', error);
    return res.status(500).json({ success: false, message: 'ইউজার স্ট্যাটাস পরিবর্তন করতে ব্যর্থ হয়েছে' });
  }
});

// ==========================================
// 4. PUT /api/admin/profile/password
// Easy password update for logged-in admin
// ==========================================
router.put('/profile/password', async (req, res) => {
  try {
    const { old_password, new_password } = req.body;

    if (typeof old_password !== 'string' || !old_password) {
      return res.status(400).json({ success: false, message: 'বর্তমান পাসওয়ার্ড দেওয়া আবশ্যক' });
    }

    if (typeof new_password !== 'string' || Buffer.byteLength(new_password, 'utf8') < 12 || Buffer.byteLength(new_password, 'utf8') > 72) {
      return res.status(400).json({ success: false, message: 'নতুন পাসওয়ার্ড ১২ থেকে ৭২ বাইটের মধ্যে হতে হবে' });
    }

    const adminUser = await get('SELECT id, password_hash FROM users WHERE id = ?', [req.user.id]);
    if (!adminUser) {
      return res.status(404).json({ success: false, message: 'এডমিন একাউন্ট পাওয়া যায়নি' });
    }

    // The current password is mandatory: a stolen admin token alone must never
    // be enough to replace the password and take over the account.
    const isMatch = await comparePassword(old_password, adminUser.password_hash);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'বর্তমান পাসওয়ার্ডটি সঠিক নয়' });
    }

    const newHash = await hashPassword(new_password);
    await run(
      'UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?',
      [newHash, req.user.id]
    );

    const refreshedUser = await get(
      'SELECT id, name, phone, role, referral_code, token_version FROM users WHERE id = ?',
      [req.user.id]
    );
    const token = generateToken(refreshedUser);
    res.cookie('token', token, {
      httpOnly: true,
      secure: config.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000
    });

    return res.json({
      success: true,
      message: 'এডমিন পাসওয়ার্ড সফলভাবে আপডেট হয়েছে! অন্যান্য ডিভাইস থেকে লগআউট হয়ে গেছে।',
      token
    });
  } catch (error) {
    console.error('Admin Change Password Error:', error);
    return res.status(500).json({ success: false, message: 'পাসওয়ার্ড পরিবর্তন করতে ব্যর্থ হয়েছে' });
  }
});

module.exports = router;
