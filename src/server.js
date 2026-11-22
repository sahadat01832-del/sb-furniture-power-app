const express = require('express');
const path = require('path');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const { initDb, get, query } = require('./db');

const authRoutes = require('./routes/authRoutes');
const productRoutes = require('./routes/productRoutes');
const orderRoutes = require('./routes/orderRoutes');
const walletRoutes = require('./routes/walletRoutes');
const adminRoutes = require('./routes/adminRoutes');
const leaderboardRoutes = require('./routes/leaderboardRoutes');

const app = express();

// Security Middlewares
app.use(
  helmet({
    contentSecurityPolicy: false, // Allows inline scripts/styles for modern PWA frontend
    crossOriginEmbedderPolicy: false
  })
);
app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// Rate Limiting (Protects public APIs against abuse)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: { success: false, message: 'অনেক বেশি রিকোয়েস্ট পাঠানো হয়েছে, কিছুক্ষণ পর চেষ্টা করুন।' }
});
app.use('/api/', limiter);

// Uptime & Health Check Endpoint (Commercial Readiness Rule)
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    app: 'SB Furniture & SB POWER Platform'
  });
});

// Public Config, Flash Deals & Brand Contacts Endpoint
app.get('/api/config', async (req, res) => {
  try {
    const activeAnns = await query("SELECT * FROM announcements WHERE is_active = 1 ORDER BY id DESC");
    const activeAnn = activeAnns.length > 0 ? activeAnns[0] : null;
    res.json({
      success: true,
      furniture: config.SB_FURNITURE,
      power: config.SB_POWER,
      delivery: config.DELIVERY,
      referral: config.REFERRAL,
      announcement: {
        flash_deal_active: activeAnn ? true : false,
        headline: activeAnn ? activeAnn.title : '🔥 মেগা অফার: আজই প্রথম সফল অর্ডারে ৫০৳ ইনস্ট্যান্ট বোনাস! প্রতি সপ্তাহে বিকাশ ও নগদে দ্রুত ক্যাশআউট!',
        subtext: activeAnn ? activeAnn.message : '🏆 চলতি মাসের শীর্ষ ৩ জন সফল রিসেলারের জন্য রয়েছে স্মার্টফোন, স্মার্টওয়াচ ও ক্যাশ প্রাইজ!'
      },
      announcements: activeAnns
    });
  } catch (err) {
    res.json({
      success: true,
      furniture: config.SB_FURNITURE,
      power: config.SB_POWER,
      delivery: config.DELIVERY,
      referral: config.REFERRAL,
      announcement: {
        flash_deal_active: true,
        headline: '🔥 মেগা অফার: আজই প্রথম সফল অর্ডারে ৫০৳ ইনস্ট্যান্ট বোনাস! প্রতি সপ্তাহে বিকাশ ও নগদে দ্রুত ক্যাশআউট!',
        subtext: '🏆 চলতি মাসের শীর্ষ ৩ জন সফল রিসেলারের জন্য রয়েছে স্মার্টফোন, স্মার্টওয়াচ ও ক্যাশ প্রাইজ!'
      },
      announcements: []
    });
  }
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/leaderboard', leaderboardRoutes);

// Direct Admin Portal and Manifest shortcuts
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

// Direct APK Downloads & Static Distribution
const fs = require('fs');
app.use('/dist-apk', express.static(path.join(__dirname, '..', 'dist-apk')));
app.get('/download/reseller-apk', (req, res) => {
  const file = path.join(__dirname, '..', 'dist-apk', 'sb-power-reseller.apk');
  if (fs.existsSync(file)) {
    res.download(file, 'sb-power-reseller.apk');
  } else {
    res.status(404).send('APK ফাইলটি এখনও তৈরি করা হয়নি। অনুগ্রহ করে npm run build:apks চালান।');
  }
});
app.get('/download/admin-apk', (req, res) => {
  const file = path.join(__dirname, '..', 'dist-apk', 'sb-power-admin.apk');
  if (fs.existsSync(file)) {
    res.download(file, 'sb-power-admin.apk');
  } else {
    res.status(404).send('Admin APK ফাইলটি এখনও তৈরি করা হয়নি। অনুগ্রহ করে npm run build:apk:admin চালান।');
  }
});

// Static Client Files
app.use(express.static(path.join(__dirname, '..', 'public')));

// Fallback for Single Page PWA navigation (compatible with Express 5)
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ success: false, message: 'এপিআই রুটটি পাওয়া যায়নি' });
  }
  // Serve index.html for frontend routing if GET request
  if (req.method === 'GET') {
    return res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  }
  next();
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('Unhandled Application Error:', err);
  res.status(500).json({
    success: false,
    message: 'অভ্যন্তরীণ সার্ভার ত্রুটি ঘটেছে'
  });
});

// Start Server after DB initialization
if (require.main === module) {
  initDb()
    .then(() => {
      app.listen(config.PORT, () => {
        console.log(`===============================================`);
        console.log(`🚀 SB Furniture & SB POWER Server running on port ${config.PORT}`);
        console.log(`📡 URL: http://localhost:${config.PORT}`);
        console.log(`⚙️ Mode: ${config.NODE_ENV}`);
        console.log(`===============================================`);
      });
    })
    .catch((err) => {
      console.error('Failed to initialize database on startup:', err);
      process.exit(1);
    });
}

module.exports = app;
