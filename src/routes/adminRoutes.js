const express = require('express');
const router = express.Router();
const { query, get, run, withTransaction } = require('../db');
const { verifyToken, requireRole } = require('../auth');
const config = require('../config');

const PRODUCT_DEFAULT_IMAGE = 'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?auto=format&fit=crop&w=800&q=80';
const PRODUCT_BRANDS = new Set(['SB Furniture', 'SB POWER']);
const COMMISSION_TABS = new Set(['50tk', '100tk', '500tk', '1000tk']);

function validateProductPayload(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'প্রোডাক্টের তথ্য সঠিকভাবে পাঠান' };
  }

  const data = {};
  const textFields = {
    title: { required: true, max: 200 },
    sku: { required: true, max: 40 },
    brand: { required: true, max: 40 },
    category: { required: true, max: 100 },
    shop_name: { max: 100 },
    vendor_badge: { max: 100 },
    vendor_address: { max: 300 },
    description: { max: 5000 },
    materials: { max: 300 },
    finish: { max: 200 }
  };

  for (const [field, rules] of Object.entries(textFields)) {
    const value = input[field];
    if (value === undefined) {
      if (rules.required) return { error: 'প্রয়োজনীয় প্রোডাক্ট তথ্য পূরণ করুন' };
      continue;
    }
    if (value === null && !rules.required) {
      data[field] = '';
      continue;
    }
    if (typeof value !== 'string') return { error: 'প্রোডাক্টের লেখার তথ্য সঠিক নয়' };
    const clean = value.trim();
    if ((rules.required && !clean) || clean.length > rules.max) {
      return { error: 'প্রোডাক্টের লেখা খালি রাখা যাবে না এবং নির্ধারিত সীমার মধ্যে দিন' };
    }
    data[field] = clean;
  }

  if (!/^[A-Z0-9][A-Z0-9_-]{1,39}$/.test(data.sku || '')) {
    return { error: 'SKU-তে ২ থেকে ৪০টি ইংরেজি অক্ষর, সংখ্যা, হাইফেন বা আন্ডারস্কোর দিন' };
  }
  if (!PRODUCT_BRANDS.has(data.brand)) return { error: 'প্রোডাক্টের ব্র্যান্ড নির্বাচন সঠিক নয়' };

  for (const [field, options] of Object.entries({
    regular_price: { required: true, min: 1, max: 50000000 },
    reseller_commission: { required: true, min: 0, max: 50000000 },
    stock: { required: true, min: 0, max: 1000000 },
    is_active: { required: true, min: 0, max: 1 }
  })) {
    const value = input[field];
    if (value === undefined) {
      if (options.required) {
        if (field === 'reseller_commission') data[field] = 50;
        else if (field === 'stock') data[field] = 50;
        else if (field === 'is_active') data[field] = 1;
        else return { error: 'বিক্রয় মূল্য সঠিকভাবে দিন' };
      }
      continue;
    }
    if (value === '' || value === null || !Number.isSafeInteger(Number(value))) {
      return { error: 'মূল্য, কমিশন, স্টক ও সক্রিয়তার তথ্য পূর্ণসংখ্যায় দিন' };
    }
    const number = Number(value);
    if (number < options.min || number > options.max) return { error: 'মূল্য, কমিশন, স্টক বা সক্রিয়তার মান সীমার বাইরে' };
    data[field] = number;
  }
  if (data.reseller_commission > data.regular_price) return { error: 'কমিশন বিক্রয় মূল্যের চেয়ে বেশি হতে পারবে না' };

  if (input.commission_tab !== undefined) {
    if (typeof input.commission_tab !== 'string' || !COMMISSION_TABS.has(input.commission_tab)) {
      return { error: 'কমিশন ট্যাব থেকে একটি সঠিক মান নির্বাচন করুন' };
    }
    data.commission_tab = input.commission_tab;
  } else {
    data.commission_tab = `${data.reseller_commission}tk`;
    if (!COMMISSION_TABS.has(data.commission_tab)) data.commission_tab = '50tk';
  }

  if (input.image_url !== undefined && typeof input.image_url !== 'string') {
    return { error: 'ছবির ঠিকানা সঠিক নয়' };
  }
  const imageUrl = typeof input.image_url === 'string' ? input.image_url.trim() : '';
  if (imageUrl.length > 2048) return { error: 'ছবির ঠিকানা অনেক বড়' };
  if (!imageUrl) {
    data.image_url = PRODUCT_DEFAULT_IMAGE;
  } else if (imageUrl.startsWith('/') && !imageUrl.startsWith('//')) {
    data.image_url = imageUrl;
  } else {
    try {
      const parsed = new URL(imageUrl);
      if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) {
        return { error: 'ছবির জন্য HTTPS ঠিকানা দিন' };
      }
      data.image_url = parsed.href;
    } catch (error) {
      return { error: 'ছবির ঠিকানা সঠিক HTTPS URL হতে হবে' };
    }
  }

  if (input.vendor_phone !== undefined && input.vendor_phone !== null && typeof input.vendor_phone !== 'string') {
    return { error: 'ভেন্ডরের ফোন নম্বর সঠিক নয়' };
  }
  let vendorPhone = typeof input.vendor_phone === 'string' ? input.vendor_phone.replace(/\D/g, '') : '';
  if (vendorPhone.startsWith('00880')) vendorPhone = `0${vendorPhone.slice(5)}`;
  else if (vendorPhone.startsWith('880')) vendorPhone = `0${vendorPhone.slice(3)}`;
  if (vendorPhone && !/^01[3-9]\d{8}$/.test(vendorPhone)) return { error: 'ভেন্ডরের ১১ সংখ্যার বাংলাদেশি মোবাইল নম্বর দিন' };
  data.vendor_phone = vendorPhone || null;

  data.shop_name = data.shop_name || data.brand;
  data.vendor_badge = data.vendor_badge || null;
  data.vendor_address = data.vendor_address || null;
  data.description = data.description || '';
  data.materials = data.materials || '';
  data.finish = data.finish || '';
  return { data };
}

