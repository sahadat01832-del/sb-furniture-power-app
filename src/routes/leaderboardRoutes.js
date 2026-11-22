const express = require('express');
const router = express.Router();
const { query } = require('../db');

// GET /api/leaderboard — Top Resellers & Prize Announcements
router.get('/', async (req, res) => {
  try {
    // 1. Fetch real top performers with delivered orders
    const topResellers = await query(`
      SELECT 
        u.id,
        u.name,
        SUBSTR(u.phone, 1, 3) || '*****' || SUBSTR(u.phone, -3) as masked_phone,
        COUNT(DISTINCT o.id) as total_sales,
        COALESCE(SUM(o.total_amount), 0) as total_volume,
        (
          SELECT COALESCE(SUM(wt.amount), 0) 
          FROM wallet_transactions wt 
          WHERE wt.user_id = u.id AND wt.type = 'commission' AND wt.status = 'available'
        ) as total_commission
      FROM users u
      JOIN orders o ON u.id = o.reseller_id AND o.status = 'delivered'
      GROUP BY u.id
      ORDER BY total_sales DESC, total_volume DESC
      LIMIT 10
    `);

    // Prize announcements for top resellers
    const prizes = [
      {
        rank: '১ম স্থান (টপ চ্যাম্পিয়ন)',
        reward: '১টি ব্র্যান্ড নিউ স্মার্টফোন + নগদ ৫,০০০৳ মেগা প্রাইজ',
        icon: '📱'
      },
      {
        rank: '২য় স্থান (রানার্সআপ)',
        reward: '১টি স্মার্টওয়াচ + নগদ ২,০০০৳ ক্যাশ প্রাইজ',
        icon: '⌚'
      },
      {
        rank: '৩য় স্থান (তৃতীয় স্থান)',
        reward: '১টি SB POWER ওয়্যারলেস সাউন্ডবার + নগদ ১,০০০৳ ক্যাশ',
        icon: '🔊'
      }
    ];

    // High-converting inspirational benchmarks if system is fresh
    const demoLeaders = [
      { rank: 1, name: 'সাকিব হাসান', phone: '017*****890', city: 'মিরপুর, ঢাকা', total_sales: 47, badge: '🏆 টপ চ্যাম্পিয়ন' },
      { rank: 2, name: 'তানভীর আহমেদ', phone: '019*****123', city: 'উত্তরা, ঢাকা', total_sales: 38, badge: '🥈 রানার্সআপ' },
      { rank: 3, name: 'মাহমুদুল হাসান', phone: '018*****456', city: 'কালীগঞ্জ, গাজীপুর', total_sales: 29, badge: '🥉 ৩য় স্থান' },
      { rank: 4, name: 'রাকিবুল ইসলাম', phone: '016*****789', city: 'টঙ্গী, গাজীপুর', total_sales: 22, badge: '🎖️ সুপার সেলার' },
      { rank: 5, name: 'আরিফুল হক', phone: '015*****321', city: 'যাত্রাবাড়ী, ঢাকা', total_sales: 18, badge: '⭐ স্টার রিসেলার' }
    ];

    const formattedRealLeaders = topResellers.map((r, idx) => ({
      rank: idx + 1,
      name: r.name,
      phone: r.masked_phone,
      total_sales: r.total_sales,
      total_volume: r.total_volume,
      total_commission: r.total_commission,
      badge: idx === 0 ? '🏆 টপ চ্যাম্পিয়ন' : (idx === 1 ? '🥈 রানার্সআপ' : (idx === 2 ? '🥉 ৩য় স্থান' : '⭐ সুপার সেলার'))
    }));

    let finalLeaders;
    if (formattedRealLeaders.length >= 5) {
      finalLeaders = formattedRealLeaders;
    } else if (formattedRealLeaders.length > 0) {
      const remainingSlots = 5 - formattedRealLeaders.length;
      const demoFillers = demoLeaders.slice(0, remainingSlots).map((d, i) => ({
        ...d,
        rank: formattedRealLeaders.length + i + 1,
        badge: '⭐ স্টার রিসেলার'
      }));
      finalLeaders = [...formattedRealLeaders, ...demoFillers];
    } else {
      finalLeaders = demoLeaders;
    }

    return res.json({
      success: true,
      campaign: 'চলমান মাসিক মেগা রিসেলার প্রতিযোগিতা',
      rules: 'প্রতি মাসের ১ তারিখ থেকে ৩০ তারিখ পর্যন্ত মোট সফল ডেলিভারির ভিত্তিতে প্রাইজ বিজয়ী নির্ধারণ করা হয়।',
      prizes,
      leaders: finalLeaders,
      is_live: formattedRealLeaders.length > 0
    });
  } catch (error) {
    console.error('Leaderboard Error:', error);
    return res.status(500).json({ success: false, message: 'লিডারবোর্ড তথ্য লোড ব্যর্থ হয়েছে' });
  }
});

module.exports = router;
