const express = require('express');
const router = express.Router();
const { query, get, run, withTransaction } = require('../db');
const { optionalAuth, verifyToken } = require('../auth');
const config = require('../config');

// Calculate delivery fee
const calculateDeliveryFee = (hasFurniture, city) => {
  if (hasFurniture) {
    return city === 'inside_dhaka' 
      ? config.DELIVERY.INSIDE_DHAKA_FURNITURE 
      : config.DELIVERY.OUTSIDE_DHAKA_FURNITURE;
  }
  return city === 'inside_dhaka' 
    ? config.DELIVERY.INSIDE_DHAKA_GADGET 
    : config.DELIVERY.OUTSIDE_DHAKA_GADGET;
};

// Create new order
router.post('/', optionalAuth, async (req, res) => {
  try {
    const {
      items,
      customer_name,
      customer_phone,
      delivery_address,
      delivery_city,
      advance_paid,
      advance_trx_id,
      notes,
      referral_code
    } = req.body;

    // Validations
    if (!customer_name || !customer_name.trim()) {
      return res.status(400).json({ success: false, message: 'গ্রাহকের নাম আবশ্যক' });
    }

    if (!customer_phone || !customer_phone.trim() || customer_phone.trim().length < 11) {
      return res.status(400).json({ success: false, message: 'গ্রাহকের সঠিক ১১ ডিজিটের মোবাইল নম্বর দিন' });
    }

    if (!delivery_address || !delivery_address.trim()) {
      return res.status(400).json({ success: false, message: 'সম্পূর্ণ ডেলিভারি ঠিকানা দিন' });
    }

    if (!delivery_city || !['inside_dhaka', 'outside_dhaka'].includes(delivery_city)) {
      return res.status(400).json({ success: false, message: 'ডেলিভারি এরিয়া (ঢাকা ভেতরে / ঢাকা বাইরে) নির্বাচন করুন' });
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'অর্ডারে অন্তত একটি পণ্য নির্বাচন করুন' });
    }

    const parsedAdvanceCheck = parseFloat(advance_paid);
    if (!isNaN(parsedAdvanceCheck) && parsedAdvanceCheck > 0) {
      if (!advance_trx_id || !advance_trx_id.trim() || advance_trx_id.trim().length < 4) {
        return res.status(400).json({ success: false, message: 'অগ্রিম বুকিং পেমেন্টের সঠিক বিকাশ/নগদ TrxID প্রদান করুন' });
      }
    }

    // Determine Reseller attribution
    let resellerId = null;
    if (req.user && req.user.id) {
      resellerId = req.user.id;
    } else if (referral_code && referral_code.trim()) {
      const resellerUser = await get('SELECT id FROM users WHERE referral_code = ?', [referral_code.trim().toUpperCase()]);
      if (resellerUser) {
        resellerId = resellerUser.id;
      }
    }

    // Fetch and validate all products
    let subtotal = 0;
    let totalCommission = 0;
    let hasFurniture = false;
    const validatedItems = [];

    for (const item of items) {
      const productId = parseInt(item.product_id, 10);
      const quantity = Math.max(1, parseInt(item.quantity, 10) || 1);

      const product = await get('SELECT * FROM products WHERE id = ? AND is_active = 1', [productId]);
      if (!product) {
        return res.status(400).json({ success: false, message: `পণ্য আইডি ${productId} খুঁজে পাওয়া যায়নি` });
      }

      if (product.brand === 'SB Furniture') {
        hasFurniture = true;
      }

      const itemTotal = product.regular_price * quantity;
      const itemCommission = product.reseller_commission * quantity;

      subtotal += itemTotal;
      totalCommission += itemCommission;

      validatedItems.push({
        product_id: product.id,
        title: product.title,
        sku: product.sku,
        quantity,
        unit_price: product.regular_price,
        commission_per_unit: product.reseller_commission,
        selected_color: item.selected_color || '',
        total_price: itemTotal
      });
    }

    const deliveryFee = calculateDeliveryFee(hasFurniture, delivery_city);
    const advanceAmount = Math.max(0, parseFloat(advance_paid) || 0);
    const totalAmount = subtotal + deliveryFee;

    // Generate readable order number
    const orderNumber = `SB-${Date.now().toString().slice(-6)}-${Math.floor(100 + Math.random() * 900)}`;

    // Insert Order, Items, Wallet Transaction, and Audit Log atomically
    const { orderId } = await withTransaction(async ({ run: txRun }) => {
      const orderResult = await txRun(
        `INSERT INTO orders (
          order_number, reseller_id, customer_name, customer_phone, delivery_address,
          delivery_city, subtotal_amount, delivery_fee, total_amount, advance_paid,
          advance_trx_id, payment_method, status, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'cod', 'pending', ?)`,
        [
          orderNumber,
          resellerId,
          customer_name.trim(),
          customer_phone.trim(),
          delivery_address.trim(),
          delivery_city,
          subtotal,
          deliveryFee,
          totalAmount,
          advanceAmount,
          advance_trx_id ? advance_trx_id.trim() : null,
          notes ? notes.trim() : null
        ]
      );

      const createdOrderId = orderResult.lastID;

      // Insert Order Items
      for (const item of validatedItems) {
        await txRun(
          `INSERT INTO order_items (
            order_id, product_id, title, sku, quantity, unit_price,
            commission_per_unit, selected_color, total_price
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            createdOrderId,
            item.product_id,
            item.title,
            item.sku,
            item.quantity,
            item.unit_price,
            item.commission_per_unit,
            item.selected_color,
            item.total_price
          ]
        );
      }

      // If attributed to a reseller, record pending commission transaction
      if (resellerId && totalCommission > 0) {
        await txRun(
          `INSERT INTO wallet_transactions (
            user_id, order_id, amount, type, status, notes
          ) VALUES (?, ?, ?, 'commission', 'pending', ?)`,
          [resellerId, createdOrderId, totalCommission, `অর্ডার #${orderNumber}-এর সম্ভাব্য কমিশন`]
        );
      }

      // Record initial audit trail log
      await txRun(
        `INSERT INTO order_status_logs (
          order_id, previous_status, new_status, notes
        ) VALUES (?, NULL, 'pending', 'অর্ডার সফলভাবে প্লেস করা হয়েছে')`,
        [createdOrderId]
      );

      return { orderId: createdOrderId };
    });

    return res.status(201).json({
      success: true,
      message: 'অর্ডারটি সফলভাবে গ্রহণ করা হয়েছে!',
      order: {
        id: orderId,
        order_number: orderNumber,
        customer_name: customer_name.trim(),
        customer_phone: customer_phone.trim(),
        subtotal_amount: subtotal,
        delivery_fee: deliveryFee,
        advance_paid: advanceAmount,
        advance_trx_id: advance_trx_id ? advance_trx_id.trim() : null,
        total_amount: totalAmount,
        status: 'pending',
        reseller_id: resellerId
      }
    });
  } catch (error) {
    console.error('Order Creation Error:', error);
    return res.status(500).json({ success: false, message: 'অর্ডার প্রসেস করতে ব্যর্থ হয়েছে' });
  }
});

