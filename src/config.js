require('dotenv').config();
const path = require('path');

const NODE_ENV = process.env.NODE_ENV || 'development';
const isProduction = NODE_ENV === 'production';
const configuredJwtSecret = process.env.JWT_SECRET && process.env.JWT_SECRET.trim();
const configuredAdminPhone = process.env.ADMIN_PHONE && process.env.ADMIN_PHONE.trim();
const configuredAdminPassword = process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD.trim();
const configuredPort = Number(process.env.PORT || 3000);
const rawCorsOrigins = [process.env.CORS_ORIGIN || '', process.env.CORS_ORIGINS || '']
  .join(',')
  .split(',')
  .map((origin) => origin.trim().replace(/\/$/, ''))
  .filter(Boolean);
const invalidCorsOrigin = rawCorsOrigins.find((origin) => {
  if (origin === 'capacitor://localhost') return false;
  try {
    const parsed = new URL(origin);
    const isLocalOrigin = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
    const allowedProtocol = parsed.protocol === 'https:' || (isLocalOrigin && parsed.protocol === 'http:');
    return !allowedProtocol || parsed.username !== '' || parsed.password !== '' ||
      parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '' || parsed.origin !== origin;
  } catch (error) {
    return true;
  }
});

if (!Number.isInteger(configuredPort) || configuredPort < 1 || configuredPort > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}

if (!configuredJwtSecret || configuredJwtSecret.length < 32) {
  throw new Error('Set JWT_SECRET to a random value with at least 32 characters.');
}

if (isProduction) {
  if (!configuredAdminPhone || !/^01[3-9]\d{8}$/.test(configuredAdminPhone) || !configuredAdminPassword || Buffer.byteLength(configuredAdminPassword, 'utf8') < 12 || Buffer.byteLength(configuredAdminPassword, 'utf8') > 72) {
    throw new Error('Production requires ADMIN_PHONE and a unique ADMIN_PASSWORD with at least 12 characters.');
  }
  if (rawCorsOrigins.length === 0) {
    throw new Error('Production requires CORS_ORIGIN or CORS_ORIGINS with an explicit site origin.');
  }
}
if (invalidCorsOrigin) {
  throw new Error('CORS_ORIGIN(S) must contain exact HTTPS site origins, localhost development origins, or capacitor://localhost.');
}

const corsOrigins = new Set(rawCorsOrigins);
if (!isProduction) {
  [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost',
    'https://localhost',
    'capacitor://localhost'
  ].forEach((origin) => corsOrigins.add(origin));
}

module.exports = {
  PORT: configuredPort,
  NODE_ENV,
  JWT_SECRET: configuredJwtSecret,
  CORS_ORIGINS: [...corsOrigins],
  DATABASE_FILE: process.env.DATABASE_FILE || path.join(__dirname, '..', 'data', 'database.sqlite'),
  
  // Brand Contacts & Info
  SB_FURNITURE: {
    brand_name: 'SB Furniture (এসবি ফার্নিচার)',
    proprietor: 'আ: ছাত্তার (A. Sattar)',
    location: 'বাঙাল হাওলা, কালীগঞ্জ, গাজীপুর (Bangal Hawla, Kaliganj, Gazipur)',
    phone: '01929621855',
    trust_line: 'SB Furniture-এর ফার্নিচার ও দোকান সাজানোর পণ্য।'
  },

  SB_POWER: {
    brand_name: 'SB POWER',
    phone: '01634664224',
    tiktok: '@sb.power.official',
    positioning: 'সাশ্রয়ী মূল্যে ওয়্যারলেস অডিও ও ট্রেন্ডিং টেক গ্যাজেটের জন্য বোল্ড ও হাই-ভ্যালু বাংলাদেশি অনলাইন স্টোর'
  },

  // Reseller Payout Rules
  REFERRAL: {
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
    phone: configuredAdminPhone || null,
    password: configuredAdminPassword || null,
    name: 'SB Admin'
  }
};
