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
let closePromise = null;

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

function closeDb() {
  if (!closePromise) {
    closePromise = txQueue.catch(() => {}).then(() => new Promise((resolve, reject) => {
      db.close((error) => error ? reject(error) : resolve());
    }));
  }
  return closePromise;
}

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

// Money columns hold INTEGER paisa. Databases created before that change stored
// taka as REAL, so convert their values once, in place, on first startup.
const MONEY_COLUMNS = {
  products: ['regular_price', 'reseller_commission', 'wholesale_price'],
  orders: ['subtotal_amount', 'delivery_fee', 'total_amount', 'advance_paid', 'discount_amount', 'total_wholesale_amount', 'total_reseller_commission', 'referral_commission_amount', 'referral_credit_amount', 'platform_net_profit'],
  order_items: ['unit_price', 'commission_per_unit', 'total_price', 'unit_wholesale_price', 'unit_selling_price', 'unit_commission', 'platform_net_profit'],
  wallet_transactions: ['amount'],
  payout_requests: ['amount'],
  shop_settlements: ['amount']
};

const migrateMoneyToPaisa = async () => {
  const productColumns = await query('PRAGMA table_info(products)');
  if (productColumns.length === 0) return false;
  const priceColumn = productColumns.find((column) => column.name === 'regular_price');
  if (!priceColumn || String(priceColumn.type || '').toUpperCase().includes('INT')) return false;

  // Children first: rebuilding a parent table drops what foreign keys reference.
  const tables = ['order_items', 'wallet_transactions', 'payout_requests', 'orders', 'products'];
  await run('PRAGMA foreign_keys = OFF');
  await run('BEGIN IMMEDIATE TRANSACTION');
  try {
    for (const table of tables) {
      const schema = await get('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?', ['table', table]);
      if (!schema || !schema.sql) continue;

      // Reuse the live table definition so no column can be lost, switching the
      // declared type of the money columns to INTEGER on the copy.
      let ddl = schema.sql.trim();
      for (const column of MONEY_COLUMNS[table]) {
        ddl = ddl.replace(new RegExp(`(\\b${column}\\b)\\s+REAL\\b`, 'i'), '$1 INTEGER');
      }
      const temporaryTable = `${table}__paisa`;
      ddl = ddl.replace(
        /^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|\w+)/i,
        `CREATE TABLE ${temporaryTable}`
      );

      const columns = (await query(`PRAGMA table_info(${table})`)).map((column) => column.name);
      const selectList = columns
        .map((column) => (MONEY_COLUMNS[table].includes(column)
          ? `CASE WHEN ${column} IS NULL THEN NULL ELSE CAST(ROUND(${column} * 100) AS INTEGER) END`
          : column))
        .join(', ');

      await run(`DROP TABLE IF EXISTS ${temporaryTable}`);
      await run(ddl);
      await run(`INSERT INTO ${temporaryTable} (${columns.join(', ')}) SELECT ${selectList} FROM ${table}`);
      await run(`DROP TABLE ${table}`);
      await run(`ALTER TABLE ${temporaryTable} RENAME TO ${table}`);
    }
    await run('COMMIT');
  } catch (error) {
    try {
      await run('ROLLBACK');
    } catch (rollbackError) {
      console.error('Money migration rollback failed:', rollbackError.message);
    }
    throw error;
  } finally {
    await run('PRAGMA foreign_keys = ON');
  }

  console.log('Migrated money columns from REAL taka to INTEGER paisa.');
  return true;
};

