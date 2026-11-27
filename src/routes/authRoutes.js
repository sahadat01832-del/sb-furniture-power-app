const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { query, get, run } = require('../db');
const { hashPassword, comparePassword, generateToken, verifyToken, optionalAuth } = require('../auth');
const config = require('../config');

const normalizePhone = (value) => {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('00880')) digits = `0${digits.slice(5)}`;
  else if (digits.startsWith('880')) digits = `0${digits.slice(3)}`;
  return digits;
};

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

// Register
router.post('/register', async (req, res) => {
  try {
    const { name, phone, password, referral_code } = req.body;

    if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) {
      return res.status(400).json({ success: false, message: 'আপনার পূর্ণ নাম প্রদান করুন' });
    }

    const cleanPhone = normalizePhone(phone);
    if (!/^01[3-9]\d{8}$/.test(cleanPhone)) {
      return res.status(400).json({ success: false, message: 'সঠিক ১১ ডিজিটের মোবাইল নম্বর দিন' });
    }

    if (typeof password !== 'string' || Buffer.byteLength(password, 'utf8') < 8 || Buffer.byteLength(password, 'utf8') > 72) {
      return res.status(400).json({ success: false, message: 'পাসওয়ার্ড ৮ থেকে ৭২ বাইটের মধ্যে হতে হবে' });
    }

    // Check if phone already registered
    const existingUser = await get('SELECT * FROM users WHERE phone = ?', [cleanPhone]);
    if (existingUser) {
      return res.status(400).json({ success: false, message: 'এই ফোন নম্বরটি ইতিমধ্যে নিবন্ধিত রয়েছে' });
    }

    if (referral_code !== undefined && referral_code !== null && typeof referral_code !== 'string') {
      return res.status(400).json({ success: false, message: 'রেফারেল কোড সঠিক নয়' });
    }
    if (typeof referral_code === 'string' && referral_code.length > 40) {
      return res.status(400).json({ success: false, message: 'রেফারেল কোড সঠিক নয়' });
    }

    // Check referrer if code provided
    let referredById = null;
    if (referral_code && referral_code.trim()) {
      const referrer = await get("SELECT id FROM users WHERE referral_code = ? AND role IN ('customer', 'reseller') AND status = 'active'", [referral_code.trim().toUpperCase()]);
      if (!referrer) return res.status(400).json({ success: false, message: 'রেফারেল কোডটি পাওয়া যায়নি বা চালু নেই' });
      referredById = referrer.id;
    }

    const passwordHash = await hashPassword(password);
    const myReferralCode = await generateReferralCode(cleanPhone);

    const result = await run(
      `INSERT INTO users (name, phone, password_hash, role, referral_code, referred_by_id)
       VALUES (?, ?, ?, 'customer', ?, ?)`,
      [name.trim(), cleanPhone, passwordHash, myReferralCode, referredById]
    );

    const newUser = {
      id: result.lastID,
      name: name.trim(),
      phone: cleanPhone,
      role: 'customer',
      referral_code: myReferralCode,
      referred_by_id: referredById,
      token_version: 0
    };

    const token = generateToken(newUser);

    res.cookie('token', token, {
      httpOnly: true,
      secure: config.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000
    });

    return res.status(201).json({
      success: true,
      message: 'কাস্টমার অ্যাকাউন্ট তৈরি হয়েছে। রিসেল করতে অ্যাডমিনের অনুমতি লাগবে।',
      token,
      user: newUser
    });
  } catch (error) {
    console.error('Registration Error:', error);
    return res.status(500).json({ success: false, message: 'সার্ভার ত্রুটি, পুনরায় চেষ্টা করুন' });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { phone, password } = req.body;

    if (typeof phone !== 'string' || typeof password !== 'string' || !password) {
      return res.status(400).json({ success: false, message: 'ফোন নম্বর এবং পাসওয়ার্ড আবশ্যক' });
    }

    const cleanPhone = normalizePhone(phone);
    const user = await get('SELECT * FROM users WHERE phone = ?', [cleanPhone]);

    if (!user) {
      return res.status(401).json({ success: false, message: 'ভুল ফোন নম্বর বা পাসওয়ার্ড' });
    }

    const isMatch = await comparePassword(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'ভুল ফোন নম্বর বা পাসওয়ার্ড' });
    }

    if (user.status === 'suspended') {
      return res.status(403).json({ success: false, message: 'আপনার অ্যাকাউন্টটি স্থগিত করা হয়েছে। অ্যাডমিনের সাথে যোগাযোগ করুন।' });
    }

    const userData = {
      id: user.id,
      name: user.name,
      phone: user.phone,
      role: user.role,
      status: user.status || 'active',
      referral_code: user.referral_code,
      referred_by_id: user.referred_by_id,
      payout_method: user.payout_method || null,
      payout_number: user.payout_number || null,
      token_version: user.token_version || 0
    };

    const token = generateToken(userData);

    res.cookie('token', token, {
      httpOnly: true,
      secure: config.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000
    });

    return res.json({
      success: true,
      message: 'লগইন সফল হয়েছে!',
      token,
      user: userData
    });
  } catch (error) {
    console.error('Login Error:', error);
    return res.status(500).json({ success: false, message: 'সার্ভার ত্রুটি, পুনরায় চেষ্টা করুন' });
  }
});