function validateAnnouncementPayload(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'ঘোষণার তথ্য সঠিকভাবে পাঠান' };
  const title = input.title;
  const message = input.message;
  const type = input.type === undefined ? 'flash_deal' : input.type;
  const active = input.is_active === undefined ? 1 : Number(input.is_active);
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 120) return { error: 'শিরোনাম ১২০ অক্ষরের মধ্যে দিন' };
  if (typeof message !== 'string' || !message.trim() || message.trim().length > 2000) return { error: 'বার্তা ২০০০ অক্ষরের মধ্যে দিন' };
  if (typeof type !== 'string' || !['flash_deal', 'general'].includes(type)) return { error: 'ঘোষণার ধরন সঠিক নয়' };
  if (![0, 1].includes(active) || (typeof input.is_active === 'string' && !/^[01]$/.test(input.is_active))) {
    return { error: 'ঘোষণার সক্রিয়তার মান ০ অথবা ১ দিন' };
  }
  return { data: { title: title.trim(), message: message.trim(), type, is_active: active } };
}

// Require Admin Role for all routes in this router
router.use(verifyToken, requireRole('admin'));

// Admin User Management Sub-routes
const adminUserRoutes = require('./adminUserRoutes');
router.use('/', adminUserRoutes);

// Admin Dashboard Stats
router.get('/stats', async (req, res) => {
  try {
    const totalOrdersRow = await get('SELECT COUNT(*) as count, COALESCE(SUM(total_amount), 0) as revenue FROM orders');
    const pendingOrdersRow = await get("SELECT COUNT(*) as count FROM orders WHERE status = 'pending'");
    const deliveredOrdersRow = await get("SELECT COUNT(*) as count FROM orders WHERE status = 'delivered'");
    const totalProductsRow = await get('SELECT COUNT(*) as count FROM products');
    const totalResellersRow = await get("SELECT COUNT(*) as count FROM users WHERE role = 'reseller'");
    const pendingPayoutsRow = await get("SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total FROM payout_requests WHERE status = 'pending'");

    return res.json({
      success: true,
      stats: {
        total_orders: totalOrdersRow.count,
        total_revenue: totalOrdersRow.revenue,
        pending_orders: pendingOrdersRow.count,
        delivered_orders: deliveredOrdersRow.count,
        total_products: totalProductsRow.count,
        total_resellers: totalResellersRow.count,
        pending_payouts_count: pendingPayoutsRow.count,
        pending_payouts_amount: pendingPayoutsRow.total
      }
    });
  } catch (error) {
    console.error('Admin Stats Error:', error);
    return res.status(500).json({ success: false, message: 'পরিসংখ্যান লোড করতে ব্যর্থ হয়েছে' });
  }
});

