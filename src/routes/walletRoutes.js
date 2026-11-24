const express = require('express');
const router = express.Router();
const { query, get, run, withTransaction } = require('../db');
const { verifyToken, requireRole } = require('../auth');
const config = require('../config');
const { toPaisa, fromPaisa, takaFields } = require('../money');

router.use(verifyToken, requireRole('reseller', 'admin'));

// Helper to compute user balance with comprehensive breakdown
const computeBalances = async (userId) => {
  // Total earned commissions & bonuses
  const earnedRow = await get(
    `SELECT COALESCE(SUM(amount), 0) as total 
     FROM wallet_transactions 
     WHERE user_id = ? AND status IN ('available', 'completed') AND type IN ('commission', 'referral_commission', 'referral_bonus', 'team_bonus')`,
    [userId]
  );
  const totalEarned = earnedRow ? earnedRow.total : 0;

  // Breakdown: commissions
  const commRow = await get(
    `SELECT COALESCE(SUM(amount), 0) as total 
     FROM wallet_transactions 
     WHERE user_id = ? AND status IN ('available', 'completed') AND type = 'commission'`,
    [userId]
  );
  const commissionEarned = commRow ? commRow.total : 0;

  // Historical invite bonuses are preserved; no new invite bonuses are issued.
  const refBonusRow = await get(
    `SELECT COALESCE(SUM(amount), 0) as total 
     FROM wallet_transactions 
     WHERE user_id = ? AND status IN ('available', 'completed') AND type = 'referral_bonus'`,
    [userId]
  );
  const firstSaleBonusEarned = refBonusRow ? refBonusRow.total : 0;

  // Historical team bonuses are preserved; no new team bonuses are issued.
  const teamBonusRow = await get(
    `SELECT COALESCE(SUM(amount), 0) as total 
     FROM wallet_transactions 
     WHERE user_id = ? AND status IN ('available', 'completed') AND type = 'team_bonus'`,
    [userId]
  );
  const teamBonusEarned = teamBonusRow ? teamBonusRow.total : 0;

  // Pending commissions
  const pendingRow = await get(
    `SELECT COALESCE(SUM(amount), 0) as total 
     FROM wallet_transactions 
     WHERE user_id = ? AND status = 'pending' AND type = 'commission'`,
    [userId]
  );
  const pendingCommission = pendingRow ? pendingRow.total : 0;

  const referralCommissionRow = await get(
    `SELECT COALESCE(SUM(amount), 0) as total
     FROM wallet_transactions
     WHERE user_id = ? AND status IN ('available', 'completed') AND type = 'referral_commission'`,
    [userId]
  );
  const pendingReferralCommissionRow = await get(
    `SELECT COALESCE(SUM(amount), 0) as total
     FROM wallet_transactions
     WHERE user_id = ? AND status = 'pending' AND type = 'referral_commission'`,
    [userId]
  );

  // Debited/Requested Payouts
  const payoutRow = await get(
    `SELECT COALESCE(SUM(amount), 0) as total 
     FROM wallet_transactions 
     WHERE user_id = ? AND type = 'payout' AND status IN ('pending', 'approved', 'completed')`,
    [userId]
  );
  const totalPayoutCommitted = payoutRow ? payoutRow.total : 0;

  // Approved Payouts
  const approvedPayoutRow = await get(
    `SELECT COALESCE(SUM(amount), 0) as total 
     FROM payout_requests 
     WHERE user_id = ? AND status = 'approved'`,
    [userId]
  );
  const totalWithdrawn = approvedPayoutRow ? approvedPayoutRow.total : 0;

  const availableBalance = Math.max(0, totalEarned - totalPayoutCommitted);

  return {
    availableBalance,
    pendingCommission,
    totalEarned,
    totalWithdrawn,
    commissionEarned,
    referralCommissionEarned: referralCommissionRow ? referralCommissionRow.total : 0,
    pendingReferralCommission: pendingReferralCommissionRow ? pendingReferralCommissionRow.total : 0,
    firstSaleBonusEarned,
    teamBonusEarned
  };
};

