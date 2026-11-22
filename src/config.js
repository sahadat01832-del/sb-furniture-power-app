require('dotenv').config();
const path = require('path');

module.exports = {
  PORT: process.env.PORT || 3000,
  NODE_ENV: process.env.NODE_ENV || 'development',
  JWT_SECRET: process.env.JWT_SECRET || 'sb_furniture_power_jwt_secret_key_secure_2026',
  DATABASE_FILE: process.env.DATABASE_FILE || path.join(__dirname, '..', 'data', 'database.sqlite'),
  
  // Brand Contacts & Info
  SB_FURNITURE: {
    brand_name: 'SB Furniture (এসবি ফার্নিচার)',
    proprietor: 'আ: ছাত্তার (A. Sattar)',
    experience: '১৫ বছরের সরাসরি কারখানায় উৎপাদনের অভিজ্ঞতা',
    location: 'বাঙাল হাওলা, কালীগঞ্জ, গাজীপুর (Bangal Hawla, Kaliganj, Gazipur)',
    phone: '01929621855',
    trust_line: '১৫ বছরের অভিজ্ঞতায় সরাসরি কারখানা থেকে পাইকারি ও সাশ্রয়ী দামে তৈরি করে দেওয়া হয়।'
  },

  SB_POWER: {
    brand_name: 'SB POWER',
    phone: '01634664224',
    tiktok: '@sb.power.official',
    positioning: 'সাশ্রয়ী মূল্যে ওয়্যারলেস অডিও ও ট্রেন্ডিং টেক গ্যাজেটের জন্য বোল্ড ও হাই-ভ্যালু বাংলাদেশি অনলাইন স্টোর'
  },

  // Referral & Commission Rules
  REFERRAL: {
    FIRST_SALE_BONUS: 50, // 50 TK bonus to referrer on downline's first delivered order
    LIFETIME_COMMISSION_PERCENT: 3, // 3% team bonus on subsequent delivered orders
    MIN_CASHOUT_AMOUNT: 100 // Minimum 100 TK balance to request withdrawal
  },

  // Delivery Fees
  DELIVERY: {
    INSIDE_DHAKA_FURNITURE: 500,
    OUTSIDE_DHAKA_FURNITURE: 1000,
    INSIDE_DHAKA_GADGET: 80,
    OUTSIDE_DHAKA_GADGET: 150
  },

  ADMIN: {
    phone: process.env.ADMIN_PHONE || '01929621855',
    password: process.env.ADMIN_PASSWORD || 'admin123456',
    name: 'SB Admin'
  }
};