// Admin Analytics Endpoint (Detailed Revenue, Top Products, Top Resellers)
router.get('/analytics', async (req, res) => {
  try {
    const totalOrdersRow = await get('SELECT COUNT(*) as count, COALESCE(SUM(total_amount), 0) as revenue FROM orders');
    
    // Status counts
    const statusCounts = await query(`
      SELECT status, COUNT(*) as count, COALESCE(SUM(total_amount), 0) as volume 
      FROM orders 
      GROUP BY status
    `);

    // Top selling products
    const topProducts = await query(`
      SELECT 
        oi.product_id,
        oi.title,
        oi.sku,
        SUM(oi.quantity) as total_units_sold,
        SUM(oi.total_price) as total_sales_volume
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      WHERE o.status != 'cancelled'
      GROUP BY oi.product_id
      ORDER BY total_units_sold DESC
      LIMIT 5
    `);

    // Top performing resellers
    const topResellers = await query(`
      SELECT 
        u.id,
        u.name,
        u.phone,
        COUNT(DISTINCT o.id) as delivered_sales_count,
        COALESCE(SUM(o.total_amount), 0) as total_volume,
        (
          SELECT COALESCE(SUM(amount), 0) 
          FROM wallet_transactions 
          WHERE user_id = u.id AND status = 'available' AND type = 'commission'
        ) as total_commission_earned
      FROM users u
      JOIN orders o ON u.id = o.reseller_id AND o.status = 'delivered'
      GROUP BY u.id
      ORDER BY delivered_sales_count DESC, total_volume DESC
      LIMIT 5
    `);

    const pendingPayoutsRow = await get("SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total FROM payout_requests WHERE status = 'pending'");

    return res.json({
      success: true,
      analytics: {
        total_orders: totalOrdersRow.count,
        total_revenue: totalOrdersRow.revenue,
        status_breakdown: statusCounts,
        top_products: topProducts,
        top_resellers: topResellers,
        pending_payouts_count: pendingPayoutsRow.count,
        pending_payouts_amount: pendingPayoutsRow.total
      }
    });
  } catch (error) {
    console.error('Admin Analytics Error:', error);
    return res.status(500).json({ success: false, message: 'এনালিটিক্স লোড করতে ব্যর্থ হয়েছে' });
  }
});

// Admin Orders List
router.get('/orders', async (req, res) => {
  try {
    const { status } = req.query;
    let sql = `
      SELECT o.*, u.name as reseller_name, u.phone as reseller_phone
      FROM orders o
      LEFT JOIN users u ON o.reseller_id = u.id
    `;
    const params = [];

    if (status && status !== 'all') {
      sql += ' WHERE o.status = ?';
      params.push(status);
    }

    sql += ' ORDER BY o.id DESC LIMIT 100';

    const orders = await query(sql, params);

    // Fetch items for each order
    const enrichedOrders = await Promise.all(
      orders.map(async (order) => {
        const items = await query('SELECT * FROM order_items WHERE order_id = ?', [order.id]);
        return {
          ...order,
          items
        };
      })
    );

    return res.json({
      success: true,
      count: enrichedOrders.length,
      orders: enrichedOrders
    });
  } catch (error) {
    console.error('Admin Orders Error:', error);
    return res.status(500).json({ success: false, message: 'অর্ডার তালিকা লোড করতে ব্যর্থ হয়েছে' });
  }
});

