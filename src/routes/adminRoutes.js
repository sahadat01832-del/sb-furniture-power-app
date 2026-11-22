const express = require('express');
const router = express.Router();
const { query, get, run, withTransaction } = require('../db');
const { verifyToken, requireRole } = require('../auth');
const config = require('../config');

// Require Admin Role for all routes in this router
router.use(verifyToken, requireRole('admin'));

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

          // Check if reseller has an upstream referrer
          const reseller = await txGet('SELECT * FROM users WHERE id = ?', [order.reseller_id]);
          if (reseller && reseller.referred_by_id) {
            const referrerId = reseller.referred_by_id;

            // Check if this reseller's first sale bonus was already awarded
            const existingRefBonus = await txGet(
              "SELECT id FROM wallet_transactions WHERE user_id = ? AND type = 'referral_bonus' AND (order_id = ? OR notes LIKE ?)",
              [referrerId, orderId, `%${reseller.name}%`]
            );

            if (!existingRefBonus) {
              const deliveredCountRow = await txGet(
                "SELECT COUNT(*) as count FROM orders WHERE reseller_id = ? AND status = 'delivered'",
                [order.reseller_id]
              );

              if (deliveredCountRow && deliveredCountRow.count === 1) {
                await txRun(
                  `INSERT INTO wallet_transactions (
                    user_id, order_id, amount, type, status, notes
                  ) VALUES (?, ?, ?, 'referral_bonus', 'available', ?)`,
                  [
                    referrerId,
                    orderId,
                    config.REFERRAL.FIRST_SALE_BONUS,
                    `ডাউনলাইন সদস্য (${reseller.name})-এর প্রথম সফল সেল বোনাস!`
                  ]
                );
              }
            } else {
              await txRun(
                "UPDATE wallet_transactions SET status = 'available' WHERE order_id = ? AND type = 'referral_bonus'",
                [orderId]
              );
            }

            // Lifetime team sales bonus (3%) - Idempotent check
            const existingTeamBonus = await txGet(
              "SELECT id FROM wallet_transactions WHERE order_id = ? AND user_id = ? AND type = 'team_bonus'",
              [orderId, referrerId]
            );

            if (!existingTeamBonus) {
              const teamBonus = Math.round((order.subtotal_amount * config.REFERRAL.LIFETIME_COMMISSION_PERCENT) / 100);
              if (teamBonus > 0) {
                await txRun(
                  `INSERT INTO wallet_transactions (
                    user_id, order_id, amount, type, status, notes
                  ) VALUES (?, ?, ?, 'team_bonus', 'available', ?)`,
                  [
                    referrerId,
                    orderId,
                    teamBonus,
                    `ডাউনলাইন সদস্য (${reseller.name})-এর অর্ডার থেকে ${config.REFERRAL.LIFETIME_COMMISSION_PERCENT}% টিম বোনাস`
                  ]
                );
              }
            } else {
              await txRun(
                "UPDATE wallet_transactions SET status = 'available' WHERE order_id = ? AND type = 'team_bonus'",
                [orderId]
              );
            }
          }
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
    const payoutId = parseInt(req.params.id, 10);
    const { status, admin_trx_id, notes } = req.body;

    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, message: 'অবৈধ পেআউট স্ট্যাটাস (approved বা rejected হতে হবে)' });
    }

    const payout = await get('SELECT * FROM payout_requests WHERE id = ?', [payoutId]);
    if (!payout) {
      return res.status(404).json({ success: false, message: 'ক্যাশআউট রিকোয়েস্ট পাওয়া যায়নি' });
    }

    await withTransaction(async ({ run: txRun }) => {
      await txRun(
        `UPDATE payout_requests 
         SET status = ?, admin_trx_id = ?, notes = ?, updated_at = CURRENT_TIMESTAMP 
         WHERE id = ?`,
        [status, admin_trx_id || null, notes || null, payoutId]
      );

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
          payout.user_id,
          payout.amount
        ]
      );

      // Notify reseller about payout approval or rejection
      const notifTitle = status === 'approved' ? 'ক্যাশআউট অনুমোদন সম্পন্ন!' : 'ক্যাশআউট রিকোয়েস্ট বাতিল';
      const notifMsg = status === 'approved'
        ? `আপনার ${payout.amount}৳ ক্যাশআউট (${payout.payment_method.toUpperCase()}: ${payout.account_number}) সফল হয়েছে। TrxID: ${admin_trx_id || 'প্রদান করা হয়েছে'}`
        : `আপনার ${payout.amount}৳ ক্যাশআউট রিকোয়েস্ট বাতিল করা হয়েছে। কারণ: ${notes || 'অ্যাকাউন্ট তথ্যে অসঙ্গতি'}`;

      await txRun(
        `INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)`,
        [payout.user_id, notifTitle, notifMsg]
      );
    });

    return res.json({
      success: true,
      message: status === 'approved' ? 'ক্যাশআউট অনুমোদন সম্পন্ন হয়েছে!' : 'ক্যাশআউট বাতিল করা হয়েছে'
    });
  } catch (error) {
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
    const {
      title,
      sku,
      brand,
      category,
      regular_price,
      reseller_commission,
      commission_tab,
      image_url,
      description,
      materials,
      finish,
      stock,
      shop_name,
      vendor_phone,
      vendor_badge,
      vendor_address
    } = req.body;

    if (!title || !sku || !brand || !category || !regular_price) {
      return res.status(400).json({ success: false, message: 'প্রয়োজনীয় ফিল্ডগুলো পূরণ করুন' });
    }

    // Check SKU duplicate
    const existing = await get('SELECT id FROM products WHERE sku = ?', [sku.trim()]);
    if (existing) {
      return res.status(400).json({ success: false, message: 'এই SKU কোডটি ইতিমধ্যে ব্যবহৃত হচ্ছে' });
    }

    const resolvedShopName = (shop_name && shop_name.trim()) ? shop_name.trim() : brand.trim();

    const result = await run(
      `INSERT INTO products (
        title, sku, brand, category, regular_price, reseller_commission, commission_tab,
        image_url, description, materials, finish, stock, is_active,
        shop_name, vendor_phone, vendor_badge, vendor_address
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      [
        title.trim(),
        sku.trim().toUpperCase(),
        brand.trim(),
        category.trim(),
        parseFloat(regular_price),
        parseFloat(reseller_commission) || 50,
        commission_tab || '50tk',
        image_url || 'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?auto=format&fit=crop&w=800&q=80',
        description || '',
        materials || '',
        finish || '',
        parseInt(stock, 10) || 50,
        resolvedShopName,
        vendor_phone ? vendor_phone.trim() : null,
        vendor_badge ? vendor_badge.trim() : null,
        vendor_address ? vendor_address.trim() : null
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
    const productId = parseInt(req.params.id, 10);
    const {
      title,
      sku,
      brand,
      category,
      regular_price,
      reseller_commission,
      commission_tab,
      image_url,
      description,
      materials,
      finish,
      stock,
      is_active,
      shop_name,
      vendor_phone,
      vendor_badge,
      vendor_address
    } = req.body;

    const product = await get('SELECT * FROM products WHERE id = ?', [productId]);
    if (!product) {
      return res.status(404).json({ success: false, message: 'প্রোডাক্ট পাওয়া যায়নি' });
    }

    if (sku && sku.trim()) {
      const cleanSku = sku.trim().toUpperCase();
      const duplicateSku = await get('SELECT id FROM products WHERE sku = ? AND id != ?', [cleanSku, productId]);
      if (duplicateSku) {
        return res.status(400).json({ success: false, message: 'এই SKU কোডটি অন্য একটি পণ্যে ব্যবহৃত হচ্ছে' });
      }
      await run('UPDATE products SET sku = ? WHERE id = ?', [cleanSku, productId]);
    }

    const updatedTitle = title !== undefined ? title.trim() : product.title;
    const updatedBrand = brand !== undefined ? brand.trim() : product.brand;
    const updatedCategory = category !== undefined ? category.trim() : product.category;
    const updatedPrice = regular_price !== undefined ? parseFloat(regular_price) : product.regular_price;
    const updatedCommission = reseller_commission !== undefined ? parseFloat(reseller_commission) : product.reseller_commission;
    const updatedCommTab = commission_tab !== undefined ? commission_tab : product.commission_tab;
    const updatedImage = image_url !== undefined ? image_url.trim() : product.image_url;
    const updatedDesc = description !== undefined ? description.trim() : product.description;
    const updatedMaterials = materials !== undefined ? materials.trim() : product.materials;
    const updatedFinish = finish !== undefined ? finish.trim() : product.finish;
    const updatedStock = stock !== undefined ? parseInt(stock, 10) : product.stock;
    const updatedIsActive = is_active !== undefined ? parseInt(is_active, 10) : product.is_active;
    const updatedShopName = shop_name !== undefined ? (shop_name.trim() || updatedBrand) : product.shop_name;
    const updatedVendorPhone = vendor_phone !== undefined ? (vendor_phone.trim() || null) : product.vendor_phone;
    const updatedVendorBadge = vendor_badge !== undefined ? (vendor_badge.trim() || null) : product.vendor_badge;
    const updatedVendorAddress = vendor_address !== undefined ? (vendor_address.trim() || null) : product.vendor_address;

    await run(
      `UPDATE products SET
        title = ?,
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
        updatedTitle,
        updatedBrand,
        updatedCategory,
        updatedPrice,
        updatedCommission,
        updatedCommTab,
        updatedImage,
        updatedDesc,
        updatedMaterials,
        updatedFinish,
        updatedStock,
        updatedIsActive,
        updatedShopName,
        updatedVendorPhone,
        updatedVendorBadge,
        updatedVendorAddress,
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
    const { title, message, type, is_active } = req.body;
    if (!title || !message) {
      return res.status(400).json({ success: false, message: 'শিরোনাম ও বার্তা আবশ্যক' });
    }

    const result = await run(
      'INSERT INTO announcements (title, message, type, is_active) VALUES (?, ?, ?, ?)',
      [title.trim(), message.trim(), type || 'flash_deal', is_active !== undefined ? parseInt(is_active, 10) : 1]
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
    const id = parseInt(req.params.id, 10);
    const { title, message, type, is_active } = req.body;

    const ann = await get('SELECT * FROM announcements WHERE id = ?', [id]);
    if (!ann) {
      return res.status(404).json({ success: false, message: 'ঘোষণাটি পাওয়া যায়নি' });
    }

    await run(
      'UPDATE announcements SET title = ?, message = ?, type = ?, is_active = ? WHERE id = ?',
      [
        title !== undefined ? title.trim() : ann.title,
        message !== undefined ? message.trim() : ann.message,
        type !== undefined ? type : ann.type,
        is_active !== undefined ? parseInt(is_active, 10) : ann.is_active,
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