// Current user profile
router.get('/me', verifyToken, async (req, res) => {
  try {
    const user = await get(
      'SELECT id, name, phone, role, status, payout_method, payout_number, referral_code, referred_by_id, created_at FROM users WHERE id = ?',
      [req.user.id]
    );

    if (!user) {
      return res.status(404).json({ success: false, message: 'ইউজার পাওয়া যায়নি' });
    }

    return res.json({ success: true, user });
  } catch (error) {
    console.error('Profile Error:', error);
    return res.status(500).json({ success: false, message: 'সার্ভার ত্রুটি' });
  }
});

// Update Profile (Name & payout details)
router.put('/me', verifyToken, async (req, res) => {
  try {
    const { name, payout_method, payout_number } = req.body;
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) {
      return res.status(400).json({ success: false, message: 'নাম প্রদান করুন' });
    }

    let cleanPayoutMethod = null;
    let cleanPayoutNumber = null;
    if (payout_method) {
      if (!['bkash', 'nagad', 'rocket'].includes(payout_method)) {
        return res.status(400).json({ success: false, message: 'সঠিক পেমেন্ট মেথড (bKash, Nagad, Rocket) নির্বাচন করুন' });
      }
      cleanPayoutMethod = payout_method;
    }
    if (payout_number) {
      const cleanNum = normalizePhone(payout_number);
      if (!/^01[3-9]\d{8}$/.test(cleanNum)) {
        return res.status(400).json({ success: false, message: 'সঠিক ১১ ডিজিটের মোবাইল নম্বর দিন' });
      }
      cleanPayoutNumber = cleanNum;
    }

    await run(
      'UPDATE users SET name = ?, payout_method = COALESCE(?, payout_method), payout_number = COALESCE(?, payout_number) WHERE id = ?',
      [name.trim(), cleanPayoutMethod, cleanPayoutNumber, req.user.id]
    );
    const updatedUser = await get(
      'SELECT id, name, phone, role, status, payout_method, payout_number, referral_code, referred_by_id, created_at FROM users WHERE id = ?',
      [req.user.id]
    );

    return res.json({
      success: true,
      message: 'প্রোফাইল সফলভাবে আপডেট হয়েছে!',
      user: updatedUser
    });
  } catch (error) {
    console.error('Update Profile Error:', error);
    return res.status(500).json({ success: false, message: 'প্রোফাইল আপডেট ব্যর্থ হয়েছে' });
  }
});

// Password Change Endpoint
router.post('/change-password', verifyToken, async (req, res) => {
  try {
    const { old_password, new_password } = req.body;

    if (typeof old_password !== 'string' || typeof new_password !== 'string' || !old_password || !new_password) {
      return res.status(400).json({ success: false, message: 'পুরাতন ও নতুন উভয় পাসওয়ার্ড প্রদান করুন' });
    }

    if (Buffer.byteLength(new_password, 'utf8') < 8 || Buffer.byteLength(new_password, 'utf8') > 72) {
      return res.status(400).json({ success: false, message: 'নতুন পাসওয়ার্ড ৮ থেকে ৭২ বাইটের মধ্যে হতে হবে' });
    }

    const user = await get('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
    if (!user) {
      return res.status(404).json({ success: false, message: 'ব্যবহারকারী পাওয়া যায়নি' });
    }

    const isMatch = await comparePassword(old_password, user.password_hash);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'বর্তমান পাসওয়ার্ড সঠিক নয়' });
    }

    const newHash = await hashPassword(new_password);
    // Bumping the version signs every other device out.
    await run(
      'UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?',
      [newHash, req.user.id]
    );

    // This session keeps working: hand it a token with the new version.
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
      message: 'পাসওয়ার্ড সফলভাবে পরিবর্তন করা হয়েছে! অন্যান্য ডিভাইস থেকে লগআউট হয়ে গেছে।',
      token
    });
  } catch (error) {
    console.error('Change Password Error:', error);
    return res.status(500).json({ success: false, message: 'পাসওয়ার্ড পরিবর্তনে সমস্যা হয়েছে' });
  }
});