// Update Order Status (Pending -> Confirmed -> Shipped -> Delivered -> Cancelled) with complete audit trail
router.put('/orders/:id/status', async (req, res) => {
  try {
    const orderId = parseInt(req.params.id, 10);
    const { status, notes } = req.body;

    const validStatuses = ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: 'অবৈধ অর্ডার স্ট্যাটাস' });
    }

    const order = await get('SELECT * FROM orders WHERE id = ?', [orderId]);
    if (!order) {
      return res.status(404).json({ success: false, message: 'অর্ডারটি পাওয়া যায়নি' });
    }

    const previousStatus = order.status;

    await withTransaction(async ({ run: txRun, get: txGet }) => {
      // 1. Update status in orders table
      await txRun(
        'UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [status, orderId]
      );

      // 2. Record in order_status_logs audit trail
      const adminUserId = req.user ? req.user.id : null;
      const logNote = notes ? notes.trim() : `স্ট্যাটাস পরিবর্তন: ${previousStatus} -> ${status}`;
      await txRun(
        `INSERT INTO order_status_logs (
          order_id, previous_status, new_status, changed_by_user_id, notes
        ) VALUES (?, ?, ?, ?, ?)`,
        [orderId, previousStatus, status, adminUserId, logNote]
      );

      // 3. Status-based wallet transaction management
      if (status === 'delivered' && previousStatus !== 'delivered') {
        // Mark reseller's pending commission transaction as 'available'
        if (order.reseller_id) {
          await txRun(
            `UPDATE wallet_transactions 
             SET status = 'available' 
             WHERE order_id = ? AND user_id = ? AND type = 'commission'`,
            [orderId, order.reseller_id]
          );

        }
      } else if (status === 'cancelled' && previousStatus !== 'cancelled') {
        // If cancelled, cancel all wallet transactions associated with this order
        await txRun(
          `UPDATE wallet_transactions 
           SET status = 'cancelled' 
           WHERE order_id = ?`,
          [orderId]
        );
      } else if (previousStatus === 'delivered' && status !== 'delivered') {
        // Reverting away from delivered: put commissions/bonuses back to pending
        await txRun(
          `UPDATE wallet_transactions 
           SET status = 'pending' 
           WHERE order_id = ?`,
          [orderId]
        );
      }

      // 4. Send notification to reseller if order is attributed
      if (order.reseller_id) {
        await txRun(
          `INSERT INTO notifications (user_id, title, message)
           VALUES (?, ?, ?)`,
          [
            order.reseller_id,
            `অর্ডার #${order.order_number} আপডেট`,
            `আপনার রেফার করা অর্ডারের স্ট্যাটাস পরিবর্তন হয়ে '${status}' হয়েছে।`
          ]
        );
      }
    });

    return res.json({
      success: true,
      message: `অর্ডারের স্ট্যাটাস পরিবর্তন করে '${status}' করা হয়েছে!`
    });
  } catch (error) {
    console.error('Order Status Update Error:', error);
    return res.status(500).json({ success: false, message: 'স্ট্যাটাস আপডেট ব্যর্থ হয়েছে' });
  }
});

// Get Order Status Audit Trail
router.get('/orders/:id/audit-trail', async (req, res) => {
  try {
    const orderId = parseInt(req.params.id, 10);
    const logs = await query(
      `SELECT osl.*, u.name as admin_name 
       FROM order_status_logs osl 
       LEFT JOIN users u ON osl.changed_by_user_id = u.id 
       WHERE osl.order_id = ? 
       ORDER BY osl.id ASC`,
      [orderId]
    );

    return res.json({
      success: true,
      order_id: orderId,
      audit_trail: logs
    });
  } catch (error) {
    console.error('Audit Trail Error:', error);
    return res.status(500).json({ success: false, message: 'অডিট ট্রেইল লোড করতে ব্যর্থ হয়েছে' });
  }
});

