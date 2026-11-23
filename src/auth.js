const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('./config');
const { get } = require('./db');

const getRequestToken = (req) => {
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    return req.headers.authorization.slice(7).trim();
  }
  return req.cookies && req.cookies.token ? req.cookies.token : null;
};

const hashPassword = async (plainPassword) => {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(plainPassword, salt);
};

const comparePassword = async (plainPassword, hashedPassword) => {
  return bcrypt.compare(plainPassword, hashedPassword);
};

const generateToken = (user) => {
  return jwt.sign(
    {
      id: user.id,
      phone: user.phone,
      name: user.name,
      role: user.role,
      referral_code: user.referral_code
    },
    config.JWT_SECRET,
    { expiresIn: '30d' }
  );
};

const verifyToken = async (req, res, next) => {
  const token = getRequestToken(req);
  if (!token) {
    return res.status(401).json({ success: false, message: 'লগইন আবশ্যক (অনুগ্রহ করে সাইন-ইন করুন)' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'] });
  } catch (err) {
    return res.status(403).json({ success: false, message: 'মেয়াদোত্তীর্ণ বা অবৈধ টোকেন' });
  }

  try {
    const user = await get(
      'SELECT id, name, phone, role, referral_code, referred_by_id FROM users WHERE id = ?',
      [decoded.id]
    );
    if (!user) {
      return res.status(401).json({ success: false, message: 'ব্যবহারকারী পাওয়া যায়নি; আবার লগইন করুন' });
    }
    req.user = user;
    return next();
  } catch (err) {
    return next(err);
  }
};

const optionalAuth = async (req, res, next) => {
  const token = getRequestToken(req);
  if (!token) {
    req.user = null;
    return next();
  }

  let decoded;
  try {
    decoded = jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'] });
  } catch (e) {
    req.user = null;
    return next();
  }

  try {
    req.user = await get(
      'SELECT id, name, phone, role, referral_code, referred_by_id FROM users WHERE id = ?',
      [decoded.id]
    ) || null;
    return next();
  } catch (err) {
    return next(err);
  }
};

const requireRole = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'আপনার এই অপশনে প্রবেশের অনুমতি নেই' });
    }
    next();
  };
};

module.exports = {
  hashPassword,
  comparePassword,
  generateToken,
  verifyToken,
  optionalAuth,
  requireRole
};