// Database Schema Initialization
const initDb = async () => {
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'customer',
      referral_code TEXT UNIQUE,
      referred_by_id INTEGER REFERENCES users(id),
      token_version INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS referral_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      is_enabled INTEGER NOT NULL DEFAULT 0,
      customer_reward_bps INTEGER NOT NULL DEFAULT 0,
      reseller_commission_bps INTEGER NOT NULL DEFAULT 200,
      updated_by_admin_id INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await run(
    `INSERT OR IGNORE INTO referral_settings (id, is_enabled, customer_reward_bps, reseller_commission_bps)
     VALUES (1, 0, 0, 200)`
  );

  // Existing databases predate token_version; adding it revokes nothing yet.
  const userColumns = await query('PRAGMA table_info(users)');
  if (!userColumns.some((column) => column.name === 'token_version')) {
    await run('ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0');
  }
  if (!userColumns.some((column) => column.name === 'status')) {
    await run("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
  }
  if (!userColumns.some((column) => column.name === 'payout_method')) {
    await run('ALTER TABLE users ADD COLUMN payout_method TEXT');
  }
  if (!userColumns.some((column) => column.name === 'payout_number')) {
    await run('ALTER TABLE users ADD COLUMN payout_number TEXT');
  }

  // Shops table for Own Brand Shops (SB Furniture, SB POWER) and Partner Shops
  await run(`
    CREATE TABLE IF NOT EXISTS shops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      shop_type TEXT NOT NULL DEFAULT 'own',
      phone TEXT,
      address TEXT,
      contact_person TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Seed default Own Brand shops if they do not exist
  await run(
    `INSERT OR IGNORE INTO shops (name, shop_type, phone, address, contact_person)
     VALUES (?, 'own', ?, ?, ?)`,
    ['SB Furniture', '01929621855', 'বাঙাল হাওলা, কালীগঞ্জ, গাজীপুর', 'মোঃ সুমন সরকার']
  );
  await run(
    `INSERT OR IGNORE INTO shops (name, shop_type, phone, address, contact_person)
     VALUES (?, 'own', ?, ?, ?)`,
    ['SB POWER', '01634664224', 'কালীগঞ্জ, গাজীপুর', 'SB POWER সেলস টিম']
  );

  // Shop wholesale settlements table (Partner shop payouts)
  await run(`
    CREATE TABLE IF NOT EXISTS shop_settlements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_id INTEGER NOT NULL REFERENCES shops(id),
      amount INTEGER NOT NULL,
      orders_count INTEGER NOT NULL DEFAULT 0,
      trx_id TEXT,
      notes TEXT,
      settled_by_admin_id INTEGER REFERENCES users(id),
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
      regular_price INTEGER NOT NULL,
      reseller_commission INTEGER NOT NULL DEFAULT 5000,
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
      subtotal_amount INTEGER NOT NULL,
      delivery_fee INTEGER NOT NULL,
      total_amount INTEGER NOT NULL,
      advance_paid INTEGER NOT NULL DEFAULT 0,
      advance_trx_id TEXT,
      payment_method TEXT DEFAULT 'cod',
      status TEXT NOT NULL DEFAULT 'pending',
      notes TEXT,
      customer_user_id INTEGER REFERENCES users(id),
      referrer_user_id INTEGER REFERENCES users(id),
      discount_amount INTEGER NOT NULL DEFAULT 0,
      referral_commission_amount INTEGER NOT NULL DEFAULT 0,
      referral_credit_amount INTEGER NOT NULL DEFAULT 0,
      referral_reward_released INTEGER NOT NULL DEFAULT 0,
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
      unit_price INTEGER NOT NULL,
      commission_per_unit INTEGER NOT NULL DEFAULT 0,
      selected_color TEXT,
      total_price INTEGER NOT NULL
    )
  `);

  await run(`
    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      order_id INTEGER REFERENCES orders(id),
      payout_id INTEGER REFERENCES payout_requests(id),
      amount INTEGER NOT NULL,
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
  if (!prodCols.some(col => col.name === 'shop_id')) {
    await run("ALTER TABLE products ADD COLUMN shop_id INTEGER REFERENCES shops(id)");
  }
  if (!prodCols.some(col => col.name === 'shop_type')) {
    await run("ALTER TABLE products ADD COLUMN shop_type TEXT NOT NULL DEFAULT 'own'");
  }
  if (!prodCols.some(col => col.name === 'wholesale_price')) {
    await run("ALTER TABLE products ADD COLUMN wholesale_price INTEGER NOT NULL DEFAULT 0");
  }
  if (!prodCols.some(col => col.name === 'furniture_cutlist')) {
    await run("ALTER TABLE products ADD COLUMN furniture_cutlist TEXT");
  }
  if (!prodCols.some(col => col.name === 'caption')) {
    await run("ALTER TABLE products ADD COLUMN caption TEXT");
  }

  await run("UPDATE products SET shop_name = brand WHERE (shop_name IS NULL OR shop_name = 'SB Furniture') AND brand = 'SB POWER'");

  // Link shops and set shop_type
  await run(`
    UPDATE products
    SET shop_id = (SELECT id FROM shops WHERE name = 'SB Furniture'),
        shop_type = 'own'
    WHERE (shop_name = 'SB Furniture' OR shop_name IS NULL) AND shop_id IS NULL
  `);
  await run(`
    UPDATE products
    SET shop_id = (SELECT id FROM shops WHERE name = 'SB POWER'),
        shop_type = 'own'
    WHERE shop_name = 'SB POWER' AND shop_id IS NULL
  `);

  // Ensure any partner shop exists in shops table and link
  const partnerProds = await query("SELECT DISTINCT shop_name, vendor_phone, vendor_address FROM products WHERE shop_name NOT IN ('SB Furniture', 'SB POWER') AND shop_name IS NOT NULL");
  for (const p of partnerProds) {
    await run(
      `INSERT OR IGNORE INTO shops (name, shop_type, phone, address) VALUES (?, 'partner', ?, ?)`,
      [p.shop_name, p.vendor_phone || null, p.vendor_address || null]
    );
    await run(
      `UPDATE products
       SET shop_id = (SELECT id FROM shops WHERE name = ?),
           shop_type = 'partner'
       WHERE shop_name = ? AND shop_id IS NULL`,
      [p.shop_name, p.shop_name]
    );
  }

  // Backfill wholesale_price for existing items if 0 (regular_price - commission - 15% platform margin)
  await run(`
    UPDATE products
    SET wholesale_price = MAX(0, regular_price - reseller_commission - CAST(ROUND(regular_price * 0.15) AS INTEGER))
    WHERE wholesale_price = 0
  `);

  // Migrate orders table for 3-way profit & commission snapshots
  const orderCols = await query('PRAGMA table_info(orders)');
  if (!orderCols.some(col => col.name === 'customer_user_id')) {
    await run('ALTER TABLE orders ADD COLUMN customer_user_id INTEGER REFERENCES users(id)');
  }
  if (!orderCols.some(col => col.name === 'referrer_user_id')) {
    await run('ALTER TABLE orders ADD COLUMN referrer_user_id INTEGER REFERENCES users(id)');
  }
  if (!orderCols.some(col => col.name === 'discount_amount')) {
    await run('ALTER TABLE orders ADD COLUMN discount_amount INTEGER NOT NULL DEFAULT 0');
  }
  if (!orderCols.some(col => col.name === 'referral_commission_amount')) {
    await run('ALTER TABLE orders ADD COLUMN referral_commission_amount INTEGER NOT NULL DEFAULT 0');
  }
  if (!orderCols.some(col => col.name === 'referral_credit_amount')) {
    await run('ALTER TABLE orders ADD COLUMN referral_credit_amount INTEGER NOT NULL DEFAULT 0');
  }
  if (!orderCols.some(col => col.name === 'referral_reward_released')) {
    await run('ALTER TABLE orders ADD COLUMN referral_reward_released INTEGER NOT NULL DEFAULT 0');
  }
  await run(`
    UPDATE orders
    SET customer_user_id = (SELECT id FROM users WHERE users.phone = orders.customer_phone LIMIT 1)
    WHERE customer_user_id IS NULL
      AND EXISTS (SELECT 1 FROM users WHERE users.phone = orders.customer_phone)
  `);
  if (!orderCols.some(col => col.name === 'commission_released')) {
    await run("ALTER TABLE orders ADD COLUMN commission_released INTEGER NOT NULL DEFAULT 0");
  }
  if (!orderCols.some(col => col.name === 'partner_settled')) {
    await run("ALTER TABLE orders ADD COLUMN partner_settled INTEGER NOT NULL DEFAULT 0");
  }
  if (!orderCols.some(col => col.name === 'total_wholesale_amount')) {
    await run("ALTER TABLE orders ADD COLUMN total_wholesale_amount INTEGER NOT NULL DEFAULT 0");
  }
  if (!orderCols.some(col => col.name === 'total_reseller_commission')) {
    await run("ALTER TABLE orders ADD COLUMN total_reseller_commission INTEGER NOT NULL DEFAULT 0");
  }
  if (!orderCols.some(col => col.name === 'platform_net_profit')) {
    await run("ALTER TABLE orders ADD COLUMN platform_net_profit INTEGER NOT NULL DEFAULT 0");
  }

  // Mark historical delivered orders as commission_released
  await run("UPDATE orders SET commission_released = 1 WHERE status = 'delivered' AND commission_released = 0");

  // Migrate order_items table for item-level accounting snapshots
  const itemCols = await query('PRAGMA table_info(order_items)');
  if (!itemCols.some(col => col.name === 'unit_wholesale_price')) {
    await run("ALTER TABLE order_items ADD COLUMN unit_wholesale_price INTEGER NOT NULL DEFAULT 0");
  }
  if (!itemCols.some(col => col.name === 'unit_selling_price')) {
    await run("ALTER TABLE order_items ADD COLUMN unit_selling_price INTEGER NOT NULL DEFAULT 0");
  }
  if (!itemCols.some(col => col.name === 'unit_commission')) {
    await run("ALTER TABLE order_items ADD COLUMN unit_commission INTEGER NOT NULL DEFAULT 0");
  }
  if (!itemCols.some(col => col.name === 'platform_net_profit')) {
    await run("ALTER TABLE order_items ADD COLUMN platform_net_profit INTEGER NOT NULL DEFAULT 0");
  }
  if (!itemCols.some(col => col.name === 'shop_id')) {
    await run("ALTER TABLE order_items ADD COLUMN shop_id INTEGER REFERENCES shops(id)");
  }
  if (!itemCols.some(col => col.name === 'shop_name')) {
    await run("ALTER TABLE order_items ADD COLUMN shop_name TEXT");
  }
  if (!itemCols.some(col => col.name === 'shop_type')) {
    await run("ALTER TABLE order_items ADD COLUMN shop_type TEXT DEFAULT 'own'");
  }

  // Backfill unit_selling_price and unit_commission from historical fields
  await run("UPDATE order_items SET unit_selling_price = unit_price WHERE unit_selling_price = 0");
  await run("UPDATE order_items SET unit_commission = commission_per_unit WHERE unit_commission = 0");

  await run(`
    CREATE TABLE IF NOT EXISTS payout_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      amount INTEGER NOT NULL,
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

  await migrateMoneyToPaisa();

  // Indexes for performance
  await run(`CREATE INDEX IF NOT EXISTS idx_products_tab ON products(commission_tab);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_products_shop ON products(shop_name);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_products_shop_id ON products(shop_id);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_products_shop_type ON products(shop_type);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_products_price ON products(regular_price);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_orders_reseller ON orders(reseller_id);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_orders_customer_user ON orders(customer_user_id);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_orders_referrer_user ON orders(referrer_user_id);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_users_referred_by_id ON users(referred_by_id);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_wallet_user_type_status ON wallet_transactions(user_id, type, status);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_orders_customer_phone ON orders(customer_phone);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_orders_number ON orders(order_number);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_orders_commission_released ON orders(commission_released);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_orders_partner_settled ON orders(partner_settled);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_order_items_shop_id ON order_items(shop_id);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_order_status_logs_order ON order_status_logs(order_id);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_announcements_active ON announcements(is_active);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_wallet_user ON wallet_transactions(user_id);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_wallet_payout ON wallet_transactions(payout_id);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_payout_user ON payout_requests(user_id);`);
  await run(`CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);`);
};

module.exports = {
  db,
  query,
  get,
  run,
  withTransaction,
  initDb,
  closeDb
};