// Search order tracking by order_number OR customer_phone
router.get('/track/search', async (req, res) => {
  try {
    const q = req.query.query ? req.query.query.trim() : '';
    if (!q) {
      return res.status(400).json({ success: false, message: 'অর্ডার নম্বর বা ফোন নম্বর দিন' });
    }

    const cleanQuery = q.toUpperCase();
    const cleanPhone = q.replace(/\D/g, '');

    let orders;
    if (cleanPhone.length >= 10) {
      orders = await query(
        'SELECT * FROM orders WHERE customer_phone LIKE ? OR order_number = ? ORDER BY id DESC LIMIT 10',
        [`%${cleanPhone.slice(-10)}%`, cleanQuery]
      );
    } else {
      orders = await query(
        'SELECT * FROM orders WHERE order_number = ? OR customer_phone = ? ORDER BY id DESC LIMIT 10',
        [cleanQuery, q]
      );
    }

    if (!orders || orders.length === 0) {
      return res.status(404).json({ success: false, message: 'কোনো অর্ডার খুঁজে পাওয়া যায়নি' });
    }

    const enriched = await Promise.all(
      orders.map(async (order) => {
        const items = await query('SELECT * FROM order_items WHERE order_id = ?', [order.id]);
        return { ...order, items };
      })
    );

    return res.json({
      success: true,
      count: enriched.length,
      orders: enriched,
      order: enriched[0] // convenient single order lookup
    });
  } catch (error) {
    console.error('Track Search Error:', error);
    return res.status(500).json({ success: false, message: 'ট্র্যাকিং অনুসন্ধানে সমস্যা হয়েছে' });
  }
});