// Reseller wallet summary
router.get('/summary', verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const balances = await computeBalances(userId);

    // Downline stats
    const refCountRow = await get(
      'SELECT COUNT(*) as count FROM users WHERE referred_by_id = ?',
      [userId]
    );

    // User referral code
    const user = await get('SELECT referral_code, phone FROM users WHERE id = ?', [userId]);

    return res.json({
      success: true,
      summary: {
        available_balance: fromPaisa(balances.availableBalance),
        pending_commission: fromPaisa(balances.pendingCommission),
        total_earned: fromPaisa(balances.totalEarned),
        total_withdrawn: fromPaisa(balances.totalWithdrawn),
        commission_earned: fromPaisa(balances.commissionEarned),
        referral_commission_earned: fromPaisa(balances.referralCommissionEarned),
        pending_referral_commission: fromPaisa(balances.pendingReferralCommission),
        first_sale_bonus: fromPaisa(balances.firstSaleBonusEarned),
        team_bonus: fromPaisa(balances.teamBonusEarned),
        referred_count: refCountRow ? refCountRow.count : 0,
        referral_code: user.referral_code,
        min_cashout: config.REFERRAL.MIN_CASHOUT_AMOUNT
      }
    });
  } catch (error) {
    console.error('Wallet Summary Error:', error);
    return res.status(500).json({ success: false, message: 'ওয়ালেট তথ্য লোড করতে ব্যর্থ হয়েছে' });
  }
});

// Downline team members list
router.get('/downline', verifyToken, async (req, res) => {
  try {
    const team = await query(
      `SELECT 
        u.id, 
        u.name, 
        SUBSTR(u.phone, 1, 3) || '*****' || SUBSTR(u.phone, -3) as masked_phone,
        u.created_at,
        (SELECT COUNT(*) FROM orders WHERE reseller_id = u.id AND status = 'delivered') as delivered_orders_count,
        (SELECT COALESCE(SUM(total_amount), 0) FROM orders WHERE reseller_id = u.id AND status = 'delivered') as total_sales_volume
      FROM users u 
      WHERE u.referred_by_id = ? 
      ORDER BY u.id DESC`,
      [req.user.id]
    );

    return res.json({
      success: true,
      count: team.length,
      team: team.map((member) => takaFields(member, ['total_sales_volume']))
    });
  } catch (error) {
    console.error('Downline Fetch Error:', error);
    return res.status(500).json({ success: false, message: 'টিম মেম্বার লোড করতে ব্যর্থ হয়েছে' });
  }
});

// Reseller transactions list
router.get('/transactions', verifyToken, async (req, res) => {
  try {
    const transactions = await query(
      `SELECT * FROM wallet_transactions 
       WHERE user_id = ? 
       ORDER BY id DESC LIMIT 50`,
      [req.user.id]
    );

    return res.json({
      success: true,
      transactions: transactions.map((transaction) => takaFields(transaction, ['amount']))
    });
  } catch (error) {
    console.error('Transactions Error:', error);
    return res.status(500).json({ success: false, message: 'লেনদেন হিস্ট্রি লোড করতে ব্যর্থ হয়েছে' });
  }
});

