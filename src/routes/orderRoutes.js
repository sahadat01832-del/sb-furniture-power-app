const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { query, get, run, withTransaction } = require('../db');
const { optionalAuth, verifyToken } = require('../auth');
const config = require('../config');

const normalizePhone = (value) => {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('00880')) digits = `0${digits.slice(5)}`;
  else if (digits.startsWith('880')) digits = `0${digits.slice(3)}`;
    return digits;
};

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
    if (typeof customer_name !== 'string' || !customer_name.trim() || customer_name.trim().length > 100) {
      return res.status(400).json({ success: false, message: 'গ্রাহকের নাম আবশ্যক' });
    }

    const cleanCustomerPhone = normalizePhone(customer_phone);
    if (!/^01[3-9]\d{8}$/.test(cleanCustomerPhone)) {
      return res.status(400).json({ success: false, message: 'গ্রাহকের সঠিক ১১ ডিজিটের মোবাইল নম্বর দিন' });
    }

    if (typeof delivery_address !== 'string' || !delivery_address.trim() || delivery_address.trim().length > 300) {
      return res.status(400).json({ success: false, message: 'সম্পূর্ণ ডেলিভারি ঠিকানা দিন' });
    }

    if (!delivery_city || !['inside_dhaka', 'outside_dhaka'].includes(delivery_city)) {
      return res.status(400).json({ success: false, message: 'ডেলিভারি এরিয়া (ঢাকা ভেতরে / ঢাকা বাইরে) নির্বাচন করুন' });
    }

    if (!Array.isArray(items) || items.length === 0 || items.length > 20) {
      return res.status(400).json({ success: false, message: 'অর্ডারে অন্তত একটি পণ্য নির্বাচন করুন' });
    }

    const advanceAmount = advance_paid === undefined || advance_paid === null || advance_paid === '' ? 0 : Number(advance_paid);
    if (!Number.isFinite(advanceAmount) || advanceAmount < 0) {
      return res.status(400).json({ success: false, message: 'অগ্রিম টাকার পরিমাণ সঠিকভাবে দিন' });
    }
    if (advance_trx_id !== undefined && advance_trx_id !== null && advance_trx_id !== '' && typeof advance_trx_id !== 'string') {
      return res.status(400).json({ success: false, message: 'অগ্রিম পেমেন্টের TrxID সঠিকভাবে দিন' });
    }
    if (advanceAmount > 0) {
      if (typeof advance_trx_id !== 'string' || advance_trx_id.trim().length < 4 || advance_trx_id.trim().length > 80) {
        return res.status(400).json({ success: false, message: 'অগ্রিম বুকিং পেমেন্টের সঠিক বিকাশ/নগদ TrxID প্রদান করুন' });
      }
    }
    if (notes !== undefined && notes !== null && (typeof notes !== 'string' || notes.length > 500)) {
      return res.status(400).json({ success: false, message: 'অতিরিক্ত নোট ৫০০ অক্ষরের মধ্যে দিন' });
    }
    if (referral_code !== undefined && referral_code !== null && (typeof referral_code !== 'string' || referral_code.length > 40)) {
      return res.status(400).json({ success: false, message: 'রেফারেল কোড সঠিক নয়' });
    }

    // Attribute a sale to the code that brought the customer. Do not award
    // commission when the order is for the reseller's own phone number.
    let resellerId = null;
    const isAccountHolderOrder = req.user && normalizePhone(req.user.phone) === cleanCustomerPhone;
    if (!isAccountHolderOrder) {
      if (referral_code && referral_code.trim()) {
        const resellerUser = await get(
          'SELECT id, phone FROM users WHERE referral_code = ?',
          [referral_code.trim().toUpperCase()]
        );
        if (resellerUser && normalizePhone(resellerUser.phone) !== cleanCustomerPhone) {
          resellerId = resellerUser.id;
        }
      } else if (req.user && req.user.role === 'reseller') {
        // Supports a reseller entering an order for a separate customer.
        resellerId = req.user.id;
      }
    }

    // Fetch and validate all products
    let subtotal = 0;
    let totalCommission = 0;
    let hasFurniture = false;
    const validatedItems = [];

    for (const item of items) {
      const productId = Number(item && item.product_id);
      const quantity = Number(item && item.quantity);
      if (!Number.isSafeInteger(productId) || productId < 1 || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100) {
        return res.status(400).json({ success: false, message: 'পণ্যের আইডি বা পরিমাণ সঠিক নয়' });
      }

      const product = await get('SELECT * FROM products WHERE id = ? AND is_active = 1', [productId]);
      if (!product) {
        return res.status(400).json({ success: false, message: `পণ্য আইডি ${productId} খুঁজে পাওয়া যায়নি` });
      }

      if (product.brand === 'SB Furniture') {
        hasFurniture = true;
      }

      if (item.selected_color !== undefined && item.selected_color !== null && (typeof item.selected_color !== 'string' || item.selected_color.length > 80)) {
        return res.status(400).json({ success: false, message: 'পণ্যের রঙের তথ্য সঠিক নয়' });
      }

      const itemTotal = product.regular_price * quantity;
      const itemCommission = product.reseller_commission * quantity;

      if (!Number.isSafeInteger(itemTotal) || !Number.isSafeInteger(itemCommission)) {
        return res.status(400).json({ success: false, message: 'অর্ডারের মূল্য গণনা করা যাচ্ছে না' });
      }

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
    const totalAmount = subtotal + deliveryFee;
    if (advanceAmount > totalAmount) {
      return res.status(400).json({ success: false, message: 'অগ্রিমের পরিমাণ মোট অর্ডারের চেয়ে বেশি হতে পারবে না' });
    }
    // Generate readable order number
    const orderNumber = `SB-${Date.now().toString().slice(-6)}-${crypto.randomInt(100, 1000)}`;

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
          cleanCustomerPhone,
          delivery_address.trim(),
          delivery_city,
          subtotal,
          deliveryFee,
          totalAmount,
          advanceAmount,
          advanceAmount > 0 ? advance_trx_id.trim() : null,
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
        customer_phone: cleanCustomerPhone,
        subtotal_amount: subtotal,
        delivery_fee: deliveryFee,
        advance_paid: advanceAmount,
        advance_trx_id: advanceAmount > 0 ? advance_trx_id.trim() : null,
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

// Public order tracking requires both the order number and its phone number.
router.post('/track', async (req, res) => {
  try {
    const orderNumber = typeof req.body.order_number === 'string' ? req.body.order_number.trim().toUpperCase() : '';
    const phone = normalizePhone(req.body.phone);
    if (!/^SB-[A-Z0-9-]{6,40}$/.test(orderNumber) || !/^01\d{9}$/.test(phone)) {
      return res.status(400).json({ success: false, message: 'সঠিক অর্ডার নম্বর ও ১১ ডিজিটের ফোন নম্বর দিন' });
    }

    const order = await get('SELECT * FROM orders WHERE order_number = ? AND customer_phone = ?', [orderNumber, phone]);
    if (!order) {
      return res.status(404).json({ success: false, message: 'অর্ডার নম্বর বা ফোন নম্বর মেলেনি' });
    }

    const items = await query('SELECT * FROM order_items WHERE order_id = ?', [order.id]);
    return res.json({ success: true, order: { ...order, items } });
  } catch (error) {
    console.error('Order Tracking Error:', error);
    return res.status(500).json({ success: false, message: 'অর্ডার ট্র্যাকিং ব্যর্থ হয়েছে' });
  }
});

// Customer order history (/api/orders/my-orders)
router.get('/my-orders', verifyToken, async (req, res) => {
  try {
    const orders = await query(
      `SELECT o.*,
        (SELECT SUM(commission_per_unit * quantity) FROM order_items WHERE order_id = o.id) as reseller_commission
       FROM orders o
       WHERE o.reseller_id = ? OR o.customer_phone = ?
       ORDER BY o.id DESC LIMIT 50`,
      [req.user.id, req.user.phone]
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