// Customer order tracking by order_number (with phone fallback)
router.get('/track/:orderNumber', async (req, res) => {
  try {
    const param = req.params.orderNumber.trim();
    let order = await get('SELECT * FROM orders WHERE order_number = ?', [param.toUpperCase()]);

    if (!order && param.replace(/\D/g, '').length >= 10) {
      const phoneDigits = param.replace(/\D/g, '').slice(-10);
      order = await get('SELECT * FROM orders WHERE customer_phone LIKE ? ORDER BY id DESC LIMIT 1', [`%${phoneDigits}%`]);
    }

    if (!order) {
      return res.status(404).json({ success: false, message: 'অর্ডার নম্বরটি পাওয়া যায়নি' });
    }

    const items = await query('SELECT * FROM order_items WHERE order_id = ?', [order.id]);

    return res.json({
      success: true,
      order: {
        ...order,
        items
      }
    });
  } catch (error) {
    console.error('Order Tracking Error:', error);
    return res.status(500).json({ success: false, message: 'অর্ডার ট্র্যাকিং ব্যর্থ হয়েছে' });
  }
});

// Customer order history (/api/orders/my-orders)
router.get('/my-orders', optionalAuth, async (req, res) => {
  try {
    const phone = req.query.phone ? req.query.phone.trim() : (req.user ? req.user.phone : null);
    const userId = req.user ? req.user.id : null;

    if (!phone && !userId) {
      return res.status(400).json({ success: false, message: 'মোবাইল নম্বর অথবা লগইন সেশন প্রয়োজন' });
    }

    let orders;
    if (userId && phone) {
      orders = await query(
        `SELECT o.*, 
          (SELECT SUM(commission_per_unit * quantity) FROM order_items WHERE order_id = o.id) as reseller_commission
         FROM orders o 
         WHERE o.reseller_id = ? OR o.customer_phone = ?
         ORDER BY o.id DESC LIMIT 50`,
        [userId, phone]
      );
    } else if (userId) {
      orders = await query(
        `SELECT o.*, 
          (SELECT SUM(commission_per_unit * quantity) FROM order_items WHERE order_id = o.id) as reseller_commission
         FROM orders o 
         WHERE o.reseller_id = ? 
         ORDER BY o.id DESC LIMIT 50`,
        [userId]
      );
    } else {
      orders = await query(
        `SELECT * FROM orders WHERE customer_phone = ? ORDER BY id DESC LIMIT 50`,
        [phone]
      );
    }

    const enriched = await Promise.all(
      orders.map(async (order) => {
        const items = await query('SELECT * FROM order_items WHERE order_id = ?', [order.id]);
        return { ...order, items };
      })
    );

    return res.json({
      success: true,
      count: enriched.length,
      orders: enriched
    });
  } catch (error) {
    console.error('My Orders Error:', error);
    return res.status(500).json({ success: false, message: 'অর্ডার তালিকা লোড করতে ব্যর্থ হয়েছে' });
  }
});

// Reseller's sales list (/api/orders/reseller-sales)
router.get('/reseller-sales', verifyToken, async (req, res) => {
  try {
    const orders = await query(
      `SELECT o.*, 
        (SELECT SUM(commission_per_unit * quantity) FROM order_items WHERE order_id = o.id) as reseller_commission
       FROM orders o 
       WHERE o.reseller_id = ? 
       ORDER BY o.id DESC`,
      [req.user.id]
    );

    const enriched = await Promise.all(
      orders.map(async (order) => {
        const items = await query('SELECT * FROM order_items WHERE order_id = ?', [order.id]);
        return { ...order, items };
      })
    );

    return res.json({
      success: true,
      count: enriched.length,
      orders: enriched
    });
  } catch (error) {
    console.error('Reseller Sales Error:', error);
    return res.status(500).json({ success: false, message: 'রিসেলার সেলস তালিকা লোড ব্যর্থ হয়েছে' });
  }
});

// Reseller's own order list (backward-compatible alias)
router.get('/my/list', verifyToken, async (req, res) => {
  try {
    const orders = await query(
      `SELECT o.*, 
        (SELECT SUM(commission_per_unit * quantity) FROM order_items WHERE order_id = o.id) as reseller_commission
       FROM orders o 
       WHERE o.reseller_id = ? 
       ORDER BY o.id DESC`,
      [req.user.id]
    );

    const enriched = await Promise.all(
      orders.map(async (order) => {
        const items = await query('SELECT * FROM order_items WHERE order_id = ?', [order.id]);
        return { ...order, items };
      })
    );

    return res.json({
      success: true,
      count: enriched.length,
      orders: enriched
    });
  } catch (error) {
    console.error('Reseller Orders Error:', error);
    return res.status(500).json({ success: false, message: 'অর্ডার তালিকা লোড ব্যর্থ হয়েছে' });
  }
});

module.exports = router;
