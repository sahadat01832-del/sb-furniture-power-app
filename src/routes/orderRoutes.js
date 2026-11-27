const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { query, get, run, withTransaction } = require('../db');
const { optionalAuth, verifyToken, requireRole } = require('../auth');
const config = require('../config');
const { toPaisa, fromPaisa, takaFields } = require('../money');

const ORDER_MONEY_FIELDS = ['subtotal_amount', 'delivery_fee', 'total_amount', 'advance_paid', 'discount_amount', 'reseller_commission'];
const ITEM_MONEY_FIELDS = ['unit_price', 'commission_per_unit', 'total_price', 'unit_selling_price'];

// Internal accounting snapshots that customer/reseller responses must never expose.
const ORDER_PRIVATE_FIELDS = [
  'total_wholesale_amount',
  'total_reseller_commission',
  'platform_net_profit',
  'referral_commission_amount',
  'referral_credit_amount',
  'partner_settled',
  'reseller_id'
];

// Money lives in the database as INTEGER paisa and is returned as taka.
const orderToClient = (order, includeCommission = false) => {
  if (!order) return order;
  const converted = takaFields(order, ORDER_MONEY_FIELDS);
  for (const field of ORDER_PRIVATE_FIELDS) delete converted[field];
  if (!includeCommission) delete converted.reseller_commission;
  if (Array.isArray(order.items)) {
    converted.items = order.items.map((item) => {
      const itemConv = takaFields(item, ITEM_MONEY_FIELDS);
      delete itemConv.unit_wholesale_price;
      delete itemConv.platform_net_profit;
      delete itemConv.shop_id;
      delete itemConv.shop_name;
      delete itemConv.shop_type;
      delete itemConv.unit_commission;
      if (!includeCommission) {
        delete itemConv.commission_per_unit;
      }
      return itemConv;
    });
  }
  return converted;
};

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
      ? toPaisa(config.DELIVERY.INSIDE_DHAKA_FURNITURE)
      : toPaisa(config.DELIVERY.OUTSIDE_DHAKA_FURNITURE);
  }
  return city === 'inside_dhaka'
    ? toPaisa(config.DELIVERY.INSIDE_DHAKA_GADGET)
    : toPaisa(config.DELIVERY.OUTSIDE_DHAKA_GADGET);
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
      referral_code,
      use_referral_credit
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

    const advanceAmount = advance_paid === undefined || advance_paid === null || advance_paid === '' ? 0 : toPaisa(advance_paid);
    if (advanceAmount === null || advanceAmount < 0) {
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
    if (use_referral_credit !== undefined && typeof use_referral_credit !== 'boolean') {
      return res.status(400).json({ success: false, message: 'রেফারেল ছাড়ের নির্বাচন সঠিক নয়' });
    }

    const isAccountHolderOrder = req.user && normalizePhone(req.user.phone) === cleanCustomerPhone;
    let customerUserId = null;
    if (isAccountHolderOrder) {
      const account = await get('SELECT id, role FROM users WHERE id = ? AND phone = ? AND status = \'active\'', [req.user.id, cleanCustomerPhone]);
      if (account) customerUserId = account.id;
    }
    if (use_referral_credit && (!customerUserId || !['customer', 'reseller'].includes(req.user.role))) {
      return res.status(400).json({ success: false, message: 'নিজের অ্যাকাউন্টে লগইন করে রেফারেল ছাড় ব্যবহার করুন' });
    }

    // Attribute a sale to the code that brought the customer. Do not award
    // commission when the order is for the reseller's own phone number.
    let resellerId = null;
    if (!isAccountHolderOrder) {
      if (referral_code && referral_code.trim()) {
        const resellerUser = await get(
          "SELECT id, phone FROM users WHERE referral_code = ? AND role = 'reseller' AND status = 'active'",
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
    let totalWholesale = 0;
    let totalPlatformProfit = 0;
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

      const wholesalePrice = product.wholesale_price || 0;
      const unitSellingPrice = product.regular_price;
      const unitCommission = product.reseller_commission || 0;

      const itemTotal = unitSellingPrice * quantity;
      const itemCommission = unitCommission * quantity;
      const itemWholesale = wholesalePrice * quantity;
      const itemPlatformProfit = (unitSellingPrice - wholesalePrice - unitCommission) * quantity;

      if (!Number.isSafeInteger(itemTotal) || !Number.isSafeInteger(itemCommission)) {
        return res.status(400).json({ success: false, message: 'অর্ডারের মূল্য গণনা করা যাচ্ছে না' });
      }

      subtotal += itemTotal;
      totalCommission += itemCommission;
      totalWholesale += itemWholesale;
      totalPlatformProfit += itemPlatformProfit;

      const shopType = product.shop_type || (product.shop_name && !['SB Furniture', 'SB POWER', 'SB Lifestyle & Tools'].includes(product.shop_name) ? 'partner' : 'own');

      validatedItems.push({
        product_id: product.id,
        title: product.title,
        sku: product.sku,
        quantity,
        unit_price: unitSellingPrice,
        commission_per_unit: unitCommission,
        unit_wholesale_price: wholesalePrice,
        unit_selling_price: unitSellingPrice,
        unit_commission: unitCommission,
        platform_net_profit: itemPlatformProfit,
        shop_id: product.shop_id || null,
        shop_name: product.shop_name || product.brand || 'SB Furniture',
        shop_type: shopType,
        selected_color: item.selected_color || '',
        total_price: itemTotal
      });
    }

    const deliveryFee = calculateDeliveryFee(hasFurniture, delivery_city);
    let orderDiscount = 0;
    let referralCommissionAmount = 0;
    let referralCreditAmount = 0;
    let orderReferrerId = null;
    let totalAmount = subtotal + deliveryFee;
    let orderPlatformNetProfit = totalPlatformProfit;
    // Generate readable order number
    const orderNumber = `SB-${Date.now().toString().slice(-6)}-${crypto.randomInt(100, 1000)}`;

    // Insert Order, Items, Wallet Transaction, and Audit Log atomically
    const { orderId } = await withTransaction(async ({ run: txRun, get: txGet }) => {
      // Reserve stock inside the same transaction as the order, and only when
      // enough units are still on hand, so concurrent orders cannot oversell.
      const unitsPerProduct = new Map();
      for (const item of validatedItems) {
        unitsPerProduct.set(item.product_id, (unitsPerProduct.get(item.product_id) || 0) + item.quantity);
      }
      for (const [productId, quantity] of unitsPerProduct) {
        const reservation = await txRun(
          `UPDATE products
           SET stock = stock - ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND is_active = 1 AND stock >= ?`,
          [quantity, productId, quantity]
        );
        if (!reservation || reservation.changes !== 1) {
          const stockError = new Error(`পণ্য আইডি ${productId}-এর পর্যাপ্ত স্টক নেই`);
          stockError.statusCode = 409;
          throw stockError;
        }
      }

      const referralSettings = await txGet(
        'SELECT is_enabled, customer_reward_bps, reseller_commission_bps FROM referral_settings WHERE id = 1'
      );
      let buyerAccount = null;
      if (customerUserId) {
        buyerAccount = await txGet(
          'SELECT id, role, referred_by_id FROM users WHERE id = ? AND phone = ? AND status = \'active\'',
          [customerUserId, cleanCustomerPhone]
        );
      }
      let referrer = null;
      if (buyerAccount && buyerAccount.referred_by_id && buyerAccount.referred_by_id !== buyerAccount.id) {
        referrer = await txGet(
          "SELECT id, role FROM users WHERE id = ? AND status = 'active'",
          [buyerAccount.referred_by_id]
        );
        if (referrer && ['customer', 'reseller'].includes(referrer.role)) {
          orderReferrerId = referrer.id;
        } else {
          referrer = null;
        }
      }

      if (use_referral_credit) {
        if (!buyerAccount || !['customer', 'reseller'].includes(buyerAccount.role)) {
          const accountError = new Error('রেফারেল ছাড় ব্যবহার করতে সক্রিয় কাস্টমার বা রিসেলার অ্যাকাউন্ট প্রয়োজন');
          accountError.statusCode = 400;
          throw accountError;
        }
        const creditRow = await txGet(
          `SELECT
             COALESCE(SUM(CASE WHEN type = 'referral_credit' AND status IN ('available', 'completed') THEN amount ELSE 0 END), 0)
             - COALESCE(SUM(CASE WHEN type = 'referral_redemption' AND status = 'completed' THEN amount ELSE 0 END), 0) AS balance
           FROM wallet_transactions WHERE user_id = ?`,
          [customerUserId]
        );
        const creditBalance = Math.max(0, Number(creditRow && creditRow.balance) || 0);
        orderDiscount = Math.min(creditBalance, subtotal);
        if (orderDiscount <= 0) {
          const creditError = new Error('ব্যবহারের মতো কোনো রেফারেল ছাড় জমা নেই');
          creditError.statusCode = 400;
          throw creditError;
        }
      }

      let remainingReferralBudget = Math.max(0, totalPlatformProfit + orderDiscount);
      if (referralSettings && referralSettings.is_enabled && referrer && buyerAccount) {
        if (referrer.role === 'reseller') {
          const target = Math.floor((subtotal * Number(referralSettings.reseller_commission_bps || 0)) / 10000);
          referralCommissionAmount = Math.min(target, remainingReferralBudget);
          remainingReferralBudget -= referralCommissionAmount;
        } else if (referrer.role === 'customer') {
          const target = Math.floor((subtotal * Number(referralSettings.customer_reward_bps || 0)) / 10000);
          referralCreditAmount = Math.min(target, remainingReferralBudget);
          remainingReferralBudget -= referralCreditAmount;
        }
      }

      totalAmount = subtotal + deliveryFee - orderDiscount;
      if (advanceAmount > totalAmount) {
        const advanceError = new Error('অগ্রিমের পরিমাণ ডিসকাউন্টের পর মোট অর্ডারের চেয়ে বেশি হতে পারবে না');
        advanceError.statusCode = 400;
        throw advanceError;
      }
      orderPlatformNetProfit = totalPlatformProfit + orderDiscount - referralCommissionAmount - referralCreditAmount;

      // Financial snapshots preserved on order insertion
      const orderResult = await txRun(
        `INSERT INTO orders (
          order_number, reseller_id, customer_name, customer_phone, delivery_address,
          delivery_city, subtotal_amount, delivery_fee, total_amount, advance_paid,
          advance_trx_id, payment_method, status, notes,
          total_wholesale_amount, total_reseller_commission, platform_net_profit,
          customer_user_id, referrer_user_id, discount_amount,
          referral_commission_amount, referral_credit_amount, referral_reward_released,
          commission_released, partner_settled
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'cod', 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0)`,
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
          notes ? notes.trim() : null,
          totalWholesale,
          totalCommission,
          orderPlatformNetProfit,
          customerUserId,
          orderReferrerId,
          orderDiscount,
          referralCommissionAmount,
          referralCreditAmount
        ]
      );

      const createdOrderId = orderResult.lastID;

      // Insert Order Items with 3-way financial and shop snapshots
      for (const item of validatedItems) {
        await txRun(
          `INSERT INTO order_items (
            order_id, product_id, title, sku, quantity, unit_price,
            commission_per_unit, selected_color, total_price,
            unit_wholesale_price, unit_selling_price, unit_commission,
            platform_net_profit, shop_id, shop_name, shop_type
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            createdOrderId,
            item.product_id,
            item.title,
            item.sku,
            item.quantity,
            item.unit_price,
            item.commission_per_unit,
            item.selected_color,
            item.total_price,
            item.unit_wholesale_price,
            item.unit_selling_price,
            item.unit_commission,
            item.platform_net_profit,
            item.shop_id,
            item.shop_name,
            item.shop_type
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

      if (orderReferrerId && referralCommissionAmount > 0) {
        await txRun(
          `INSERT INTO wallet_transactions (user_id, order_id, amount, type, status, notes)
           VALUES (?, ?, ?, 'referral_commission', 'pending', ?)`,
          [orderReferrerId, createdOrderId, referralCommissionAmount, `আমন্ত্রিত সদস্যের অর্ডার #${orderNumber}-এর রেফারেল কমিশন`]
        );
      }
      if (orderReferrerId && referralCreditAmount > 0) {
        await txRun(
          `INSERT INTO wallet_transactions (user_id, order_id, amount, type, status, notes)
           VALUES (?, ?, ?, 'referral_credit', 'pending', ?)`,
          [orderReferrerId, createdOrderId, referralCreditAmount, `আমন্ত্রিত সদস্যের অর্ডার #${orderNumber}-এর ছাড় জমা`]
        );
      }
      if (orderDiscount > 0) {
        await txRun(
          `INSERT INTO wallet_transactions (user_id, order_id, amount, type, status, notes)
           VALUES (?, ?, ?, 'referral_redemption', 'completed', ?)`,
          [customerUserId, createdOrderId, orderDiscount, `অর্ডার #${orderNumber}-এ রেফারেল ছাড় ব্যবহার`]
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

    const orderSummary = {
      id: orderId,
      order_number: orderNumber,
      customer_name: customer_name.trim(),
      customer_phone: cleanCustomerPhone,
      subtotal_amount: fromPaisa(subtotal),
      delivery_fee: fromPaisa(deliveryFee),
      advance_paid: fromPaisa(advanceAmount),
      advance_trx_id: advanceAmount > 0 ? advance_trx_id.trim() : null,
      total_amount: fromPaisa(totalAmount),
      discount_amount: fromPaisa(orderDiscount),
      status: 'pending'
    };
    if (req.user && req.user.id === resellerId && ['reseller', 'admin'].includes(req.user.role)) {
      orderSummary.reseller_commission = fromPaisa(totalCommission);
    }

    return res.status(201).json({
      success: true,
      message: 'অর্ডারটি সফলভাবে গ্রহণ করা হয়েছে!',
      order: orderSummary
    });
  } catch (error) {
    if (error.statusCode === 409) {
      return res.status(409).json({ success: false, message: error.message });
    }
    if (error.statusCode === 400) {
      return res.status(400).json({ success: false, message: error.message });
    }
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
    return res.json({ success: true, order: orderToClient({ ...order, items }) });
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
      orders: enriched.map((order) => orderToClient(order, ['reseller', 'admin'].includes(req.user.role)))
    });
  } catch (error) {
    console.error('My Orders Error:', error);
    return res.status(500).json({ success: false, message: 'অর্ডার তালিকা লোড করতে ব্যর্থ হয়েছে' });
  }
});

// Reseller's sales list (/api/orders/reseller-sales)
router.get('/reseller-sales', verifyToken, requireRole('reseller', 'admin'), async (req, res) => {
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
      orders: enriched.map((order) => orderToClient(order, true))
    });
  } catch (error) {
    console.error('Reseller Sales Error:', error);
    return res.status(500).json({ success: false, message: 'রিসেলার সেলস তালিকা লোড ব্যর্থ হয়েছে' });
  }
});

// Reseller's own order list (backward-compatible alias)
router.get('/my/list', verifyToken, requireRole('reseller', 'admin'), async (req, res) => {
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
      orders: enriched.map((order) => orderToClient(order, true))
    });
  } catch (error) {
    console.error('Reseller Orders Error:', error);
    return res.status(500).json({ success: false, message: 'অর্ডার তালিকা লোড ব্যর্থ হয়েছে' });
  }
});

module.exports = router;