// Session Persistence Check (Non-throwing session lookup)
router.get('/session', async (req, res) => {
  try {
    let token = null;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    } else if (req.cookies && req.cookies.token) {
      token = req.cookies.token;
    }

    if (!token) {
      return res.json({ success: true, authenticated: false, user: null });
    }

    const jwt = require('jsonwebtoken');
    const config = require('../config');
    let decoded;
    try {
      decoded = jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'] });
    } catch (e) {
      return res.json({ success: true, authenticated: false, user: null });
    }

    const user = await get(
      'SELECT id, name, phone, role, status, referral_code, referred_by_id, token_version, created_at FROM users WHERE id = ?',
      [decoded.id]
    );

    // Report the same session state verifyToken enforces: a suspended account
    // is never authenticated, even while its JWT is still valid.
    if (
      !user ||
      user.status === 'suspended' ||
      (Number(decoded.token_version) || 0) !== (Number(user.token_version) || 0)
    ) {
      return res.json({ success: true, authenticated: false, user: null });
    }
    delete user.token_version;

    return res.json({
      success: true,
      authenticated: true,
      user
    });
  } catch (error) {
    return res.json({ success: true, authenticated: false, user: null });
  }
});

// User Notifications
router.get('/notifications', verifyToken, async (req, res) => {
  try {
    const list = await query(
      'SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50',
      [req.user.id]
    );
    const unreadRow = await get(
      'SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0',
      [req.user.id]
    );
    return res.json({
      success: true,
      unread_count: unreadRow ? unreadRow.count : 0,
      notifications: list
    });
  } catch (error) {
    console.error('Fetch Notifications Error:', error);
    return res.status(500).json({ success: false, message: 'নোটিফিকেশন লোড করতে সমস্যা হয়েছে' });
  }
});

// Mark All Notifications as Read
router.put('/notifications/read-all', verifyToken, async (req, res) => {
  try {
    await run('UPDATE notifications SET is_read = 1 WHERE user_id = ?', [req.user.id]);
    return res.json({ success: true, message: 'সকল নোটিফিকেশন পঠিত হিসেবে চিহ্নিত করা হয়েছে' });
  } catch (error) {
    console.error('Read All Notifications Error:', error);
    return res.status(500).json({ success: false, message: 'সার্ভার ত্রুটি' });
  }
});

// Mark Notification as Read
router.put('/notifications/:id/read', verifyToken, async (req, res) => {
  try {
    const notifId = parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(notifId) || notifId < 1) {
      return res.status(400).json({ success: false, message: 'নোটিফিকেশন আইডি সঠিক নয়' });
    }
    await run('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?', [notifId, req.user.id]);
    return res.json({ success: true, message: 'পঠিত হিসেবে চিহ্নিত করা হয়েছে' });
  } catch (error) {
    console.error('Notification Read Error:', error);
    return res.status(500).json({ success: false, message: 'সার্ভার ত্রুটি' });
  }
});

// Logout (revokes current JWT via token_version bump and clears cookie)
router.post('/logout', optionalAuth, async (req, res) => {
  try {
    if (req.user && req.user.id) {
      await run('UPDATE users SET token_version = token_version + 1 WHERE id = ?', [req.user.id]);
    }
  } catch (error) {
    console.error('Logout token revocation error:', error);
  }
  res.clearCookie('token', {
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    sameSite: 'lax'
  });
  res.json({ success: true, message: 'সফলভাবে লগআউট হয়েছেন' });
});

module.exports = router;