// Admin Payouts List
router.get('/payouts', async (req, res) => {
  try {
    const payouts = await query(
      `SELECT p.*, u.name as user_name, u.phone as user_phone
       FROM payout_requests p
       JOIN users u ON p.user_id = u.id
       ORDER BY p.id DESC`
    );

    return res.json({
      success: true,
      payouts
    });
  } catch (error) {
    console.error('Admin Payouts Error:', error);
    return res.status(500).json({ success: false, message: 'ক্যাশআউট রিকোয়েস্ট লোড ব্যর্থ হয়েছে' });
  }
});

// Update Payout Status (Approve / Reject)
router.put('/payouts/:id', async (req, res) => {
  try {
    const payoutId = Number(req.params.id);
    const { status, admin_trx_id, notes } = req.body;

    if (!Number.isSafeInteger(payoutId) || payoutId < 1) {
      return res.status(400).json({ success: false, message: 'ক্যাশআউট আইডি সঠিক নয়' });
    }
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, message: 'অবৈধ পেআউট স্ট্যাটাস (approved বা rejected হতে হবে)' });
    }
    if (admin_trx_id !== undefined && admin_trx_id !== null && (typeof admin_trx_id !== 'string' || admin_trx_id.trim().length > 80)) {
      return res.status(400).json({ success: false, message: 'TrxID ৮০ অক্ষরের মধ্যে দিন' });
    }
    if (status === 'approved' && (!admin_trx_id || admin_trx_id.trim().length < 4)) {
      return res.status(400).json({ success: false, message: 'পেআউট অনুমোদনের আগে পাঠানো টাকার TrxID দিন' });
    }
    if (notes !== undefined && notes !== null && (typeof notes !== 'string' || notes.length > 500)) {
      return res.status(400).json({ success: false, message: 'নোট ৫০০ অক্ষরের মধ্যে দিন' });
    }

    const payout = await get('SELECT * FROM payout_requests WHERE id = ?', [payoutId]);
    if (!payout) {
      return res.status(404).json({ success: false, message: 'ক্যাশআউট রিকোয়েস্ট পাওয়া যায়নি' });
    }

    await withTransaction(async ({ get: txGet, run: txRun }) => {
      const currentPayout = await txGet('SELECT * FROM payout_requests WHERE id = ?', [payoutId]);
      if (!currentPayout) {
        const notFoundError = new Error('ক্যাশআউট রিকোয়েস্ট পাওয়া যায়নি');
        notFoundError.statusCode = 404;
        throw notFoundError;
      }
      if (currentPayout.status !== 'pending') {
        const conflictError = new Error('এই ক্যাশআউট রিকোয়েস্ট আগে থেকেই প্রক্রিয়া করা হয়েছে');
        conflictError.statusCode = 409;
        throw conflictError;
      }

      const updateResult = await txRun(
        `UPDATE payout_requests 
         SET status = ?, admin_trx_id = ?, notes = ?, updated_at = CURRENT_TIMESTAMP 
         WHERE id = ? AND status = 'pending'`,
        [status, admin_trx_id ? admin_trx_id.trim() : null, notes ? notes.trim() : null, payoutId]
      );
      if (updateResult.changes !== 1) {
        const conflictError = new Error('এই ক্যাশআউট রিকোয়েস্ট আগে থেকেই প্রক্রিয়া করা হয়েছে');
        conflictError.statusCode = 409;
        throw conflictError;
      }

      // Update corresponding wallet_transactions record accurately using payout_id
      const targetStatus = status === 'approved' ? 'completed' : 'cancelled';
      const suffixNote = admin_trx_id ? ` (TrxID: ${admin_trx_id})` : ` (${status === 'approved' ? 'অনুমোদিত' : 'বাতিল'})`;
      await txRun(
        `UPDATE wallet_transactions 
         SET status = ?, notes = COALESCE(notes, '') || ? 
         WHERE payout_id = ? OR (user_id = ? AND type = 'payout' AND status = 'pending' AND amount = ? AND payout_id IS NULL)`,
        [
          targetStatus,
          suffixNote,
          payoutId,
          currentPayout.user_id,
          currentPayout.amount
        ]
      );

      // Notify reseller about payout approval or rejection
      const notifTitle = status === 'approved' ? 'ক্যাশআউট অনুমোদন সম্পন্ন!' : 'ক্যাশআউট রিকোয়েস্ট বাতিল';
      const notifMsg = status === 'approved'
        ? `আপনার ${currentPayout.amount}৳ ক্যাশআউট (${currentPayout.payment_method.toUpperCase()}: ${currentPayout.account_number}) সফল হয়েছে। TrxID: ${admin_trx_id.trim()}`
        : `আপনার ${currentPayout.amount}৳ ক্যাশআউট রিকোয়েস্ট বাতিল করা হয়েছে। কারণ: ${notes || 'অ্যাকাউন্ট তথ্যে অসঙ্গতি'}`;

      await txRun(
        `INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)`,
        [currentPayout.user_id, notifTitle, notifMsg]
      );
    });

    return res.json({
      success: true,
      message: status === 'approved' ? 'ক্যাশআউট অনুমোদন সম্পন্ন হয়েছে!' : 'ক্যাশআউট বাতিল করা হয়েছে'
    });
  } catch (error) {
    if (error.statusCode === 404 || error.statusCode === 409) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    console.error('Update Payout Error:', error);
    return res.status(500).json({ success: false, message: 'ক্যাশআউট আপডেট ব্যর্থ হয়েছে' });
  }
});