// Payout request (Cashout) with duplicate prevention and atomic transaction
router.post('/payout-request', verifyToken, async (req, res) => {
  try {
    const { amount, payment_method, account_number } = req.body;
    const parsedAmount = toPaisa(amount);
    const minCashoutPaisa = toPaisa(config.REFERRAL.MIN_CASHOUT_AMOUNT);

    if (parsedAmount === null || parsedAmount < minCashoutPaisa) {
      return res.status(400).json({
        success: false,
        message: `ন্যূনতম ক্যাশআউট পরিমাণ ${config.REFERRAL.MIN_CASHOUT_AMOUNT} টাকা হতে হবে`
      });
    }

    if (!payment_method || !['bkash', 'nagad', 'rocket'].includes(payment_method)) {
      return res.status(400).json({
        success: false,
        message: 'সঠিক পেমেন্ট মেথড (bKash, Nagad, Rocket) নির্বাচন করুন'
      });
    }

    const cleanAccountNumber = typeof account_number === 'string'
      ? account_number.trim().replace(/\s+/g, '')
      : '';
    if (!/^01[3-9]\d{8}$/.test(cleanAccountNumber)) {
      return res.status(400).json({
        success: false,
        message: 'সঠিক ১১ ডিজিটের বিকাশ/নগদ/রকেট মোবাইল নম্বর দিন'
      });
    }

    // Check balance
    const balances = await computeBalances(req.user.id);
    if (parsedAmount > balances.availableBalance) {
      return res.status(400).json({
        success: false,
        message: `পর্যাপ্ত ব্যালেন্স নেই। আপনার উত্তোলনযোগ্য ব্যালেন্স: ${fromPaisa(balances.availableBalance)} টাকা`
      });
    }

    // Duplicate prevention: If an idempotency key is provided, prevent duplicate submissions
    const idempotencyKey = req.headers['idempotency-key'] || req.body.idempotency_key;
    if (idempotencyKey && (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey))) {
      return res.status(400).json({ success: false, message: 'রিকোয়েস্ট আইডি সঠিক নয়' });
    }

    // Execute atomically
    const { payoutId } = await withTransaction(async ({ run: txRun }) => {
      if (idempotencyKey) {
        const existingKey = await get(
          "SELECT id FROM wallet_transactions WHERE user_id = ? AND notes LIKE ?",
          [req.user.id, `%[IDEMP:${idempotencyKey}]%`]
        );
        if (existingKey) {
          const duplicateError = new Error('একই রিকোয়েস্ট ইতিমধ্যে গ্রহণ করা হয়েছে (ডুপ্লিকেট রিকোয়েস্ট রোধ)');
          duplicateError.statusCode = 409;
          throw duplicateError;
        }
      }

      const balancesInTransaction = await computeBalances(req.user.id);
      if (parsedAmount > balancesInTransaction.availableBalance) {
        const balanceError = new Error(`পর্যাপ্ত ব্যালেন্স নেই। আপনার উত্তোলনযোগ্য ব্যালেন্স: ${fromPaisa(balancesInTransaction.availableBalance)} টাকা`);
        balanceError.statusCode = 400;
        throw balanceError;
      }

      // Insert payout request
      const payoutResult = await txRun(
        `INSERT INTO payout_requests (
          user_id, amount, payment_method, account_number, status
        ) VALUES (?, ?, ?, ?, 'pending')`,
        [req.user.id, parsedAmount, payment_method, cleanAccountNumber]
      );

      // Insert wallet transaction record with payout_id reference
      const txNote = `${payment_method.toUpperCase()} নম্বর ${cleanAccountNumber}-এ ক্যাশআউট রিকোয়েস্ট${idempotencyKey ? ' [IDEMP:' + idempotencyKey + ']' : ''}`;
      await txRun(
        `INSERT INTO wallet_transactions (
          user_id, payout_id, amount, type, status, notes
        ) VALUES (?, ?, ?, 'payout', 'pending', ?)`,
        [
          req.user.id,
          payoutResult.lastID,
          parsedAmount,
          txNote
        ]
      );

      return { payoutId: payoutResult.lastID };
    });

    return res.status(201).json({
      success: true,
      message: 'ক্যাশআউট রিকোয়েস্ট সফলভাবে জমা হয়েছে! অ্যাডমিন অনুমোদনের পর টাকা পাঠানো হবে।',
      payout_id: payoutId
    });
  } catch (error) {
    if (error.statusCode === 400 || error.statusCode === 409) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    console.error('Payout Request Error:', error);
    return res.status(500).json({ success: false, message: 'ক্যাশআউট রিকোয়েস্ট ব্যর্থ হয়েছে' });
  }
});

module.exports = router;
