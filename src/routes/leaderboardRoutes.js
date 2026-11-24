const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { takaFields } = require('../money');

// GET /api/leaderboard — real reseller sales from delivered orders only.
router.get('/', async (req, res) => {
  try {
    const topResellers = await query(`
      SELECT
        u.id,
        u.name,
        SUBSTR(u.phone, 1, 3) || '*****' || SUBSTR(u.phone, -3) as masked_phone,
        COUNT(DISTINCT o.id) as total_sales,
        COALESCE(SUM(o.total_amount), 0) as total_volume,
        COALESCE((
          SELECT SUM(wt.amount)
          FROM wallet_transactions wt
          WHERE wt.user_id = u.id
            AND wt.type = 'commission'
            AND wt.status IN ('available', 'completed')
        ), 0) as total_commission
      FROM users u
      JOIN orders o ON u.id = o.reseller_id AND o.status = 'delivered'
      GROUP BY u.id
      ORDER BY total_sales DESC, total_volume DESC
      LIMIT 10
    `);

    const leaders = topResellers.map((reseller, index) => ({
      rank: index + 1,
      name: reseller.name,
      phone: reseller.masked_phone,
      total_sales: reseller.total_sales,
      total_volume: takaFields(reseller, ['total_volume']).total_volume,
      total_commission: takaFields(reseller, ['total_commission']).total_commission,
      // Converted from paisa above; both fields stay taka in the response.
      badge: index === 0 ? '🏆 শীর্ষ রিসেলার' : 'সক্রিয় রিসেলার'
    }));

    return res.json({
      success: true,
      campaign: 'সফল অর্ডারের ভিত্তিতে রিসেলার তালিকা',
      rules: 'শুধু delivered অর্ডারের বাস্তব তথ্য এখানে দেখানো হয়।',
      leaders,
      is_live: leaders.length > 0
    });
  } catch (error) {
    console.error('Leaderboard Error:', error);
    return res.status(500).json({ success: false, message: 'লিডারবোর্ড তথ্য লোড ব্যর্থ হয়েছে' });
  }
});

module.exports = router;