// Admin Product Listing (all products, including inactive products, with search and filters)
router.get('/products', async (req, res) => {
  try {
    const { status, category, brand, shop, search } = req.query;
    let whereSql = ' WHERE 1=1';
    const params = [];

    if (status === 'active') {
      whereSql += ' AND is_active = 1';
    } else if (status === 'inactive') {
      whereSql += ' AND is_active = 0';
    }

    if (category && category !== 'all') {
      whereSql += ' AND category = ?';
      params.push(category);
    }

    if (brand && brand !== 'all') {
      whereSql += ' AND brand = ?';
      params.push(brand);
    }

    if (shop && shop !== 'all') {
      if (shop.toLowerCase() === 'partner') {
        whereSql += " AND shop_name NOT IN ('SB Furniture', 'SB POWER') AND shop_name IS NOT NULL";
      } else {
        whereSql += ' AND (shop_name = ? OR brand = ?)';
        params.push(shop, shop);
      }
    }

    if (search && search.trim()) {
      whereSql += ' AND (title LIKE ? OR sku LIKE ? OR description LIKE ? OR shop_name LIKE ?)';
      const term = `%${search.trim()}%`;
      params.push(term, term, term, term);
    }

    const products = await query(`SELECT * FROM products ${whereSql} ORDER BY id DESC`, params);

    return res.json({
      success: true,
      count: products.length,
      products
    });
  } catch (error) {
    console.error('Admin Products Fetch Error:', error);
    return res.status(500).json({ success: false, message: 'প্রোডাক্ট তালিকা লোড ব্যর্থ হয়েছে' });
  }
});

