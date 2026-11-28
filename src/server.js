const express = require('express');
const fs = require('fs');
const path = require('path');
const helmet = require('helmet');
const compression = require('compression');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const { get, query, closeDb } = require('./db');
const { seedData } = require('./seed');
const { performBackup, waitForActiveBackup } = require('./backup');
const { closeFirebaseBackup, getFirebaseBackupStatus } = require('./firebaseBackup');

const authRoutes = require('./routes/authRoutes');
const productRoutes = require('./routes/productRoutes');
const orderRoutes = require('./routes/orderRoutes');
const walletRoutes = require('./routes/walletRoutes');
const adminRoutes = require('./routes/adminRoutes');
const leaderboardRoutes = require('./routes/leaderboardRoutes');
const referralRoutes = require('./routes/referralRoutes');

const app = express();
const BACKUP_INTERVAL_MS = config.BACKUP_INTERVAL_MINUTES * 60 * 1000;
let scheduledBackupTimer = null;

function startScheduledBackups() {
  const cloudStatus = getFirebaseBackupStatus();
  if (!cloudStatus.configured) {
    console.warn(`⚠️ Encrypted cloud backup is OFF. Missing: ${cloudStatus.missing.join(', ')}. Only local backups will be kept.`);
  }
  console.log(`🗄️ Database backup schedule: every ${config.BACKUP_INTERVAL_MINUTES} minutes.`);

  const runBackup = () => {
    performBackup().catch((error) => {
      console.error('Scheduled database backup failed:', error.message);
    });
  };

  runBackup();
  scheduledBackupTimer = setInterval(runBackup, BACKUP_INTERVAL_MS);
  scheduledBackupTimer.unref();
}

if (config.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

// Security Middlewares
app.use(
  helmet({
    contentSecurityPolicy: false, // Allows inline scripts/styles for modern PWA frontend
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' }
  })
);
// The product catalog is ~130KB of JSON. Gzip keeps it near ~20KB, which matters
// a lot when the phone is publishing through a free tunnel.
app.use(compression());

const allowedCorsOrigins = new Set(config.CORS_ORIGINS);
// Trust only this project's own Hosting domains, never every *.web.app site.
// This keeps the live Firebase frontend working even if CORS_ORIGIN(S) is missing
// from the phone's .env, while lookalike Firebase projects stay rejected.
const projectHostingOrigins = new Set(
  config.FIREBASE_PROJECT_ID
    ? [
        `https://${config.FIREBASE_PROJECT_ID}.web.app`,
        `https://${config.FIREBASE_PROJECT_ID}.firebaseapp.com`
      ]
    : []
);
function isAllowedCorsOrigin(origin) {
  if (!origin || allowedCorsOrigins.has(origin) || projectHostingOrigins.has(origin)) return true;
  if (config.NODE_ENV !== 'production' && /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin)) return true;
  return false;
}
app.use(cors({
  origin(origin, callback) {
    callback(null, isAllowedCorsOrigin(origin));
  },
  credentials: true,
  optionsSuccessStatus: 204
}));
app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
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
  max: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'অনেকবার ভুল অর্ডার খোঁজা হয়েছে। ১৫ মিনিট পর আবার চেষ্টা করুন।' }
});
const orderLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: config.NODE_ENV === 'production' ? 20 : 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'অনেকগুলো অর্ডার রিকোয়েস্ট পাঠানো হয়েছে। কিছুক্ষণ পর আবার চেষ্টা করুন।' }
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.post('/api/orders', orderLimiter);
app.use('/api/orders/track', trackingLimiter);
app.use('/api/', limiter);

// Uptime & Health Check Endpoint (Commercial Readiness Rule)
app.get('/health', async (req, res) => {
  try {
    const database = await get('SELECT 1 AS ok');
    if (!database || database.ok !== 1) {
      return res.status(503).json({ status: 'unhealthy' });
    }

    res.json({
      status: 'ok',
      uptime: process.uptime(),
      memoryMB: Number((process.memoryUsage().rss / (1024 * 1024)).toFixed(1)),
      timestamp: new Date().toISOString(),
      checks: { database: 'healthy' }
    });
  } catch {
    res.status(503).json({ status: 'unhealthy' });
  }
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
app.use('/api/admin/referrals', referralRoutes.adminRouter);
app.use('/api/referrals', referralRoutes.userRouter);
app.use('/api/leaderboard', leaderboardRoutes);

// Direct Admin Portal and Manifest shortcuts
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

// Direct Photo Uploads & Static Media
const uploadsDir = path.join(__dirname, '..', 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
app.use('/uploads', express.static(uploadsDir, {
  maxAge: '365d',
  immutable: true,
  etag: true
}));

// Direct APK Downloads & Static Distribution
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
      const httpServer = app.listen(config.PORT, config.HOST, () => {
        if (config.NODE_ENV === 'production') startScheduledBackups();
        console.log(`===============================================`);
        console.log(`SB Furniture & SB POWER server listening on ${config.HOST}:${config.PORT}`);
        console.log(`⚙️ Mode: ${config.NODE_ENV}`);
        console.log(`===============================================`);
      });

      let shutdownPromise = null;
      const shutdown = (signal) => {
        if (shutdownPromise) return shutdownPromise;
        console.log(`Received ${signal}; stopping HTTP server and closing SQLite cleanly.`);
        if (scheduledBackupTimer) clearInterval(scheduledBackupTimer);
        shutdownPromise = new Promise((resolve) => {
          httpServer.close(async (error) => {
            try {
              await waitForActiveBackup();
              await closeDb();
              await closeFirebaseBackup();
              if (error) throw error;
              console.log('SQLite closed cleanly.');
            } catch (closeError) {
              console.error('Graceful shutdown failed:', closeError.message);
              process.exitCode = 1;
            }
            resolve();
          });
          if (typeof httpServer.closeIdleConnections === 'function') {
            httpServer.closeIdleConnections();
          }
        });
        return shutdownPromise;
      };

      process.once('SIGINT', () => { shutdown('SIGINT'); });
      process.once('SIGTERM', () => { shutdown('SIGTERM'); });
    })
    .catch((err) => {
      console.error('Failed to initialize database on startup:', err);
      process.exit(1);
    });
}

module.exports = app;
