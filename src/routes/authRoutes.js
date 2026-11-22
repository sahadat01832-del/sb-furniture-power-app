const express = require('express');
const router = express.Router();
const { query, get, run } = require('../db');
const { hashPassword, comparePassword, generateToken, verifyToken } = require('../auth');

// Generate collision-resistant unique referral code
const generateReferralCode = async (phone) => {
  const cleanPhone = phone.replace(/\D/g, '').slice(-4);
  let code;
  let exists = true;
  while (exists) {
    const randomLetters = Math.random().toString(36).substring(2, 6).toUpperCase();
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

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'আপনার পূর্ণ নাম প্রদান করুন' });
    }

    if (!phone || !phone.trim() || phone.trim().length < 11) {
      return res.status(400).json({ success: false, message: 'সঠিক ১১ ডিজিটের মোবাইল নম্বর দিন' });
    }

    if (!password || password.length < 6) {
      return res.status(400).json({ success: false, message: 'পাসওয়ার্ড ন্যূনতম ৬ অক্ষরের হতে হবে' });
    }

    const cleanPhone = phone.trim();

    // Check if phone already registered
    const existingUser = await get('SELECT * FROM users WHERE phone = ?', [cleanPhone]);
    if (existingUser) {
      return res.status(400).json({ success: false, message: 'এই ফোন নম্বরটি ইতিমধ্যে নিবন্ধিত রয়েছে' });
    }

    // Check referrer if code provided
    let referredById = null;
    if (referral_code && referral_code.trim()) {
      const referrer = await get('SELECT id FROM users WHERE referral_code = ?', [referral_code.trim().toUpperCase()]);
      if (referrer) {
        referredById = referrer.id;
      }
    }

    const passwordHash = await hashPassword(password);
    const myReferralCode = await generateReferralCode(cleanPhone);

    const result = await run(
      `INSERT INTO users (name, phone, password_hash, role, referral_code, referred_by_id)
       VALUES (?, ?, ?, 'reseller', ?, ?)`,
      [name.trim(), cleanPhone, passwordHash, myReferralCode, referredById]
    );

    const newUser = {
      id: result.lastID,
      name: name.trim(),
      phone: cleanPhone,
      role: 'reseller',
      referral_code: myReferralCode,
      referred_by_id: referredById
    };

    const token = generateToken(newUser);

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 30 * 24 * 60 * 60 * 1000
    });

    return res.status(201).json({
      success: true,
      message: 'রেজিস্ট্রেশন সফল হয়েছে!',
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

    if (!phone || !password) {
      return res.status(400).json({ success: false, message: 'ফোন নম্বর এবং পাসওয়ার্ড আবশ্যক' });
    }

    const cleanPhone = phone.trim();
    const user = await get('SELECT * FROM users WHERE phone = ?', [cleanPhone]);

    if (!user) {
      return res.status(401).json({ success: false, message: 'ভুল ফোন নম্বর বা পাসওয়ার্ড' });
    }

    const isMatch = await comparePassword(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'ভুল ফোন নম্বর বা পাসওয়ার্ড' });
    }

    const userData = {
      id: user.id,
      name: user.name,
      phone: user.phone,
      role: user.role,
      referral_code: user.referral_code,
      referred_by_id: user.referred_by_id
    };

    const token = generateToken(userData);

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
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
      'SELECT id, name, phone, role, referral_code, referred_by_id, created_at FROM users WHERE id = ?',
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

// Update Profile (Name & details)
router.put('/me', verifyToken, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'নাম প্রদান করুন' });
    }

    await run('UPDATE users SET name = ? WHERE id = ?', [name.trim(), req.user.id]);
    const updatedUser = await get(
      'SELECT id, name, phone, role, referral_code, referred_by_id, created_at FROM users WHERE id = ?',
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

    if (!old_password || !new_password) {
      return res.status(400).json({ success: false, message: 'পুরাতন ও নতুন উভয় পাসওয়ার্ড প্রদান করুন' });
    }

    if (new_password.length < 6) {
      return res.status(400).json({ success: false, message: 'নতুন পাসওয়ার্ড ন্যূনতম ৬ অক্ষরের হতে হবে' });
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
    await run('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, req.user.id]);

    return res.json({
      success: true,
      message: 'পাসওয়ার্ড সফলভাবে পরিবর্তন করা হয়েছে!'
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
      decoded = jwt.verify(token, config.JWT_SECRET);
    } catch (e) {
      return res.json({ success: true, authenticated: false, user: null });
    }

    const user = await get(
      'SELECT id, name, phone, role, referral_code, referred_by_id, created_at FROM users WHERE id = ?',
      [decoded.id]
    );

    if (!user) {
      return res.json({ success: true, authenticated: false, user: null });
    }

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
    await run('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?', [notifId, req.user.id]);
    return res.json({ success: true, message: 'পঠিত হিসেবে চিহ্নিত করা হয়েছে' });
  } catch (error) {
    console.error('Notification Read Error:', error);
    return res.status(500).json({ success: false, message: 'সার্ভার ত্রুটি' });
  }
});

// Logout
router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true, message: 'সফলভাবে লগআউট হয়েছেন' });
});

module.exports = router;
