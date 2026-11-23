const express = require('express');
const path = require('path');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const { get, query } = require('./db');
const { seedData } = require('./seed');
const { performBackup } = require('./backup');

const authRoutes = require('./routes/authRoutes');
const productRoutes = require('./routes/productRoutes');
const orderRoutes = require('./routes/orderRoutes');
const walletRoutes = require('./routes/walletRoutes');
const adminRoutes = require('./routes/adminRoutes');
const leaderboardRoutes = require('./routes/leaderboardRoutes');

const app = express();
const DAILY_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

function startDailyBackups() {
  const runBackup = () => {
    performBackup().catch((error) => {
      console.error('Scheduled database backup failed:', error.message);
    });
  };

  runBackup();
  const timer = setInterval(runBackup, DAILY_BACKUP_INTERVAL_MS);
  timer.unref();
}

if (config.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

// Security Middlewares
app.use(
  helmet({
    contentSecurityPolicy: false, // Allows inline scripts/styles for modern PWA frontend
    crossOriginEmbedderPolicy: false
  })
);
const allowedCorsOrigins = new Set(config.CORS_ORIGINS);
app.use(cors({
  origin(origin, callback) {
    callback(null, Boolean(origin && allowedCorsOrigins.has(origin)));
  },
  credentials: true,
  optionsSuccessStatus: 204
}));
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use((req, res, next) => {
  if (req.body === undefined) req.body = {};
  next();
});

// Rate Limiting (Protects public APIs against abuse)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'অনেক বেশি রিকোয়েস্ট পাঠানো হয়েছে, কিছুক্ষণ পর চেষ্টা করুন।' }
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'অনেকবার চেষ্টা করা হয়েছে। ১৫ মিনিট পর আবার চেষ্টা করুন।' }
});
const trackingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'অনেকবার অর্ডার খোঁজা হয়েছে। কিছুক্ষণ পর আবার চেষ্টা করুন।' }
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/orders/track', trackingLimiter);
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
    const latestAnnouncement = activeAnns.length > 0 ? activeAnns[0] : null;
    const activeAnn = latestAnnouncement && !(
      latestAnnouncement.title === '🔥 মেগা অফার: আজই প্রথম সফল অর্ডারে ৫০৳ ইনস্ট্যান্ট বোনাস! প্রতি সপ্তাহে বিকাশ ও নগদে দ্রুত ক্যাশআউট!' &&
      latestAnnouncement.message === '🏆 চলতি মাসের শীর্ষ ৩ জন সফল রিসেলারের জন্য রয়েছে স্মার্টফোন, স্মার্টওয়াচ ও ক্যাশ প্রাইজ!'
    ) ? latestAnnouncement : null;
    res.json({
      success: true,
      furniture: config.SB_FURNITURE,
      power: config.SB_POWER,
      delivery: config.DELIVERY,
      referral: config.REFERRAL,
      announcement: {
        flash_deal_active: activeAnn ? true : false,
        headline: activeAnn ? activeAnn.title : 'পণ্য শেয়ার করুন; সফল বিক্রিতে পণ্যভিত্তিক কমিশন পান।',
        subtext: activeAnn ? activeAnn.message : 'প্রতিটি পণ্যের কমিশন ও ডেলিভারির নিয়ম অর্ডারের আগে দেখে নিন।'
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
        headline: 'পণ্য শেয়ার করুন; সফল বিক্রিতে পণ্যভিত্তিক কমিশন পান।',
        subtext: 'প্রতিটি পণ্যের কমিশন ও ডেলিভারির নিয়ম অর্ডারের আগে দেখে নিন।'
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
  const status = err.status === 413 ? 413 : (err instanceof SyntaxError && err.status === 400 && Object.prototype.hasOwnProperty.call(err, 'body') ? 400 : 500);
  res.status(status).json({
    success: false,
    message: status === 413 ? 'অনুরোধের তথ্য অনেক বড়' : (status === 400 ? 'অনুরোধের তথ্য সঠিক JSON নয়' : 'অভ্যন্তরীণ সার্ভার ত্রুটি ঘটেছে')
  });
});

// Start Server after DB initialization
if (require.main === module) {
  seedData()
    .then(() => {
      app.listen(config.PORT, '0.0.0.0', () => {
        if (config.NODE_ENV === 'production') startDailyBackups();
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
