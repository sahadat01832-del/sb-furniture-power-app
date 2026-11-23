const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const config = require('./config');

if (process.platform !== 'win32') {
  process.umask(0o077);
  for (const filePath of [config.DATABASE_FILE, `${config.DATABASE_FILE}-wal`, `${config.DATABASE_FILE}-shm`]) {
    if (!fs.existsSync(filePath)) continue;
    if (fs.statSync(filePath).isFile()) fs.chmodSync(filePath, 0o600);
  }
}

const dbDir = path.dirname(config.DATABASE_FILE);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true, mode: 0o700 });
}

const db = new sqlite3.Database(config.DATABASE_FILE, (err) => {
  if (err) {
    console.error('Could not connect to database', err);
  }
});

// Run with foreign keys and WAL mode for high concurrency
let txQueue = new Promise((resolve) => {
  db.serialize(() => {
    db.run('PRAGMA busy_timeout = 5000;');
    db.run('PRAGMA journal_mode = WAL;');
    db.run('PRAGMA synchronous = NORMAL;');
    db.run('PRAGMA foreign_keys = ON;', () => resolve());
  });
});

// Promise wrappers for parameterized queries
const query = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
};

const get = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
};

const run = (sql, params = []) => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
};

// Atomic Transaction Runner with Async Mutex to prevent overlapping transactions

const withTransaction = (callback) => {
  const executeTx = async () => {
    await run('BEGIN IMMEDIATE TRANSACTION');
    try {
      const result = await callback({ query, get, run });
      await run('COMMIT');
      return result;
    } catch (err) {
      try {
        await run('ROLLBACK');
      } catch (rbErr) {
        console.error('Transaction Rollback Error:', rbErr);
      }
      throw err;
    }
  };

  const nextTx = txQueue.then(executeTx, executeTx);
  txQueue = nextTx.catch(() => {});
  return nextTx;
};