// Product Management: Create Product
router.post('/products', async (req, res) => {
  try {
    const validation = validateProductPayload(req.body);
    if (validation.error) return res.status(400).json({ success: false, message: validation.error });
    const product = validation.data;

    // Check SKU duplicate
    const existing = await get('SELECT id FROM products WHERE sku = ?', [product.sku]);
    if (existing) {
      return res.status(400).json({ success: false, message: 'এই SKU কোডটি ইতিমধ্যে ব্যবহৃত হচ্ছে' });
    }

    const result = await run(
      `INSERT INTO products (
        title, sku, brand, category, regular_price, reseller_commission, commission_tab,
        image_url, description, materials, finish, stock, is_active,
        shop_name, vendor_phone, vendor_badge, vendor_address
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      [
        product.title,
        product.sku,
        product.brand,
        product.category,
        product.regular_price,
        product.reseller_commission,
        product.commission_tab,
        product.image_url,
        product.description,
        product.materials,
        product.finish,
        product.stock,
        product.shop_name,
        product.vendor_phone,
        product.vendor_badge,
        product.vendor_address
      ]
    );

    return res.status(201).json({
      success: true,
      message: 'নতুন প্রোডাক্ট সফলভাবে যুক্ত করা হয়েছে!',
      product_id: result.lastID
    });
  } catch (error) {
    console.error('Create Product Error:', error);
    return res.status(500).json({ success: false, message: 'প্রোডাক্ট যুক্ত করতে ব্যর্থ হয়েছে' });
  }
});

// Product Management: Update Product
router.put('/products/:id', async (req, res) => {
  try {
    const productId = Number(req.params.id);
    if (!Number.isSafeInteger(productId) || productId < 1) {
      return res.status(400).json({ success: false, message: 'প্রোডাক্ট আইডি সঠিক নয়' });
    }

    const product = await get('SELECT * FROM products WHERE id = ?', [productId]);
    if (!product) {
      return res.status(404).json({ success: false, message: 'প্রোডাক্ট পাওয়া যায়নি' });
    }

    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ success: false, message: 'প্রোডাক্টের তথ্য সঠিকভাবে পাঠান' });
    }
    const validation = validateProductPayload({ ...product, ...req.body });
    if (validation.error) return res.status(400).json({ success: false, message: validation.error });
    const updated = validation.data;

    const duplicateSku = await get('SELECT id FROM products WHERE sku = ? AND id != ?', [updated.sku, productId]);
    if (duplicateSku) {
      return res.status(400).json({ success: false, message: 'এই SKU কোডটি অন্য একটি পণ্যে ব্যবহৃত হচ্ছে' });
    }

    await run(
      `UPDATE products SET
        title = ?,
        sku = ?,
        brand = ?,
        category = ?,
        regular_price = ?,
        reseller_commission = ?,
        commission_tab = ?,
        image_url = ?,
        description = ?,
        materials = ?,
        finish = ?,
        stock = ?,
        is_active = ?,
        shop_name = ?,
        vendor_phone = ?,
        vendor_badge = ?,
        vendor_address = ?,
        updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        updated.title,
        updated.sku,
        updated.brand,
        updated.category,
        updated.regular_price,
        updated.reseller_commission,
        updated.commission_tab,
        updated.image_url,
        updated.description,
        updated.materials,
        updated.finish,
        updated.stock,
        updated.is_active,
        updated.shop_name,
        updated.vendor_phone,
        updated.vendor_badge,
        updated.vendor_address,
        productId
      ]
    );

    return res.json({
      success: true,
      message: 'প্রোডাক্ট তথ্য সফলভাবে আপডেট হয়েছে!'
    });
  } catch (error) {
    console.error('Update Product Error:', error);
    return res.status(500).json({ success: false, message: 'প্রোডাক্ট আপডেট ব্যর্থ হয়েছে' });
  }
});

// Product Management: Delete Product
router.delete('/products/:id', async (req, res) => {
  try {
    const productId = parseInt(req.params.id, 10);
    await run('UPDATE products SET is_active = 0 WHERE id = ?', [productId]);
    return res.json({ success: true, message: 'প্রোডাক্ট নিষ্ক্রিয় করা হয়েছে' });
  } catch (error) {
    console.error('Delete Product Error:', error);
    return res.status(500).json({ success: false, message: 'প্রোডাক্ট নিষ্ক্রিয় করতে ব্যর্থ হয়েছে' });
  }
});

// ================= ANNOUNCEMENTS MANAGEMENT =================
// List all announcements
router.get('/announcements', async (req, res) => {
  try {
    const announcements = await query('SELECT * FROM announcements ORDER BY id DESC');
    return res.json({ success: true, announcements });
  } catch (error) {
    console.error('Fetch Announcements Error:', error);
    return res.status(500).json({ success: false, message: 'ঘোষণা লোড করতে ব্যর্থ হয়েছে' });
  }
});

