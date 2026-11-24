const express = require('express');
const { get, query, run } = require('../db');
const { verifyToken, requireRole } = require('../auth');
const { fromPaisa, takaFields } = require('../money');

const userRouter = express.Router();
const adminRouter = express.Router();

const parseId = (value) => {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

const maskPhone = (phone) => phone ? `${String(phone).slice(0, 3)}*****${String(phone).slice(-3)}` : '';

async function getMemberChildren(parentId, includePrivate = false, offset = 0) {
  const rows = await query(
    `SELECT
       u.id, u.name, u.phone, u.role, u.referral_code, u.created_at,
       (SELECT COUNT(*) FROM users c WHERE c.referred_by_id = u.id) AS direct_referral_count,
       (SELECT COUNT(*) FROM users c WHERE c.referred_by_id = u.id AND c.role = 'customer') AS direct_customer_count,
       (SELECT COUNT(*) FROM users c WHERE c.referred_by_id = u.id AND c.role = 'reseller') AS direct_reseller_count,
       COUNT(DISTINCT CASE WHEN o.status = 'delivered' THEN o.id END) AS delivered_order_count,
       COALESCE(SUM(CASE WHEN o.status = 'delivered' THEN o.total_amount ELSE 0 END), 0) AS delivered_order_total,
       COALESCE((
         SELECT SUM(oi.quantity)
         FROM order_items oi JOIN orders oi_order ON oi_order.id = oi.order_id
         WHERE oi_order.customer_user_id = u.id AND oi_order.status = 'delivered'
       ), 0) AS delivered_units,
       COALESCE((
         SELECT SUM(wt.amount) FROM wallet_transactions wt
         WHERE wt.user_id = u.id AND wt.type = 'referral_commission' AND wt.status IN ('available', 'completed')
       ), 0) AS referral_commission_earned,
       COALESCE((
         SELECT SUM(wt.amount) FROM wallet_transactions wt
         WHERE wt.user_id = u.id AND wt.type = 'referral_commission' AND wt.status = 'pending'
       ), 0) AS referral_commission_pending
     FROM users u
     LEFT JOIN orders o ON o.customer_user_id = u.id
     WHERE u.referred_by_id = ?
     GROUP BY u.id
     ORDER BY u.created_at DESC, u.id DESC
     LIMIT 101 OFFSET ?`,
    [parentId, offset]
  );

  const hasMore = rows.length > 100;
  const members = rows.slice(0, 100).map((row) => {
    const result = {
      ...row,
      phone: includePrivate ? row.phone : maskPhone(row.phone),
      has_children: Number(row.direct_referral_count) > 0
    };
    return takaFields(result, ['delivered_order_total', 'referral_commission_earned', 'referral_commission_pending']);
  });
  return { members, next_offset: hasMore ? offset + 100 : null };
}

const parseOffset = (value) => {
  const offset = value === undefined ? 0 : Number(value);
  return Number.isSafeInteger(offset) && offset >= 0 && offset <= 1000000 ? offset : null;
};

async function isDescendantOf(rootId, candidateId) {
  const row = await get(
    `WITH RECURSIVE descendants(id, depth) AS (
       SELECT id, 1 FROM users WHERE referred_by_id = ?
       UNION ALL
       SELECT u.id, d.depth + 1 FROM users u JOIN descendants d ON u.referred_by_id = d.id
       WHERE d.depth < 50
     )
     SELECT id FROM descendants WHERE id = ? LIMIT 1`,
    [rootId, candidateId]
  );
  return Boolean(row);
}

async function getMemberOrders(memberId, limit = 50) {
  const orders = await query(
    `SELECT id, order_number, status, subtotal_amount, discount_amount, delivery_fee,
            total_amount, referral_commission_amount, referral_credit_amount, created_at
     FROM orders
     WHERE customer_user_id = ?
     ORDER BY id DESC LIMIT ?`,
    [memberId, limit]
  );
  if (orders.length === 0) return [];
  const ids = orders.map((order) => order.id);
  const placeholders = ids.map(() => '?').join(',');
  const items = await query(
    `SELECT order_id, title, quantity FROM order_items WHERE order_id IN (${placeholders}) ORDER BY id`,
    ids
  );
  const itemsByOrder = new Map();
  for (const item of items) {
    const list = itemsByOrder.get(item.order_id) || [];
    list.push({ title: item.title, quantity: item.quantity });
    itemsByOrder.set(item.order_id, list);
  }
  return orders.map((order) => ({
    ...takaFields(order, ['subtotal_amount', 'discount_amount', 'delivery_fee', 'total_amount', 'referral_commission_amount', 'referral_credit_amount']),
    items: itemsByOrder.get(order.id) || []
  }));
}

userRouter.use(verifyToken, requireRole('customer', 'reseller'));

userRouter.get('/summary', async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await get('SELECT id, name, role, referral_code FROM users WHERE id = ?', [userId]);
    const direct = await get(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN role = 'customer' THEN 1 ELSE 0 END) AS customers,
              SUM(CASE WHEN role = 'reseller' THEN 1 ELSE 0 END) AS resellers
       FROM users WHERE referred_by_id = ?`,
      [userId]
    );
    const totalTeam = await get(
      `WITH RECURSIVE descendants(id, depth) AS (
         SELECT id, 1 FROM users WHERE referred_by_id = ?
         UNION ALL
         SELECT u.id, d.depth + 1 FROM users u JOIN descendants d ON u.referred_by_id = d.id
         WHERE d.depth < 50
       ) SELECT COUNT(*) AS total FROM descendants`,
      [userId]
    );
    const rewardRows = await get(
      `SELECT
         COALESCE(SUM(CASE WHEN type = 'referral_commission' AND status IN ('available', 'completed') THEN amount ELSE 0 END), 0) AS referral_earned,
         COALESCE(SUM(CASE WHEN type = 'referral_commission' AND status = 'pending' THEN amount ELSE 0 END), 0) AS referral_pending,
         COALESCE(SUM(CASE WHEN type = 'referral_credit' AND status IN ('available', 'completed') THEN amount ELSE 0 END), 0) AS credit_earned,
         COALESCE(SUM(CASE WHEN type = 'referral_credit' AND status = 'pending' THEN amount ELSE 0 END), 0) AS credit_pending,
         COALESCE(SUM(CASE WHEN type = 'referral_redemption' AND status = 'completed' THEN amount ELSE 0 END), 0) AS credit_used
       FROM wallet_transactions WHERE user_id = ?`,
      [userId]
    );
    const orderStats = await get(
      `SELECT COUNT(*) AS order_count,
              SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered_order_count,
              COALESCE(SUM(CASE WHEN status = 'delivered' THEN total_amount ELSE 0 END), 0) AS delivered_sales
       FROM orders WHERE referrer_user_id = ?`,
      [userId]
    );
    const settings = await get('SELECT is_enabled, customer_reward_bps, reseller_commission_bps FROM referral_settings WHERE id = 1');
    const creditAvailable = Math.max(0, Number(rewardRows.credit_earned || 0) - Number(rewardRows.credit_used || 0));

    return res.json({
      success: true,
      summary: {
        user_id: user.id,
        role: user.role,
        referral_code: user.referral_code,
        direct_count: Number(direct.total || 0),
        direct_customer_count: Number(direct.customers || 0),
        direct_reseller_count: Number(direct.resellers || 0),
        total_team_count: Number(totalTeam.total || 0),
        referral_order_count: Number(orderStats.order_count || 0),
        delivered_referral_order_count: Number(orderStats.delivered_order_count || 0),
        delivered_referral_sales: fromPaisa(orderStats.delivered_sales || 0),
        referral_commission_earned: fromPaisa(rewardRows.referral_earned || 0),
        referral_commission_pending: fromPaisa(rewardRows.referral_pending || 0),
        referral_credit_earned: fromPaisa(rewardRows.credit_earned || 0),
        referral_credit_pending: fromPaisa(rewardRows.credit_pending || 0),
        referral_credit_used: fromPaisa(rewardRows.credit_used || 0),
        referral_credit_available: fromPaisa(creditAvailable),
        program_enabled: Boolean(settings && settings.is_enabled),
        customer_reward_percent: settings ? settings.customer_reward_bps / 100 : 0,
        reseller_commission_percent: settings ? settings.reseller_commission_bps / 100 : 0
      }
    });
  } catch (error) {
    console.error('Referral Summary Error:', error);
    return res.status(500).json({ success: false, message: 'রেফারেল হিসাব লোড করা যায়নি' });
  }
});

userRouter.get('/tree', async (req, res) => {
  try {
    const requestedParentId = req.query.parent_id ? parseId(req.query.parent_id) : req.user.id;
    const offset = parseOffset(req.query.offset);
    if (!requestedParentId) return res.status(400).json({ success: false, message: 'সদস্য আইডি সঠিক নয়' });
    if (offset === null) return res.status(400).json({ success: false, message: 'তালিকার অবস্থান সঠিক নয়' });
    if (requestedParentId !== req.user.id && !(await isDescendantOf(req.user.id, requestedParentId))) {
      return res.status(403).json({ success: false, message: 'এই রেফারেল শাখা দেখার অনুমতি নেই' });
    }
    const branch = await getMemberChildren(requestedParentId, false, offset);
    return res.json({ success: true, parent_id: requestedParentId, ...branch });
  } catch (error) {
    console.error('Referral Tree Error:', error);
    return res.status(500).json({ success: false, message: 'রেফারেল গাছ লোড করা যায়নি' });
  }
});

userRouter.get('/members/:id/orders', async (req, res) => {
  try {
    const memberId = parseId(req.params.id);
    if (!memberId) return res.status(400).json({ success: false, message: 'সদস্য আইডি সঠিক নয়' });
    if (!(await isDescendantOf(req.user.id, memberId))) {
      return res.status(403).json({ success: false, message: 'এই সদস্যের অর্ডার দেখার অনুমতি নেই' });
    }
    const orders = await getMemberOrders(memberId);
    return res.json({ success: true, orders });
  } catch (error) {
    console.error('Referral Member Orders Error:', error);
    return res.status(500).json({ success: false, message: 'সদস্যের অর্ডার লোড করা যায়নি' });
  }
});

adminRouter.use(verifyToken, requireRole('admin'));

adminRouter.get('/settings', async (req, res) => {
  try {
    const settings = await get('SELECT is_enabled, customer_reward_bps, reseller_commission_bps, updated_at FROM referral_settings WHERE id = 1');
    return res.json({
      success: true,
      settings: {
        is_enabled: Boolean(settings.is_enabled),
        customer_reward_percent: settings.customer_reward_bps / 100,
        reseller_commission_percent: settings.reseller_commission_bps / 100,
        updated_at: settings.updated_at
      }
    });
  } catch (error) {
    console.error('Referral Settings Read Error:', error);
    return res.status(500).json({ success: false, message: 'রেফারেল সেটিংস লোড করা যায়নি' });
  }
});

adminRouter.put('/settings', async (req, res) => {
  try {
    const enabled = req.body && req.body.is_enabled;
    const customerPercent = Number(req.body && req.body.customer_reward_percent);
    const resellerPercent = Number(req.body && req.body.reseller_commission_percent);
    const validPercent = (value) => Number.isFinite(value) && value >= 0 && value <= 50;
    if (typeof enabled !== 'boolean' || !validPercent(customerPercent) || !validPercent(resellerPercent)) {
      return res.status(400).json({ success: false, message: 'সক্রিয় অবস্থা ও ০% থেকে ৫০% এর মধ্যে সঠিক কমিশন দিন' });
    }
    await run(
      `UPDATE referral_settings
       SET is_enabled = ?, customer_reward_bps = ?, reseller_commission_bps = ?,
           updated_by_admin_id = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = 1`,
      [enabled ? 1 : 0, Math.round(customerPercent * 100), Math.round(resellerPercent * 100), req.user.id]
    );
    return res.json({ success: true, message: 'রেফারেল নিয়ম সংরক্ষণ হয়েছে' });
  } catch (error) {
    console.error('Referral Settings Update Error:', error);
    return res.status(500).json({ success: false, message: 'রেফারেল সেটিংস সংরক্ষণ করা যায়নি' });
  }
});

adminRouter.get('/tree', async (req, res) => {
  try {
    const parentId = req.query.parent_id ? parseId(req.query.parent_id) : null;
    const offset = parseOffset(req.query.offset);
    if (req.query.parent_id && !parentId) return res.status(400).json({ success: false, message: 'সদস্য আইডি সঠিক নয়' });
    if (offset === null) return res.status(400).json({ success: false, message: 'তালিকার অবস্থান সঠিক নয়' });
    const branch = parentId
      ? await getMemberChildren(parentId, true, offset)
      : await query(
        `SELECT u.id, u.name, u.phone, u.role, u.referral_code, u.created_at,
                (SELECT COUNT(*) FROM users c WHERE c.referred_by_id = u.id) AS direct_referral_count,
                (SELECT COUNT(*) FROM users c WHERE c.referred_by_id = u.id AND c.role = 'customer') AS direct_customer_count,
                (SELECT COUNT(*) FROM users c WHERE c.referred_by_id = u.id AND c.role = 'reseller') AS direct_reseller_count,
                COUNT(DISTINCT CASE WHEN o.status = 'delivered' THEN o.id END) AS delivered_order_count,
                COALESCE(SUM(CASE WHEN o.status = 'delivered' THEN o.total_amount ELSE 0 END), 0) AS delivered_order_total,
                COALESCE((SELECT SUM(oi.quantity) FROM order_items oi JOIN orders io ON io.id = oi.order_id
                          WHERE io.customer_user_id = u.id AND io.status = 'delivered'), 0) AS delivered_units,
                COALESCE((SELECT SUM(w.amount) FROM wallet_transactions w
                          WHERE w.user_id = u.id AND w.type = 'referral_commission' AND w.status IN ('available', 'completed')), 0) AS referral_commission_earned,
                COALESCE((SELECT SUM(w.amount) FROM wallet_transactions w
                          WHERE w.user_id = u.id AND w.type = 'referral_commission' AND w.status = 'pending'), 0) AS referral_commission_pending
         FROM users u LEFT JOIN orders o ON o.customer_user_id = u.id
         WHERE u.referred_by_id IS NULL
         GROUP BY u.id ORDER BY u.created_at DESC, u.id DESC LIMIT 101 OFFSET ?`,
        [offset]
      );
    const rootRows = Array.isArray(branch) ? branch : branch.members;
    const hasMore = Array.isArray(branch) && rootRows.length > 100;
    const formatted = (hasMore ? rootRows.slice(0, 100) : rootRows).map((row) => ({
      ...row,
      has_children: Number(row.direct_referral_count) > 0,
      ...takaFields(row, ['delivered_order_total', 'referral_commission_earned', 'referral_commission_pending'])
    }));
    return res.json({
      success: true,
      parent_id: parentId,
      members: formatted,
      next_offset: Array.isArray(branch) ? (hasMore ? offset + 100 : null) : branch.next_offset
    });
  } catch (error) {
    console.error('Admin Referral Tree Error:', error);
    return res.status(500).json({ success: false, message: 'রেফারেল গাছ লোড করা যায়নি' });
  }
});

adminRouter.get('/search', async (req, res) => {
  try {
    const term = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
    if (term.length < 2) return res.json({ success: true, members: [] });
    const wild = `%${term}%`;
    const members = await query(
      `SELECT id, name, phone, role, referral_code, referred_by_id
       FROM users WHERE name LIKE ? OR phone LIKE ? OR referral_code LIKE ?
       ORDER BY id DESC LIMIT 25`,
      [wild, wild, wild]
    );
    return res.json({ success: true, members });
  } catch (error) {
    console.error('Admin Referral Search Error:', error);
    return res.status(500).json({ success: false, message: 'সদস্য খোঁজা যায়নি' });
  }
});

adminRouter.get('/members/:id', async (req, res) => {
  try {
    const memberId = parseId(req.params.id);
    if (!memberId) return res.status(400).json({ success: false, message: 'সদস্য আইডি সঠিক নয়' });
    const member = await get(
      `SELECT u.id, u.name, u.phone, u.role, u.referral_code, u.created_at,
              r.id AS referrer_id, r.name AS referrer_name, r.role AS referrer_role
       FROM users u LEFT JOIN users r ON r.id = u.referred_by_id WHERE u.id = ?`,
      [memberId]
    );
    if (!member) return res.status(404).json({ success: false, message: 'সদস্য পাওয়া যায়নি' });
    const [counts, orders, rewards] = await Promise.all([
      get(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN role = 'customer' THEN 1 ELSE 0 END) AS customers,
                SUM(CASE WHEN role = 'reseller' THEN 1 ELSE 0 END) AS resellers
         FROM users WHERE referred_by_id = ?`, [memberId]
      ),
      get(
        `SELECT COUNT(*) AS total_orders,
                SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered_orders,
                COALESCE(SUM(CASE WHEN status = 'delivered' THEN total_amount ELSE 0 END), 0) AS delivered_sales
         FROM orders WHERE customer_user_id = ?`, [memberId]
      ),
      get(
        `SELECT COALESCE(SUM(CASE WHEN type = 'referral_commission' AND status IN ('available','completed') THEN amount ELSE 0 END),0) AS earned,
                COALESCE(SUM(CASE WHEN type = 'referral_commission' AND status = 'pending' THEN amount ELSE 0 END),0) AS pending,
                COALESCE(SUM(CASE WHEN type = 'referral_credit' AND status IN ('available','completed') THEN amount ELSE 0 END),0) AS credit_earned,
                COALESCE(SUM(CASE WHEN type = 'referral_credit' AND status = 'pending' THEN amount ELSE 0 END),0) AS credit_pending,
                COALESCE(SUM(CASE WHEN type = 'referral_redemption' AND status = 'completed' THEN amount ELSE 0 END),0) AS credit_used
         FROM wallet_transactions WHERE user_id = ?`, [memberId]
      )
    ]);
    const descendants = await get(
      `WITH RECURSIVE d(id, depth) AS (
         SELECT id, 1 FROM users WHERE referred_by_id = ?
         UNION ALL SELECT u.id, d.depth + 1 FROM users u JOIN d ON u.referred_by_id = d.id WHERE d.depth < 50
       ) SELECT COUNT(*) AS total FROM d`, [memberId]
    );
    return res.json({
      success: true,
      member: {
        ...member,
        direct_referrals: Number(counts.total || 0),
        direct_customers: Number(counts.customers || 0),
        direct_resellers: Number(counts.resellers || 0),
        total_team_count: Number(descendants.total || 0),
        total_orders: Number(orders.total_orders || 0),
        delivered_orders: Number(orders.delivered_orders || 0),
        delivered_sales: fromPaisa(orders.delivered_sales || 0),
        referral_commission_earned: fromPaisa(rewards.earned || 0),
        referral_commission_pending: fromPaisa(rewards.pending || 0),
        referral_credit_earned: fromPaisa(rewards.credit_earned || 0),
        referral_credit_pending: fromPaisa(rewards.credit_pending || 0),
        referral_credit_used: fromPaisa(rewards.credit_used || 0),
        referral_credit_available: fromPaisa(Math.max(0, Number(rewards.credit_earned || 0) - Number(rewards.credit_used || 0)))
      }
    });
  } catch (error) {
    console.error('Admin Referral Member Error:', error);
    return res.status(500).json({ success: false, message: 'সদস্যের তথ্য লোড করা যায়নি' });
  }
});

adminRouter.get('/members/:id/orders', async (req, res) => {
  try {
    const memberId = parseId(req.params.id);
    if (!memberId) return res.status(400).json({ success: false, message: 'সদস্য আইডি সঠিক নয়' });
    const orders = await getMemberOrders(memberId);
    return res.json({ success: true, orders });
  } catch (error) {
    console.error('Admin Referral Member Orders Error:', error);
    return res.status(500).json({ success: false, message: 'সদস্যের অর্ডার লোড করা যায়নি' });
  }
});

module.exports = { userRouter, adminRouter };