// Database Schema Initialization
const initDb = async () => {
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'reseller',
      referral_code TEXT UNIQUE,
      referred_by_id INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      sku TEXT NOT NULL UNIQUE,
      brand TEXT NOT NULL,
      category TEXT NOT NULL,
      regular_price REAL NOT NULL,
      reseller_commission REAL NOT NULL DEFAULT 50,
      commission_tab TEXT NOT NULL DEFAULT '50tk',
      image_url TEXT NOT NULL,
      description TEXT,
      materials TEXT,
      finish TEXT,
      stock INTEGER NOT NULL DEFAULT 100,
      is_active INTEGER NOT NULL DEFAULT 1,
      shop_name TEXT DEFAULT 'SB Furniture',
      vendor_phone TEXT,
      vendor_badge TEXT,
      vendor_address TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number TEXT NOT NULL UNIQUE,
      reseller_id INTEGER REFERENCES users(id),
      customer_name TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      delivery_address TEXT NOT NULL,
      delivery_city TEXT NOT NULL,
      subtotal_amount REAL NOT NULL,
      delivery_fee REAL NOT NULL,
      total_amount REAL NOT NULL,
      advance_paid REAL NOT NULL DEFAULT 0,
      advance_trx_id TEXT,
      payment_method TEXT DEFAULT 'cod',
      status TEXT NOT NULL DEFAULT 'pending',
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id),
      title TEXT NOT NULL,
      sku TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      unit_price REAL NOT NULL,
      commission_per_unit REAL NOT NULL DEFAULT 0,
      selected_color TEXT,
      total_price REAL NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      order_id INTEGER REFERENCES orders(id),
      payout_id INTEGER REFERENCES payout_requests(id),
      amount REAL NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Migrate existing databases if payout_id column is missing
  const wtCols = await query('PRAGMA table_info(wallet_transactions)');
  if (!wtCols.some(col => col.name === 'payout_id')) {
    await run('ALTER TABLE wallet_transactions ADD COLUMN payout_id INTEGER REFERENCES payout_requests(id)');
  }

  // Migrate existing databases if multi-shop vendor columns are missing
  const prodCols = await query('PRAGMA table_info(products)');
  if (!prodCols.some(col => col.name === 'shop_name')) {
    await run("ALTER TABLE products ADD COLUMN shop_name TEXT DEFAULT 'SB Furniture'");
  }
  if (!prodCols.some(col => col.name === 'vendor_phone')) {
    await run("ALTER TABLE products ADD COLUMN vendor_phone TEXT");
  }
  if (!prodCols.some(col => col.name === 'vendor_badge')) {
    await run("ALTER TABLE products ADD COLUMN vendor_badge TEXT");
  }
  if (!prodCols.some(col => col.name === 'vendor_address')) {
    await run("ALTER TABLE products ADD COLUMN vendor_address TEXT");
  }
  await run("UPDATE products SET shop_name = brand WHERE (shop_name IS NULL OR shop_name = 'SB Furniture') AND brand = 'SB POWER'");

  await run(`
    CREATE TABLE IF NOT EXISTS payout_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      amount REAL NOT NULL,
      payment_method TEXT NOT NULL,
      account_number TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      admin_trx_id TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Order Status Audit Trail Logs
  await run(`
    CREATE TABLE IF NOT EXISTS order_status_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      previous_status TEXT,
      new_status TEXT NOT NULL,
      changed_by_user_id INTEGER REFERENCES users(id),
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Global Announcements & Flash Deals
  await run(`
    CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      type TEXT DEFAULT 'flash_deal',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Replace only the exact legacy default copy that promised unapproved bonuses.
  await run(
    `UPDATE announcements
     SET title = ?, message = ?
     WHERE type = 'flash_deal' AND title = ? AND message = ?`,
    [
      'পণ্য শেয়ার করুন; সফল বিক্রিতে পণ্যভিত্তিক কমিশন পান।',
      'প্রতিটি পণ্যের কমিশন ও ডেলিভারির নিয়ম অর্ডারের আগে দেখে নিন।',
      '🔥 মেগা অফার: আজই প্রথম সফল অর্ডারে ৫০৳ ইনস্ট্যান্ট বোনাস! প্রতি সপ্তাহে বিকাশ ও নগদে দ্রুত ক্যাশআউট!',
      '🏆 চলতি মাসের শীর্ষ ৩ জন সফল রিসেলারের জন্য রয়েছে স্মার্টফোন, স্মার্টওয়াচ ও ক্যাশ প্রাইজ!'
    ]
  );

  // User Notifications
  await run(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Seed initial announcement if none exists
  const annCount = await get('SELECT COUNT(*) as count FROM announcements');
  if (!annCount || annCount.count === 0) {
    await run(
      `INSERT INTO announcements (title, message, type, is_active) VALUES (?, ?, 'flash_deal', 1)`,
      [
        'পণ্য শেয়ার করুন; সফল বিক্রিতে পণ্যভিত্তিক কমিশন পান।',
        'প্রতিটি পণ্যের কমিশন ও ডেলিভারির নিয়ম অর্ডারের আগে দেখে নিন।'
      ]
    );
  }

  // Indexes for performance
  await run(`CREATE INDEX IF NOT EXISTS idx_products_tab ON products(commission_tab);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_products_shop ON products(shop_name);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_products_price ON products(regular_price);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_orders_reseller ON orders(reseller_id);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_orders_customer_phone ON orders(customer_phone);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_orders_number ON orders(order_number);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_order_status_logs_order ON order_status_logs(order_id);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_announcements_active ON announcements(is_active);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_wallet_user ON wallet_transactions(user_id);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_wallet_payout ON wallet_transactions(payout_id);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_payout_user ON payout_requests(user_id);`);
};

module.exports = {
  db,
  query,
  get,
  run,
  withTransaction,
  initDb
};