// Create announcement
router.post('/announcements', async (req, res) => {
  try {
    const validation = validateAnnouncementPayload(req.body);
    if (validation.error) return res.status(400).json({ success: false, message: validation.error });
    const announcement = validation.data;

    const result = await run(
      'INSERT INTO announcements (title, message, type, is_active) VALUES (?, ?, ?, ?)',
      [announcement.title, announcement.message, announcement.type, announcement.is_active]
    );

    return res.status(201).json({
      success: true,
      message: 'ঘোষণা সফলভাবে যোগ করা হয়েছে!',
      id: result.lastID
    });
  } catch (error) {
    console.error('Create Announcement Error:', error);
    return res.status(500).json({ success: false, message: 'ঘোষণা তৈরিতে ব্যর্থ হয়েছে' });
  }
});

// Update announcement
router.put('/announcements/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ success: false, message: 'ঘোষণার আইডি সঠিক নয়' });

    const ann = await get('SELECT * FROM announcements WHERE id = ?', [id]);
    if (!ann) {
      return res.status(404).json({ success: false, message: 'ঘোষণাটি পাওয়া যায়নি' });
    }

    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ success: false, message: 'ঘোষণার তথ্য সঠিকভাবে পাঠান' });
    }
    const validation = validateAnnouncementPayload({ ...ann, ...req.body });
    if (validation.error) return res.status(400).json({ success: false, message: validation.error });
    const announcement = validation.data;

    await run(
      'UPDATE announcements SET title = ?, message = ?, type = ?, is_active = ? WHERE id = ?',
      [
        announcement.title,
        announcement.message,
        announcement.type,
        announcement.is_active,
        id
      ]
    );

    return res.json({ success: true, message: 'ঘোষণা সফলভাবে আপডেট হয়েছে!' });
  } catch (error) {
    console.error('Update Announcement Error:', error);
    return res.status(500).json({ success: false, message: 'ঘোষণা আপডেট ব্যর্থ হয়েছে' });
  }
});

// Delete announcement
router.delete('/announcements/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await run('DELETE FROM announcements WHERE id = ?', [id]);
    return res.json({ success: true, message: 'ঘোষণা সফলভাবে মুছে ফেলা হয়েছে' });
  } catch (error) {
    console.error('Delete Announcement Error:', error);
    return res.status(500).json({ success: false, message: 'ঘোষণা মুছতে ব্যর্থ হয়েছে' });
  }
});

// ================= DATABASE BACKUP & DATA SAFETY =================
const { performBackup, listBackups, BACKUP_DIR } = require('../backup');
const path = require('path');

// Trigger instant manual SQLite backup
router.post('/backup', async (req, res) => {
  try {
    const backupInfo = await performBackup();
    return res.json({
      success: true,
      message: 'ডাটাবেজ সফলভাবে ব্যাকআপ নেওয়া হয়েছে!',
      backup: backupInfo
    });
  } catch (error) {
    console.error('Admin Backup Error:', error);
    return res.status(500).json({ success: false, message: 'ডাটাবেজ ব্যাকআপ নিতে ব্যর্থ হয়েছে' });
  }
});

// List all existing backups
router.get('/backups', (req, res) => {
  try {
    const backups = listBackups();
    return res.json({
      success: true,
      count: backups.length,
      backups
    });
  } catch (error) {
    console.error('Admin List Backups Error:', error);
    return res.status(500).json({ success: false, message: 'ব্যাকআপ তালিকা লোড ব্যর্থ হয়েছে' });
  }
});

// Download a backup snapshot file
router.get('/backups/download/:filename', (req, res) => {
  try {
    const rawFilename = req.params.filename;
    // Strict basename check against directory traversal
    const safeFilename = path.basename(rawFilename);
    if (!safeFilename.endsWith('.sqlite')) {
      return res.status(400).json({ success: false, message: 'অবৈধ ফাইল ফরম্যাট' });
    }
    const filePath = path.join(BACKUP_DIR, safeFilename);
    const fs = require('fs');
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, message: 'ব্যাকআপ ফাইলটি পাওয়া যায়নি' });
    }
    return res.download(filePath, safeFilename);
  } catch (error) {
    console.error('Download Backup Error:', error);
    return res.status(500).json({ success: false, message: 'ব্যাকআপ ফাইল ডাউনলোডে সমস্যা হয়েছে' });
  }
});

module.exports = router;

