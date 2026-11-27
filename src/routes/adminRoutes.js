const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { query, get, run, withTransaction } = require('../db');
const { verifyToken, requireRole } = require('../auth');
const config = require('../config');
const { toPaisa, fromPaisa, takaFields } = require('../money');
const {
  estimateFurniturePartsAndBoards,
  inspectProductImageWithAi,
  generateProductCopyFromKeywords,
  generateMultiChannelMarketingCopy
} = require('../services/aiRouter');
const { calculateCutlist, DEFAULT_BOARD_PRICE } = require('../services/cutlistCalculator');
const { getBoardPriceTaka, setBoardPriceTaka } = require('../services/shopSettings');

const PRODUCT_MONEY_FIELDS = ['regular_price', 'reseller_commission', 'wholesale_price'];
const ORDER_MONEY_FIELDS = ['subtotal_amount', 'delivery_fee', 'total_amount', 'advance_paid', 'discount_amount', 'reseller_commission', 'total_wholesale_amount', 'total_reseller_commission', 'referral_commission_amount', 'referral_credit_amount', 'platform_net_profit'];
const ITEM_MONEY_FIELDS = ['unit_price', 'commission_per_unit', 'total_price', 'unit_wholesale_price', 'unit_selling_price', 'unit_commission', 'platform_net_profit'];

const productToClient = (product) => {
  if (!product) return product;
  const converted = takaFields(product, PRODUCT_MONEY_FIELDS);
  converted.platform_net_profit = Math.max(0, (converted.regular_price || 0) - (converted.wholesale_price || 0) - (converted.reseller_commission || 0));
  if (converted.furniture_cutlist && typeof converted.furniture_cutlist === 'string') {
    try {
      converted.furniture_cutlist = JSON.parse(converted.furniture_cutlist);
    } catch (e) {
      // Keep as string if parsing fails
    }
  }
  return converted;
};
const orderToClient = (order) => {
  if (!order) return order;
  const converted = takaFields(order, ORDER_MONEY_FIELDS);
  if (Array.isArray(order.items)) {
    converted.items = order.items.map((item) => takaFields(item, ITEM_MONEY_FIELDS));
  }
  return converted;
};

const PRODUCT_DEFAULT_IMAGE = 'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?auto=format&fit=crop&w=800&q=80';
const PRODUCT_BRANDS = new Set(['SB Furniture', 'SB POWER', 'SB Lifestyle & Tools']);
const COMMISSION_TABS = new Set(['50tk', '100tk', '200tk', '500tk', '1000tk', '1500tk']);

function resolveCommissionTab(commissionTaka) {
  const comm = Number(commissionTaka) || 0;
  if (comm >= 1500) return '1500tk';
  if (comm >= 1000) return '1000tk';
  if (comm >= 500) return '500tk';
  if (comm >= 200) return '200tk';
  if (comm >= 100) return '100tk';
  return '50tk';
}

const MAX_CUTLIST_PARTS = 200;

// The board count and board cost are money, so they are always rebuilt from the
// parts on save: a stale or hand-edited total from the browser must not become
// the product's cost basis. Returns the JSON string stored in the database.
function recomputeFurnitureCutlist(input, shopBoardPrice) {
  if (input === undefined || input === null) return null;

  let cutlist = input;
  if (typeof cutlist === 'string') {
    try {
      cutlist = JSON.parse(cutlist);
    } catch (e) {
      return null;
    }
  }
  if (!cutlist || typeof cutlist !== 'object' || !Array.isArray(cutlist.parts)) return null;

  const parts = cutlist.parts
    .slice(0, MAX_CUTLIST_PARTS)
    .filter((part) => part && typeof part === 'object');
  const boardPrice = Number(cutlist.board_price) > 0 ? Number(cutlist.board_price) : shopBoardPrice;
  const recomputed = calculateCutlist(parts, { boardPrice });
  if (recomputed.parts.length === 0) return null;

  if (cutlist.dimensions && typeof cutlist.dimensions === 'object' && !Array.isArray(cutlist.dimensions)) {
    const height = Number(cutlist.dimensions.height);
    const width = Number(cutlist.dimensions.width);
    const depth = Number(cutlist.dimensions.depth);
    if (
      Number.isFinite(height) && height > 0 && height <= 1000 &&
      Number.isFinite(width) && width > 0 && width <= 1000 &&
      Number.isFinite(depth) && depth > 0 && depth <= 1000
    ) {
      recomputed.dimensions = { height, width, depth };
    }
  }

  return JSON.stringify(recomputed);
}

function validateProductPayload(input, shopBoardPrice = DEFAULT_BOARD_PRICE) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'প্রোডাক্টের তথ্য সঠিকভাবে পাঠান' };
  }

  const data = {};
  const textFields = {
    title: { required: true, max: 200 },
    sku: { required: true, max: 40 },
    brand: { required: true, max: 40 },
    category: { required: true, max: 100 },
    shop_name: { max: 100 },
    vendor_badge: { max: 100 },
    vendor_address: { max: 300 },
    description: { max: 10000 },
    caption: { max: 3000 },
    materials: { max: 500 },
    finish: { max: 500 }
  };

  for (const [field, rules] of Object.entries(textFields)) {
    const value = input[field];
    if (value === undefined) {
      if (rules.required) return { error: 'প্রয়োজনীয় প্রোডাক্ট তথ্য পূরণ করুন' };
      continue;
    }
    if (value === null && !rules.required) {
      data[field] = '';
      continue;
    }
    if (typeof value !== 'string') return { error: 'প্রোডাক্টের লেখার তথ্য সঠিক নয়' };
    const clean = value.trim();
    if ((rules.required && !clean) || clean.length > rules.max) {
      return { error: 'প্রোডাক্টের লেখা খালি রাখা যাবে না এবং নির্ধারিত সীমার মধ্যে দিন' };
    }
    data[field] = clean;
  }

  if (!/^[A-Z0-9][A-Z0-9_-]{1,39}$/.test(data.sku || '')) {
    return { error: 'SKU-তে ২ থেকে ৪০টি ইংরেজি অক্ষর, সংখ্যা, হাইফেন বা আন্ডারস্কোর দিন' };
  }
  if (!PRODUCT_BRANDS.has(data.brand)) return { error: 'প্রোডাক্টের ব্র্যান্ড নির্বাচন সঠিক নয়' };

  for (const [field, options] of Object.entries({
    regular_price: { required: true, min: 1, max: 50000000 },
    reseller_commission: { required: true, min: 0, max: 50000000 },
    stock: { required: true, min: 0, max: 1000000 },
    is_active: { required: true, min: 0, max: 1 }
  })) {
    const value = input[field];
    if (value === undefined) {
      if (options.required) {
        if (field === 'reseller_commission') data[field] = 50;
        else if (field === 'stock') data[field] = 50;
        else if (field === 'is_active') data[field] = 1;
        else return { error: 'বিক্রয় মূল্য সঠিকভাবে দিন' };
      }
      continue;
    }
    if (field === 'regular_price' || field === 'reseller_commission') {
      // Money may carry up to two decimal places and is stored as paisa.
      const paisa = toPaisa(value);
      if (paisa === null) return { error: 'মূল্য ও কমিশন সঠিক সংখ্যায় দিন' };
      const taka = paisa / 100;
      if (taka < options.min || taka > options.max) return { error: 'মূল্য, কমিশন, স্টক বা সক্রিয়তার মান সীমার বাইরে' };
      data[field] = taka;
      continue;
    }
    if (value === '' || value === null || !Number.isSafeInteger(Number(value))) {
      return { error: 'মূল্য, কমিশন, স্টক ও সক্রিয়তার তথ্য পূর্ণসংখ্যায় দিন' };
    }
    const number = Number(value);
    if (number < options.min || number > options.max) return { error: 'মূল্য, কমিশন, স্টক বা সক্রিয়তার মান সীমার বাইরে' };
    data[field] = number;
  }
  if (data.reseller_commission > data.regular_price) return { error: 'কমিশন বিক্রয় মূল্যের চেয়ে বেশি হতে পারবে না' };

  // Wholesale price (in taka; stored in paisa)
  if (input.wholesale_price !== undefined && input.wholesale_price !== null && input.wholesale_price !== '') {
    const wpPaisa = toPaisa(input.wholesale_price);
    if (wpPaisa === null || wpPaisa < 0 || wpPaisa > 50000000 * 100) {
      return { error: 'পাইকারি মূল্য সঠিক সংখ্যায় দিন' };
    }
    data.wholesale_price = wpPaisa / 100;
  } else {
    // Default wholesale cost: price - commission - 15% platform margin
    data.wholesale_price = Math.max(0, data.regular_price - data.reseller_commission - Math.round(data.regular_price * 0.15));
  }

  // Profit validation (Net profit cannot be negative)
  if (data.wholesale_price + data.reseller_commission > data.regular_price) {
    return { error: 'পাইকারি মূল্য ও রিসেলার কমিশনের যোগফল বিক্রয় মূল্যের চেয়ে বেশি হতে পারবে না (নেট লাভ নেগেটিভ)' };
  }

  if (input.shop_id !== undefined && input.shop_id !== null) {
    const sId = Number(input.shop_id);
    if (Number.isSafeInteger(sId) && sId > 0) data.shop_id = sId;
  }

  if (input.shop_type !== undefined && ['own', 'partner'].includes(input.shop_type)) {
    data.shop_type = input.shop_type;
  } else if (data.shop_name && !['SB Furniture', 'SB POWER', 'SB Lifestyle & Tools'].includes(data.shop_name)) {
    data.shop_type = 'partner';
  } else {
    data.shop_type = 'own';
  }

  if (input.commission_tab !== undefined) {
    if (typeof input.commission_tab !== 'string' || !COMMISSION_TABS.has(input.commission_tab)) {
      return { error: 'কমিশন ট্যাব থেকে একটি সঠিক মান নির্বাচন করুন' };
    }
    data.commission_tab = input.commission_tab;
  } else {
    data.commission_tab = resolveCommissionTab(data.reseller_commission);
  }

  if (input.image_url !== undefined && typeof input.image_url !== 'string') {
    return { error: 'ছবির ঠিকানা সঠিক নয়' };
  }
  const imageUrl = typeof input.image_url === 'string' ? input.image_url.trim() : '';
  if (imageUrl.length > 2048) return { error: 'ছবির ঠিকানা অনেক বড়' };
  if (!imageUrl) {
    data.image_url = PRODUCT_DEFAULT_IMAGE;
  } else if (imageUrl.startsWith('/') && !imageUrl.startsWith('//')) {
    data.image_url = imageUrl;
  } else {
    try {
      const parsed = new URL(imageUrl);
      if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) {
        return { error: 'ছবির জন্য HTTPS ঠিকানা দিন' };
      }
      data.image_url = parsed.href;
    } catch (error) {
      return { error: 'ছবির ঠিকানা সঠিক HTTPS URL হতে হবে' };
    }
  }

  if (input.vendor_phone !== undefined && input.vendor_phone !== null && typeof input.vendor_phone !== 'string') {
    return { error: 'ভেন্ডরের ফোন নম্বর সঠিক নয়' };
  }
  let vendorPhone = typeof input.vendor_phone === 'string' ? input.vendor_phone.replace(/\D/g, '') : '';
  if (vendorPhone.startsWith('00880')) vendorPhone = `0${vendorPhone.slice(5)}`;
  else if (vendorPhone.startsWith('880')) vendorPhone = `0${vendorPhone.slice(3)}`;
  if (vendorPhone && !/^01[3-9]\d{8}$/.test(vendorPhone)) return { error: 'ভেন্ডরের ১১ সংখ্যার বাংলাদেশি মোবাইল নম্বর দিন' };
  data.vendor_phone = vendorPhone || null;

  data.shop_name = data.shop_name || data.brand;
  data.vendor_badge = data.vendor_badge || null;
  data.vendor_address = data.vendor_address || null;
  data.description = data.description || '';
  data.materials = data.materials || '';
  data.finish = data.finish || '';

  data.furniture_cutlist = recomputeFurnitureCutlist(input.furniture_cutlist, shopBoardPrice);

  return { data };
}

function validateAnnouncementPayload(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'ঘোষণার তথ্য সঠিকভাবে পাঠান' };
  const title = input.title;
  const message = input.message;
  const type = input.type === undefined ? 'flash_deal' : input.type;
  const active = input.is_active === undefined ? 1 : Number(input.is_active);
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 120) return { error: 'শিরোনাম ১২০ অক্ষরের মধ্যে দিন' };
  if (typeof message !== 'string' || !message.trim() || message.trim().length > 2000) return { error: 'বার্তা ২০০০ অক্ষরের মধ্যে দিন' };
  if (typeof type !== 'string' || !['flash_deal', 'general'].includes(type)) return { error: 'ঘোষণার ধরন সঠিক নয়' };
  if (![0, 1].includes(active) || (typeof input.is_active === 'string' && !/^[01]$/.test(input.is_active))) {
    return { error: 'ঘোষণার সক্রিয়তার মান ০ অথবা ১ দিন' };
  }
  return { data: { title: title.trim(), message: message.trim(), type, is_active: active } };
}

// Require Admin Role for all routes in this router
router.use(verifyToken, requireRole('admin'));

const UPLOADS_DIR = path.resolve(__dirname, '..', '..', 'public', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

async function unlinkUnreferencedUpload(imageUrl, excludeProductId = null, { tempOnly = false } = {}) {
  const cleanUrl = typeof imageUrl === 'string' ? imageUrl.trim() : '';
  if (!cleanUrl.startsWith('/uploads/')) return false;

  const relativePath = cleanUrl.replace(/^\/+/, '');
  const publicRoot = path.resolve(__dirname, '..', '..', 'public');
  const resolved = path.resolve(publicRoot, relativePath);
  if (!resolved.startsWith(UPLOADS_DIR + path.sep)) return false;

  if (tempOnly && !/^prod_[0-9]+_[a-f0-9]+\.(?:jpg|jpeg|png|webp|gif)$/i.test(path.basename(resolved))) {
    return false;
  }

  const refSql = excludeProductId
    ? 'SELECT id FROM products WHERE image_url = ? AND id != ? LIMIT 1'
    : 'SELECT id FROM products WHERE image_url = ? LIMIT 1';
  const refRow = excludeProductId
    ? await get(refSql, [cleanUrl, excludeProductId])
    : await get(refSql, [cleanUrl]);
  if (refRow) return false;

  if (!fs.existsSync(resolved)) return false;
  await fs.promises.unlink(resolved);
  return true;
}

function detectImageMime(buffer) {
  if (!buffer || buffer.length < 12) return null;
  // JPEG: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return { mime: 'image/jpeg', ext: 'jpg' };
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47 &&
      buffer[4] === 0x0D && buffer[5] === 0x0A && buffer[6] === 0x1A && buffer[7] === 0x0A) {
    return { mime: 'image/png', ext: 'png' };
  }
  // GIF: 47 49 46 38
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
    return { mime: 'image/gif', ext: 'gif' };
  }
  // WEBP: RIFF....WEBP
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
    return { mime: 'image/webp', ext: 'webp' };
  }
  return null;
}

function extractMultipartFile(buffer, contentType) {
  if (!buffer || !contentType) return null;
  const boundaryMatch = contentType.match(/boundary=([^;]+)/i);
  if (!boundaryMatch) return null;
  const boundary = boundaryMatch[1].trim().replace(/^["']|["']$/g, '');
  const delimiter = Buffer.from('--' + boundary);
  const headerEnd = Buffer.from('\r\n\r\n');
  const partStart = buffer.indexOf(delimiter);
  if (partStart === -1) return null;
  const hStart = buffer.indexOf(headerEnd, partStart);
  if (hStart === -1) return null;
  const fileStart = hStart + 4;
  const nextDelimiter = buffer.indexOf(Buffer.from('\r\n--' + boundary), fileStart);
  if (nextDelimiter !== -1) {
    return buffer.slice(fileStart, nextDelimiter);
  }
  const endBoundary = buffer.indexOf(Buffer.from('--' + boundary + '--'), fileStart);
  if (endBoundary !== -1) {
    return buffer.slice(fileStart, endBoundary);
  }
  return null;
}

// Direct Product Photo Upload Endpoint (Admin Only, No URL Required)
router.post('/upload-image', async (req, res) => {
  try {
    let buffer = null;
    const raw = req.body && (req.body.image || req.body.data || req.body.file);

    if (raw && typeof raw === 'string') {
      let base64Data = raw.trim();
      const prefixIndex = base64Data.indexOf(';base64,');
      if (prefixIndex !== -1) {
        base64Data = base64Data.substring(prefixIndex + 8);
      } else {
        const directMatch = base64Data.match(/^data:[^,]+,([\s\S]+)$/);
        if (directMatch) base64Data = directMatch[1];
      }
      base64Data = base64Data.replace(/\s+/g, '');
      buffer = Buffer.from(base64Data, 'base64');
    } else if (req.readable) {
      // Handle multipart/form-data or direct binary stream
      const chunks = [];
      let total = 0;
      for await (const chunk of req) {
        total += chunk.length;
        if (total > 10 * 1024 * 1024) {
          return res.status(400).json({ success: false, message: 'ছবির সাইজ সর্বোচ্চ ৫ মেগাবাইট হতে পারবে' });
        }
        chunks.push(chunk);
      }
      const rawBuf = Buffer.concat(chunks);
      const contentType = req.headers['content-type'] || '';
      if (contentType.includes('multipart/form-data')) {
        buffer = extractMultipartFile(rawBuf, contentType);
      } else {
        buffer = rawBuf;
      }
    }

    if (!buffer || buffer.length === 0) {
      return res.status(400).json({ success: false, message: 'ছবির ফাইল বা ডেটা প্রদান করুন' });
    }

    // 5MB limit
    if (buffer.length > 5 * 1024 * 1024) {
      return res.status(400).json({ success: false, message: 'ছবির সাইজ সর্বোচ্চ ৫ মেগাবাইট হতে পারবে' });
    }

    const detected = detectImageMime(buffer);
    if (!detected) {
      return res.status(400).json({ success: false, message: 'শুধুমাত্র JPG, PNG, WebP বা GIF ফরম্যাটের ছবি আপলোড করা যাবে' });
    }

    if (!fs.existsSync(UPLOADS_DIR)) {
      await fs.promises.mkdir(UPLOADS_DIR, { recursive: true });
    }

    const filename = `prod_${Date.now()}_${crypto.randomBytes(6).toString('hex')}.${detected.ext}`;
    const filePath = path.join(UPLOADS_DIR, filename);

    await fs.promises.writeFile(filePath, buffer);

    return res.json({
      success: true,
      url: `/uploads/${filename}`,
      filename
    });
  } catch (error) {
    console.error('Image upload failed:', error);
    return res.status(500).json({ success: false, message: 'ছবি আপলোড করতে ব্যর্থ হয়েছে' });
  }
});

// Clean up abandoned temporary draft image uploads (strictly unreferenced prod_* files)
router.delete('/upload-image', async (req, res) => {
  try {
    const rawUrl = req.body && req.body.url;
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
      return res.status(400).json({ success: false, message: 'মুছে ফেলার জন্য ছবির URL দিন' });
    }
    const deleted = await unlinkUnreferencedUpload(rawUrl, null, { tempOnly: true });
    return res.json({ success: true, deleted });
  } catch (error) {
    console.error('Cleanup temp upload failed:', error);
    return res.status(500).json({ success: false, message: 'অস্থায়ী ছবি মুছতে ব্যর্থ হয়েছে' });
  }
});

// Admin User Management Sub-routes
const adminUserRoutes = require('./adminUserRoutes');
router.use('/', adminUserRoutes);

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
        total_revenue: fromPaisa(totalOrdersRow.revenue),
        pending_orders: pendingOrdersRow.count,
        delivered_orders: deliveredOrdersRow.count,
        total_products: totalProductsRow.count,
        total_resellers: totalResellersRow.count,
        pending_payouts_count: pendingPayoutsRow.count,
        pending_payouts_amount: fromPaisa(pendingPayoutsRow.total)
      }
    });
  } catch (error) {
    console.error('Admin Stats Error:', error);
    return res.status(500).json({ success: false, message: 'পরিসংখ্যান লোড করতে ব্যর্থ হয়েছে' });
  }
});

// Admin Analytics Endpoint (Detailed Profit Dashboard, Top Products, Top Resellers)
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
          WHERE user_id = u.id AND status = 'available' AND type IN ('commission', 'referral_commission')
        ) as total_commission_earned
      FROM users u
      JOIN orders o ON u.id = o.reseller_id AND o.status = 'delivered'
      GROUP BY u.id
      ORDER BY delivered_sales_count DESC, total_volume DESC
      LIMIT 5
    `);

    const pendingPayoutsRow = await get("SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total FROM payout_requests WHERE status = 'pending'");

    // Profit Dashboard Calculations (Delivered Orders)
    const deliveredFinancialsRow = await get(`
      SELECT
        COUNT(*) as delivered_count,
        COALESCE(SUM(total_amount), 0) as delivered_revenue,
        COALESCE(SUM(total_wholesale_amount), 0) as delivered_wholesale,
        COALESCE(SUM(total_reseller_commission), 0) as delivered_commission,
        COALESCE(SUM(platform_net_profit), 0) as net_profit
      FROM orders
      WHERE status = 'delivered'
    `);

    // Today delivered financials
    const todayFinancialsRow = await get(`
      SELECT
        COUNT(*) as delivered_count,
        COALESCE(SUM(total_amount), 0) as delivered_revenue,
        COALESCE(SUM(total_wholesale_amount), 0) as delivered_wholesale,
        COALESCE(SUM(total_reseller_commission), 0) as delivered_commission,
        COALESCE(SUM(platform_net_profit), 0) as net_profit
      FROM orders
      WHERE status = 'delivered' AND date(created_at) = date('now')
    `);

    // This Month delivered financials
    const monthFinancialsRow = await get(`
      SELECT
        COUNT(*) as delivered_count,
        COALESCE(SUM(total_amount), 0) as delivered_revenue,
        COALESCE(SUM(total_wholesale_amount), 0) as delivered_wholesale,
        COALESCE(SUM(total_reseller_commission), 0) as delivered_commission,
        COALESCE(SUM(platform_net_profit), 0) as net_profit
      FROM orders
      WHERE status = 'delivered' AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
    `);

    // Partner Shop Payable (delivered partner items where partner_settled = 0)
    const partnerPayableRow = await get(`
      SELECT COALESCE(SUM(oi.unit_wholesale_price * oi.quantity), 0) as payable
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      WHERE o.status = 'delivered' AND (oi.shop_type = 'partner' OR oi.shop_name NOT IN ('SB Furniture', 'SB POWER', 'SB Lifestyle & Tools')) AND o.partner_settled = 0
    `);

    // Partner Shop Settled
    const partnerSettledRow = await get('SELECT COALESCE(SUM(amount), 0) as settled FROM shop_settlements');

    // Reseller Commissions Pending vs Paid
    const commPendingRow = await get("SELECT COALESCE(SUM(amount), 0) as total FROM wallet_transactions WHERE type IN ('commission', 'referral_commission') AND status = 'pending'");
    const commPaidRow = await get("SELECT COALESCE(SUM(amount), 0) as total FROM wallet_transactions WHERE type IN ('commission', 'referral_commission') AND status IN ('available', 'completed')");

    return res.json({
      success: true,
      analytics: {
        total_orders: totalOrdersRow.count,
        total_revenue: fromPaisa(totalOrdersRow.revenue),
        status_breakdown: statusCounts.map((row) => takaFields(row, ['volume'])),
        top_products: topProducts.map((row) => takaFields(row, ['total_sales_volume'])),
        top_resellers: topResellers.map((row) => takaFields(row, ['total_volume', 'total_commission_earned'])),
        pending_payouts_count: pendingPayoutsRow.count,
        pending_payouts_amount: fromPaisa(pendingPayoutsRow.total),
        profit_dashboard: {
          today: {
            orders_count: todayFinancialsRow.delivered_count,
            revenue: fromPaisa(todayFinancialsRow.delivered_revenue),
            wholesale_cost: fromPaisa(todayFinancialsRow.delivered_wholesale),
            reseller_commissions: fromPaisa(todayFinancialsRow.delivered_commission),
            net_profit: fromPaisa(todayFinancialsRow.net_profit)
          },
          this_month: {
            orders_count: monthFinancialsRow.delivered_count,
            revenue: fromPaisa(monthFinancialsRow.delivered_revenue),
            wholesale_cost: fromPaisa(monthFinancialsRow.delivered_wholesale),
            reseller_commissions: fromPaisa(monthFinancialsRow.delivered_commission),
            net_profit: fromPaisa(monthFinancialsRow.net_profit)
          },
          all_time: {
            orders_count: deliveredFinancialsRow.delivered_count,
            revenue: fromPaisa(deliveredFinancialsRow.delivered_revenue),
            wholesale_cost: fromPaisa(deliveredFinancialsRow.delivered_wholesale),
            reseller_commissions: fromPaisa(deliveredFinancialsRow.delivered_commission),
            net_profit: fromPaisa(deliveredFinancialsRow.net_profit)
          },
          partner_shops: {
            payable_unsettled: fromPaisa(partnerPayableRow.payable),
            total_settled: fromPaisa(partnerSettledRow.settled)
          },
          reseller_commissions_ledger: {
            pending: fromPaisa(commPendingRow.total),
            paid_or_available: fromPaisa(commPaidRow.total)
          }
        }
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
      orders: enrichedOrders.map(orderToClient)
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

    if (!Number.isSafeInteger(orderId) || orderId < 1) {
      return res.status(400).json({ success: false, message: 'অর্ডার আইডি সঠিক নয়' });
    }

    const validStatuses = ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: 'অবৈধ অর্ডার স্ট্যাটাস' });
    }

    const order = await get('SELECT * FROM orders WHERE id = ?', [orderId]);
    if (!order) {
      return res.status(404).json({ success: false, message: 'অর্ডারটি পাওয়া যায়নি' });
    }

    const previousStatus = order.status;

    await withTransaction(async ({ run: txRun, query: txQuery, get: txGet }) => {
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

      if (previousStatus === 'cancelled' && status !== 'cancelled') {
        await txRun(
          `UPDATE wallet_transactions
           SET status = CASE
             WHEN type = 'referral_redemption' THEN 'completed'
             WHEN type IN ('commission', 'referral_commission', 'referral_credit') THEN 'pending'
             ELSE status
           END
           WHERE order_id = ? AND status = 'cancelled'`,
          [orderId]
        );
        await txRun(
          'UPDATE orders SET commission_released = 0, referral_reward_released = 0 WHERE id = ?',
          [orderId]
        );
      }

      // 3. Status-based wallet transaction management
      if (status === 'delivered' && previousStatus !== 'delivered') {
        // Mark reseller's pending commission transaction as 'available'
        if (order.reseller_id && !order.commission_released) {
          await txRun(
            `UPDATE wallet_transactions
             SET status = 'available'
             WHERE order_id = ? AND user_id = ? AND type = 'commission'`,
            [orderId, order.reseller_id]
          );
          await txRun('UPDATE orders SET commission_released = 1 WHERE id = ?', [orderId]);
        }
        if (order.referrer_user_id && !order.referral_reward_released) {
          await txRun(
            `UPDATE wallet_transactions
             SET status = 'available'
             WHERE order_id = ? AND user_id = ? AND type IN ('referral_commission', 'referral_credit') AND status = 'pending'`,
            [orderId, order.referrer_user_id]
          );
          await txRun('UPDATE orders SET referral_reward_released = 1 WHERE id = ?', [orderId]);
          await txRun(
            `INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)`,
            [order.referrer_user_id, 'রেফারেল পুরস্কার যোগ হয়েছে', `আপনার আমন্ত্রিত সদস্যের অর্ডার #${order.order_number} ডেলিভারি সম্পন্ন হয়েছে; রেফারেল পুরস্কার যোগ হয়েছে।`]
          );
        }
      } else if (status === 'cancelled' && previousStatus !== 'cancelled') {
        // If cancelled, cancel all wallet transactions associated with this order
        await txRun(
          `UPDATE wallet_transactions
           SET status = 'cancelled'
           WHERE order_id = ?`,
          [orderId]
        );
        await txRun('UPDATE orders SET commission_released = 0, referral_reward_released = 0 WHERE id = ?', [orderId]);
      } else if (previousStatus === 'delivered' && status !== 'delivered') {
        // Reverting away from delivered: put commissions/bonuses back to pending
        await txRun(
          `UPDATE wallet_transactions
           SET status = 'pending'
          WHERE order_id = ? AND type IN ('commission', 'referral_commission', 'referral_credit')`,
          [orderId]
        );
        await txRun('UPDATE orders SET commission_released = 0, referral_reward_released = 0 WHERE id = ?', [orderId]);
      }

      // 4. Stock follows the order: cancelling returns reserved units, and
      // reopening a cancelled order reserves them again.
      if (status === 'cancelled' && previousStatus !== 'cancelled') {
        const orderItems = await txQuery('SELECT product_id, quantity FROM order_items WHERE order_id = ?', [orderId]);
        for (const item of orderItems) {
          await txRun(
            'UPDATE products SET stock = stock + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [item.quantity, item.product_id]
          );
        }
      } else if (previousStatus === 'cancelled' && status !== 'cancelled') {
        const orderItems = await txQuery('SELECT product_id, quantity FROM order_items WHERE order_id = ?', [orderId]);
        for (const item of orderItems) {
          const reservation = await txRun(
            'UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?',
            [item.quantity, item.product_id, item.quantity]
          );
          if (!reservation || reservation.changes !== 1) {
            const stockError = new Error(`পণ্য আইডি ${item.product_id}-এর পর্যাপ্ত স্টক নেই`);
            stockError.statusCode = 409;
            throw stockError;
          }
        }
      }

      // 5. Send notification to reseller if order is attributed
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
    if (error.statusCode === 409) {
      return res.status(409).json({ success: false, message: error.message });
    }
    console.error('Order Status Update Error:', error);
    return res.status(500).json({ success: false, message: 'স্ট্যাটাস আপডেট ব্যর্থ হয়েছে' });
  }
});

// Dedicated Instant Release Commission endpoint
router.post('/orders/:id/release-commission', async (req, res) => {
  try {
    const orderId = parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(orderId) || orderId < 1) {
      return res.status(400).json({ success: false, message: 'অর্ডার আইডি সঠিক নয়' });
    }

    const order = await get('SELECT * FROM orders WHERE id = ?', [orderId]);
    if (!order) {
      return res.status(404).json({ success: false, message: 'অর্ডারটি পাওয়া যায়নি' });
    }

    if (!order.reseller_id) {
      return res.status(400).json({ success: false, message: 'এই অর্ডারে কোনো রিসেলার যুক্ত নেই' });
    }

    if (order.commission_released) {
      return res.status(400).json({ success: false, message: 'এই অর্ডারের কমিশন ইতিমধ্যে রিলিজ করা হয়েছে' });
    }

    if (order.status === 'cancelled') {
      return res.status(400).json({ success: false, message: 'বাতিল অর্ডারের কমিশন রিলিজ করা সম্ভব নয়' });
    }

    await withTransaction(async ({ run: txRun }) => {
      // 1. Move pending commission to available in wallet_transactions
      const updatedTx = await txRun(
        `UPDATE wallet_transactions
         SET status = 'available', notes = COALESCE(notes, '') || ' (ইনস্ট্যান্ট রিলিজ)'
         WHERE order_id = ? AND user_id = ? AND type = 'commission'`,
        [orderId, order.reseller_id]
      );

      // If no commission transaction was found, insert an available one
      if (updatedTx.changes === 0 && order.total_reseller_commission > 0) {
        await txRun(
          `INSERT INTO wallet_transactions (
            user_id, order_id, amount, type, status, notes
          ) VALUES (?, ?, ?, 'commission', 'available', ?)`,
          [order.reseller_id, orderId, order.total_reseller_commission, `অর্ডার #${order.order_number}-এর কমিশন (ইনস্ট্যান্ট রিলিজ)`]
        );
      }

      // 2. Mark commission_released on order
      await txRun(
        'UPDATE orders SET commission_released = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [orderId]
      );

      // 3. Log to audit trail
      const adminUserId = req.user ? req.user.id : null;
      await txRun(
        `INSERT INTO order_status_logs (
          order_id, previous_status, new_status, changed_by_user_id, notes
        ) VALUES (?, ?, ?, ?, ?)`,
        [orderId, order.status, order.status, adminUserId, 'এডমিন কর্তৃক ইনস্ট্যান্ট কমিশন রিলিজ সম্পন্ন']
      );

      // 4. Send notification to reseller
      const commTaka = fromPaisa(order.total_reseller_commission);
      await txRun(
        `INSERT INTO notifications (user_id, title, message)
         VALUES (?, ?, ?)`,
        [
          order.reseller_id,
          'ইনস্ট্যান্ট কমিশন রিলিজ! 🎉',
          `আপনার অর্ডার #${order.order_number}-এর কমিশন (${commTaka}৳) ইনস্ট্যান্ট উত্তোলনযোগ্য ব্যালেন্সে যুক্ত করা হয়েছে।`
        ]
      );
    });

    return res.json({
      success: true,
      message: 'কমিশন সফলভাবে ইনস্ট্যান্ট রিলিজ করা হয়েছে!'
    });
  } catch (error) {
    console.error('Instant Commission Release Error:', error);
    return res.status(500).json({ success: false, message: 'কমিশন রিলিজ করতে ব্যর্থ হয়েছে' });
  }
});

// Get Order Status Audit Trail
router.get('/orders/:id/audit-trail', async (req, res) => {
  try {
    const orderId = parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(orderId) || orderId < 1) {
      return res.status(400).json({ success: false, message: 'অর্ডার আইডি সঠিক নয়' });
    }
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
      payouts: payouts.map((payout) => takaFields(payout, ['amount']))
    });
  } catch (error) {
    console.error('Admin Payouts Error:', error);
    return res.status(500).json({ success: false, message: 'ক্যাশআউট রিকোয়েস্ট লোড ব্যর্থ হয়েছে' });
  }
});

// Update Payout Status (Approve / Reject)
router.put('/payouts/:id', async (req, res) => {
  try {
    const payoutId = Number(req.params.id);
    const { status, admin_trx_id, notes } = req.body;

    if (!Number.isSafeInteger(payoutId) || payoutId < 1) {
      return res.status(400).json({ success: false, message: 'ক্যাশআউট আইডি সঠিক নয়' });
    }
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, message: 'অবৈধ পেআউট স্ট্যাটাস (approved বা rejected হতে হবে)' });
    }
    if (admin_trx_id !== undefined && admin_trx_id !== null && (typeof admin_trx_id !== 'string' || admin_trx_id.trim().length > 80)) {
      return res.status(400).json({ success: false, message: 'TrxID ৮০ অক্ষরের মধ্যে দিন' });
    }
    if (status === 'approved' && (!admin_trx_id || admin_trx_id.trim().length < 4)) {
      return res.status(400).json({ success: false, message: 'পেআউট অনুমোদনের আগে পাঠানো টাকার TrxID দিন' });
    }
    if (notes !== undefined && notes !== null && (typeof notes !== 'string' || notes.length > 500)) {
      return res.status(400).json({ success: false, message: 'নোট ৫০০ অক্ষরের মধ্যে দিন' });
    }

    const payout = await get('SELECT * FROM payout_requests WHERE id = ?', [payoutId]);
    if (!payout) {
      return res.status(404).json({ success: false, message: 'ক্যাশআউট রিকোয়েস্ট পাওয়া যায়নি' });
    }

    await withTransaction(async ({ get: txGet, run: txRun }) => {
      const currentPayout = await txGet('SELECT * FROM payout_requests WHERE id = ?', [payoutId]);
      if (!currentPayout) {
        const notFoundError = new Error('ক্যাশআউট রিকোয়েস্ট পাওয়া যায়নি');
        notFoundError.statusCode = 404;
        throw notFoundError;
      }
      if (currentPayout.status !== 'pending') {
        const conflictError = new Error('এই ক্যাশআউট রিকোয়েস্ট আগে থেকেই প্রক্রিয়া করা হয়েছে');
        conflictError.statusCode = 409;
        throw conflictError;
      }

      const updateResult = await txRun(
        `UPDATE payout_requests
         SET status = ?, admin_trx_id = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'pending'`,
        [status, admin_trx_id ? admin_trx_id.trim() : null, notes ? notes.trim() : null, payoutId]
      );
      if (updateResult.changes !== 1) {
        const conflictError = new Error('এই ক্যাশআউট রিকোয়েস্ট আগে থেকেই প্রক্রিয়া করা হয়েছে');
        conflictError.statusCode = 409;
        throw conflictError;
      }

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
          currentPayout.user_id,
          currentPayout.amount
        ]
      );

      // Notify reseller about payout approval or rejection
      const notifTitle = status === 'approved' ? 'ক্যাশআউট অনুমোদন সম্পন্ন!' : 'ক্যাশআউট রিকোয়েস্ট বাতিল';
      const notifMsg = status === 'approved'
        ? `আপনার ${fromPaisa(currentPayout.amount)}৳ ক্যাশআউট (${currentPayout.payment_method.toUpperCase()}: ${currentPayout.account_number}) সফল হয়েছে। TrxID: ${admin_trx_id.trim()}`
        : `আপনার ${fromPaisa(currentPayout.amount)}৳ ক্যাশআউট রিকোয়েস্ট বাতিল করা হয়েছে। কারণ: ${notes || 'অ্যাকাউন্ট তথ্যে অসঙ্গতি'}`;

      await txRun(
        `INSERT INTO notifications (user_id, title, message) VALUES (?, ?, ?)`,
        [currentPayout.user_id, notifTitle, notifMsg]
      );
    });

    return res.json({
      success: true,
      message: status === 'approved' ? 'ক্যাশআউট অনুমোদন সম্পন্ন হয়েছে!' : 'ক্যাশআউট বাতিল করা হয়েছে'
    });
  } catch (error) {
    if (error.statusCode === 404 || error.statusCode === 409) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
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
        whereSql += " AND shop_name NOT IN ('SB Furniture', 'SB POWER', 'SB Lifestyle & Tools') AND shop_name IS NOT NULL";
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
      products: products.map(productToClient)
    });
  } catch (error) {
    console.error('Admin Products Fetch Error:', error);
    return res.status(500).json({ success: false, message: 'প্রোডাক্ট তালিকা লোড ব্যর্থ হয়েছে' });
  }
});

// Product Management: Create Product
router.post('/products', async (req, res) => {
  try {
    const validation = validateProductPayload(req.body, await getBoardPriceTaka());
    if (validation.error) return res.status(400).json({ success: false, message: validation.error });
    const product = validation.data;

    // Check SKU duplicate
    const existing = await get('SELECT id FROM products WHERE sku = ?', [product.sku]);
    if (existing) {
      return res.status(400).json({ success: false, message: 'এই SKU কোডটি ইতিমধ্যে ব্যবহৃত হচ্ছে' });
    }

    // Resolve shop_id and shop_type
    let shopId = product.shop_id || null;
    let shopType = product.shop_type || 'own';
    const shopName = product.shop_name || product.brand || 'SB Furniture';
    if (!shopId) {
      const existingShop = await get('SELECT id, shop_type FROM shops WHERE name = ?', [shopName]);
      if (existingShop) {
        shopId = existingShop.id;
        shopType = existingShop.shop_type;
      } else {
        const isPartner = !['SB Furniture', 'SB POWER', 'SB Lifestyle & Tools'].includes(shopName);
        shopType = isPartner ? 'partner' : 'own';
        const newShop = await run(
          `INSERT INTO shops (name, shop_type, phone, address) VALUES (?, ?, ?, ?)`,
          [shopName, shopType, product.vendor_phone || null, product.vendor_address || null]
        );
        shopId = newShop.lastID;
      }
    }

    const result = await run(
      `INSERT INTO products (
        title, sku, brand, category, regular_price, reseller_commission, commission_tab,
        image_url, description, caption, materials, finish, stock, is_active,
        shop_name, shop_id, shop_type, wholesale_price,
        vendor_phone, vendor_badge, vendor_address, furniture_cutlist
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        product.title,
        product.sku,
        product.brand,
        product.category,
        toPaisa(product.regular_price),
        toPaisa(product.reseller_commission),
        product.commission_tab,
        product.image_url,
        product.description,
        product.caption || null,
        product.materials,
        product.finish,
        product.stock,
        shopName,
        shopId,
        shopType,
        toPaisa(product.wholesale_price),
        product.vendor_phone,
        product.vendor_badge,
        product.vendor_address,
        product.furniture_cutlist
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
    const productId = Number(req.params.id);
    if (!Number.isSafeInteger(productId) || productId < 1) {
      return res.status(400).json({ success: false, message: 'প্রোডাক্ট আইডি সঠিক নয়' });
    }

    const product = await get('SELECT * FROM products WHERE id = ?', [productId]);
    if (!product) {
      return res.status(404).json({ success: false, message: 'প্রোডাক্ট পাওয়া যায়নি' });
    }

    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ success: false, message: 'প্রোডাক্টের তথ্য সঠিকভাবে পাঠান' });
    }
    // The stored row is paisa; the validator and the admin form work in taka.
    const validation = validateProductPayload({ ...productToClient(product), ...req.body }, await getBoardPriceTaka());
    if (validation.error) return res.status(400).json({ success: false, message: validation.error });
    const updated = validation.data;

    const duplicateSku = await get('SELECT id FROM products WHERE sku = ? AND id != ?', [updated.sku, productId]);
    if (duplicateSku) {
      return res.status(400).json({ success: false, message: 'এই SKU কোডটি অন্য একটি পণ্যে ব্যবহৃত হচ্ছে' });
    }

    let shopId = updated.shop_id || product.shop_id || null;
    let shopType = updated.shop_type || product.shop_type || 'own';
    const shopName = updated.shop_name || updated.brand || 'SB Furniture';
    if (!shopId) {
      const existingShop = await get('SELECT id, shop_type FROM shops WHERE name = ?', [shopName]);
      if (existingShop) {
        shopId = existingShop.id;
        shopType = existingShop.shop_type;
      } else {
        const isPartner = !['SB Furniture', 'SB POWER', 'SB Lifestyle & Tools'].includes(shopName);
        shopType = isPartner ? 'partner' : 'own';
        const newShop = await run(
          `INSERT INTO shops (name, shop_type, phone, address) VALUES (?, ?, ?, ?)`,
          [shopName, shopType, updated.vendor_phone || null, updated.vendor_address || null]
        );
        shopId = newShop.lastID;
      }
    }

    await run(
      `UPDATE products SET
        title = ?,
        sku = ?,
        brand = ?,
        category = ?,
        regular_price = ?,
        reseller_commission = ?,
        commission_tab = ?,
        image_url = ?,
        description = ?,
        caption = ?,
        materials = ?,
        finish = ?,
        stock = ?,
        is_active = ?,
        shop_name = ?,
        shop_id = ?,
        shop_type = ?,
        wholesale_price = ?,
        vendor_phone = ?,
        vendor_badge = ?,
        vendor_address = ?,
        furniture_cutlist = ?,
        updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        updated.title,
        updated.sku,
        updated.brand,
        updated.category,
        toPaisa(updated.regular_price),
        toPaisa(updated.reseller_commission),
        updated.commission_tab,
        updated.image_url,
        updated.description,
        updated.caption !== undefined ? updated.caption : (product.caption || null),
        updated.materials,
        updated.finish,
        updated.stock,
        updated.is_active,
        shopName,
        shopId,
        shopType,
        toPaisa(updated.wholesale_price),
        updated.vendor_phone,
        updated.vendor_badge,
        updated.vendor_address,
        updated.furniture_cutlist,
        productId
      ]
    );

    // Clean up orphaned local upload file when replaced on product edit
    if (product.image_url && product.image_url !== updated.image_url) {
      await unlinkUnreferencedUpload(product.image_url, productId).catch(() => {});
    }

    return res.json({
      success: true,
      message: 'প্রোডাক্ট তথ্য সফলভাবে আপডেট হয়েছে!',
      furniture_cutlist: updated.furniture_cutlist ? JSON.parse(updated.furniture_cutlist) : null
    });
  } catch (error) {
    console.error('Update Product Error:', error);
    return res.status(500).json({ success: false, message: 'প্রোডাক্ট আপডেট ব্যর্থ হয়েছে' });
  }
});

// Toggle product active/inactive status cleanly
router.patch('/products/:id/status', async (req, res) => {
  try {
    const productId = parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(productId) || productId < 1) {
      return res.status(400).json({ success: false, message: 'প্রোডাক্ট আইডি সঠিক নয়' });
    }
    const rawActive = req.body && req.body.is_active;
    const nextActive = (rawActive === true || rawActive === 1 || rawActive === '1') ? 1 : ((rawActive === false || rawActive === 0 || rawActive === '0') ? 0 : null);
    if (nextActive === null) {
      return res.status(400).json({ success: false, message: 'সক্রিয়তার মান ০ অথবা ১ দিন' });
    }
    const result = await run('UPDATE products SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [nextActive, productId]);
    if (result.changes === 0) {
      return res.status(404).json({ success: false, message: 'প্রোডাক্ট পাওয়া যায়নি' });
    }
    return res.json({
      success: true,
      is_active: nextActive,
      message: nextActive ? 'প্রোডাক্টটি পুনরায় সক্রিয় করা হয়েছে!' : 'প্রোডাক্ট নিষ্ক্রিয় করা হয়েছে'
    });
  } catch (error) {
    console.error('Toggle Product Status Error:', error);
    return res.status(500).json({ success: false, message: 'প্রোডাক্ট স্ট্যাটাস পরিবর্তন ব্যর্থ হয়েছে' });
  }
});

// Product Management: Delete Product (soft-delete by default; permanent=true removes unused product + image)
router.delete('/products/:id', async (req, res) => {
  try {
    const productId = parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(productId) || productId < 1) {
      return res.status(400).json({ success: false, message: 'প্রোডাক্ট আইডি সঠিক নয়' });
    }
    const permanent = String(req.query.permanent || '').toLowerCase() === 'true';

    if (!permanent) {
      const result = await run('UPDATE products SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [productId]);
      if (result.changes === 0) {
        return res.status(404).json({ success: false, message: 'প্রোডাক্ট পাওয়া যায়নি' });
      }
      return res.json({ success: true, softDeleted: true, message: 'প্রোডাক্ট নিষ্ক্রিয় করা হয়েছে' });
    }

    const existing = await get('SELECT id, image_url FROM products WHERE id = ?', [productId]);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'প্রোডাক্ট পাওয়া যায়নি' });
    }

    const outcome = await withTransaction(async ({ get: txGet, run: txRun }) => {
      const orderRef = await txGet('SELECT id FROM order_items WHERE product_id = ? LIMIT 1', [productId]);
      if (orderRef) {
        await txRun('UPDATE products SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [productId]);
        return { softDeleted: true };
      }
      await txRun('DELETE FROM products WHERE id = ?', [productId]);
      return { softDeleted: false };
    });

    if (outcome.softDeleted) {
      return res.json({
        success: true,
        softDeleted: true,
        message: 'এই পণ্যে পূর্বের অর্ডার থাকায় হিসাব রক্ষার্থে স্থায়ী ডিলিটের বদলে নিষ্ক্রিয় রাখা হয়েছে।'
      });
    }

    if (existing.image_url) {
      await unlinkUnreferencedUpload(existing.image_url, productId).catch(() => {});
    }

    return res.json({
      success: true,
      softDeleted: false,
      message: 'প্রোডাক্ট, SKU ও ছবি স্থায়ীভাবে মুছে ফেলা হয়েছে!'
    });
  } catch (error) {
    console.error('Delete Product Error:', error);
    return res.status(500).json({ success: false, message: 'প্রোডাক্ট মুছে ফেলতে ব্যর্থ হয়েছে' });
  }
});

// ================= FURNITURE AI CUTLIST & BOARD CALCULATOR =================
router.post('/furniture/estimate', async (req, res) => {
  try {
    const {
      furniture_type = 'wardrobe',
      height = 72,
      width = 36,
      depth = 18,
      board_thickness = 0.75,
      board_price,
      notes = ''
    } = req.body || {};

    const shopBoardPrice = await getBoardPriceTaka();
    const estimate = await estimateFurniturePartsAndBoards({
      furniture_type,
      height: Number(height) || 72,
      width: Number(width) || 36,
      depth: Number(depth) || 18,
      board_thickness: Number(board_thickness) || 0.75,
      board_price: Number(board_price) || shopBoardPrice,
      notes: typeof notes === 'string' ? notes.slice(0, 500) : ''
    });

    return res.json(estimate);
  } catch (error) {
    console.error('Furniture Estimation API Error:', error);
    return res.status(500).json({ success: false, message: 'ফার্নিচার বোর্ড ক্যালকুলেশনে সমস্যা হয়েছে' });
  }
});

// ================= SHOP SETTINGS (4x8 BOARD RATE) =================
router.get('/shop-settings', async (req, res) => {
  try {
    return res.json({ success: true, settings: { board_price: await getBoardPriceTaka() } });
  } catch (error) {
    console.error('Shop Settings Read Error:', error);
    return res.status(500).json({ success: false, message: 'শপ সেটিংস লোড করা যায়নি' });
  }
});

router.put('/shop-settings', async (req, res) => {
  try {
    const boardPrice = Number(req.body && req.body.board_price);
    if (!Number.isFinite(boardPrice) || boardPrice <= 0 || boardPrice > 1000000) {
      return res.status(400).json({ success: false, message: 'বোর্ডের দর ১ থেকে ১০,০০,০০০ টাকার মধ্যে দিন' });
    }
    const saved = await setBoardPriceTaka(boardPrice, req.user.id);
    return res.json({ success: true, settings: { board_price: saved }, message: 'বোর্ডের দর সংরক্ষণ হয়েছে' });
  } catch (error) {
    console.error('Shop Settings Update Error:', error);
    return res.status(500).json({ success: false, message: 'বোর্ডের দর সংরক্ষণ করা যায়নি' });
  }
});

// ================= AI VISION IMAGE INSPECTOR =================
router.post('/ai/inspect-image', async (req, res) => {
  try {
    let imageBase64 = null;
    let mimeType = 'image/jpeg';
    let imageUrl = null;
    const boardPrice = Number(req.body && req.body.board_price) || 1800;

    const raw = req.body && (req.body.image || req.body.data || req.body.image_url);

    if (raw && typeof raw === 'string') {
      const trimmed = raw.trim();
      if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        imageUrl = trimmed;
      } else if (trimmed.startsWith('/uploads/') || trimmed.startsWith('/images/')) {
        const publicRoot = path.resolve(__dirname, '../../public');
        const uploadsRoot = path.join(publicRoot, 'uploads');
        const imagesRoot = path.join(publicRoot, 'images');
        const relativePath = trimmed.replace(/^\/+/, '');
        const resolved = path.resolve(publicRoot, relativePath);
        const isSafeLocal = resolved.startsWith(uploadsRoot + path.sep) || resolved.startsWith(imagesRoot + path.sep);
        if (!isSafeLocal || !fs.existsSync(resolved)) {
          return res.status(400).json({ success: false, message: 'স্থানীয় ছবির ফাইল পাওয়া যায়নি' });
        }
        const buffer = fs.readFileSync(resolved);
        const detected = detectImageMime(buffer);
        if (detected) mimeType = detected.mime;
        imageBase64 = buffer.toString('base64');
      } else {
        const mimeMatch = trimmed.match(/^data:([^;]+);base64,/);
        if (mimeMatch) {
          mimeType = mimeMatch[1];
        }
        let base64Data = trimmed;
        const prefixIndex = base64Data.indexOf(';base64,');
        if (prefixIndex !== -1) {
          base64Data = base64Data.substring(prefixIndex + 8);
        }
        imageBase64 = base64Data.replace(/\s+/g, '');
      }
    } else if (req.readable) {
      const chunks = [];
      let total = 0;
      for await (const chunk of req) {
        total += chunk.length;
        if (total > 8 * 1024 * 1024) {
          return res.status(400).json({ success: false, message: 'ছবির সাইজ সর্বোচ্চ ৫ মেগাবাইট হতে পারবে' });
        }
        chunks.push(chunk);
      }
      const rawBuf = Buffer.concat(chunks);
      const contentType = req.headers['content-type'] || '';
      let buffer = rawBuf;
      if (contentType.includes('multipart/form-data')) {
        buffer = extractMultipartFile(rawBuf, contentType);
      }
      if (buffer && buffer.length > 0) {
        const detected = detectImageMime(buffer);
        if (detected) mimeType = detected.mime;
        imageBase64 = buffer.toString('base64');
      }
    }

    if (!imageBase64 && !imageUrl) {
      return res.status(400).json({ success: false, message: 'বিশ্লেষণের জন্য ছবির ফাইল বা লিংক প্রদান করুন' });
    }

    const analysis = await inspectProductImageWithAi({
      imageBase64,
      mimeType,
      imageUrl,
      boardPrice
    });

    return res.json({
      success: true,
      analysis
    });
  } catch (error) {
    console.error('AI Image Inspection Error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'ছবি বিশ্লেষণে ত্রুটি ঘটেছে'
    });
  }
});

// ================= AI TEXT / KEYWORD COPY GENERATOR =================
router.post('/ai/generate-copy', async (req, res) => {
  try {
    const { keywords, title, category, board_price } = req.body || {};
    const inputKeywords = (keywords || title || '').trim();

    if (!inputKeywords) {
      return res.status(400).json({
        success: false,
        message: 'বিবরণ ও ক্যাপশন তৈরির জন্য পণ্যের নাম বা কিছু কীওয়ার্ড প্রদান করুন'
      });
    }

    const analysis = await generateProductCopyFromKeywords({
      keywords: inputKeywords,
      category: typeof category === 'string' ? category.trim() : '',
      boardPrice: Number(board_price) || 1800
    });

    return res.json({
      success: true,
      analysis
    });
  } catch (error) {
    console.error('AI Copy Generation Error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'বিবরণ প্রস্তুতিতে ত্রুটি ঘটেছে'
    });
  }
});

// ================= AI MULTI-CHANNEL MARKETING COPY GENERATOR =================
router.post('/ai/marketing-copy', async (req, res) => {
  try {
    let product = req.body && req.body.product;
    const productId = req.body && req.body.productId ? parseInt(req.body.productId, 10) : null;

    if (!product && productId) {
      const row = await get('SELECT * FROM products WHERE id = ?', [productId]);
      if (row) {
        product = productToClient(row);
      }
    }

    if (!product) {
      return res.status(400).json({
        success: false,
        message: 'মার্কেটিং কপি তৈরির জন্য প্রোডাক্ট তথ্য প্রয়োজন'
      });
    }

    const origin = req.protocol + '://' + req.get('host');
    const copies = generateMultiChannelMarketingCopy(product, origin);

    return res.json({
      success: true,
      copy: copies
    });
  } catch (error) {
    console.error('AI Marketing Copy Error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'মার্কেটিং কপি তৈরিতে ত্রুটি ঘটেছে'
    });
  }
});

// Quick inline update for stock, retail price, wholesale price, and reseller commission
router.patch('/products/:id/quick-update', async (req, res) => {
  try {
    const productId = Number(req.params.id);
    if (!Number.isSafeInteger(productId) || productId < 1) {
      return res.status(400).json({ success: false, message: 'প্রোডাক্ট আইডি সঠিক নয়' });
    }
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ success: false, message: 'আপডেটের তথ্য সঠিকভাবে পাঠান' });
    }

    const existing = await get('SELECT * FROM products WHERE id = ?', [productId]);
    if (!existing) {
      return res.status(404).json({ success: false, message: 'প্রোডাক্ট খুঁজে পাওয়া যায়নি' });
    }

    const { stock, regular_price, wholesale_price, reseller_commission } = req.body;
    const updates = [];
    const params = [];

    let nextRegularPaisa = Number(existing.regular_price) || 0;
    let nextWholesalePaisa = Number(existing.wholesale_price) || 0;
    let nextCommissionPaisa = Number(existing.reseller_commission) || 0;

    if (stock !== undefined) {
      const numStock = Number(stock);
      if (stock === '' || stock === null || !Number.isSafeInteger(numStock) || numStock < 0 || numStock > 1000000) {
        return res.status(400).json({ success: false, message: 'স্টক সংখ্যা ০ থেকে ১০,০০,০০০-এর মধ্যে পূর্ণসংখ্যা হতে হবে' });
      }
      updates.push('stock = ?');
      params.push(numStock);
    }

    if (regular_price !== undefined) {
      const paisa = toPaisa(regular_price);
      if (paisa === null || paisa < 100 || paisa > 50000000 * 100) {
        return res.status(400).json({ success: false, message: 'বিক্রয় মূল্য সঠিক নয় (কমপক্ষে ১ ৳)' });
      }
      nextRegularPaisa = paisa;
      updates.push('regular_price = ?');
      params.push(paisa);
    }

    if (wholesale_price !== undefined) {
      const paisa = toPaisa(wholesale_price);
      if (paisa === null || paisa < 0 || paisa > 50000000 * 100) {
        return res.status(400).json({ success: false, message: 'পাইকারি মূল্য সঠিক সংখ্যায় দিন' });
      }
      nextWholesalePaisa = paisa;
      updates.push('wholesale_price = ?');
      params.push(paisa);
    }

    if (reseller_commission !== undefined) {
      const paisa = toPaisa(reseller_commission);
      if (paisa === null || paisa < 0 || paisa > 50000000 * 100) {
        return res.status(400).json({ success: false, message: 'রিসেলার কমিশন সঠিক সংখ্যায় দিন' });
      }
      nextCommissionPaisa = paisa;
      updates.push('reseller_commission = ?');
      params.push(paisa);
      updates.push('commission_tab = ?');
      params.push(resolveCommissionTab(paisa / 100));
    }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, message: 'আপডেটের জন্য স্টক বা মূল্য প্রদান করুন' });
    }

    if (nextWholesalePaisa + nextCommissionPaisa > nextRegularPaisa) {
      return res.status(400).json({
        success: false,
        message: 'পাইকারি মূল্য ও রিসেলার কমিশনের যোগফল বিক্রয় মূল্যের চেয়ে বেশি হতে পারবে না (নেট লাভ নেগেটিভ)'
      });
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(productId);
    await run(`UPDATE products SET ${updates.join(', ')} WHERE id = ?`, params);

    const updated = await get('SELECT * FROM products WHERE id = ?', [productId]);
    return res.json({
      success: true,
      message: 'প্রোডাক্ট তথ্য সফলভাবে আপডেট হয়েছে',
      product: productToClient(updated)
    });
  } catch (error) {
    console.error('Quick Update Product Error:', error);
    return res.status(500).json({ success: false, message: 'প্রোডাক্ট আপডেট করতে ব্যর্থ হয়েছে' });
  }
});

// ================= SHOPS & PARTNER LEDGER MANAGEMENT =================
// List all shops with metrics
router.get('/shops', async (req, res) => {
  try {
    const shops = await query(`
      SELECT
        s.*,
        (SELECT COUNT(*) FROM products WHERE (shop_id = s.id OR shop_name = s.name) AND is_active = 1) as products_count,
        COALESCE((
          SELECT SUM(oi.quantity)
          FROM order_items oi
          JOIN orders o ON oi.order_id = o.id
          WHERE (oi.shop_id = s.id OR oi.shop_name = s.name) AND o.status = 'delivered'
        ), 0) as delivered_units,
        COALESCE((
          SELECT SUM(oi.unit_wholesale_price * oi.quantity)
          FROM order_items oi
          JOIN orders o ON oi.order_id = o.id
          WHERE (oi.shop_id = s.id OR oi.shop_name = s.name) AND o.status = 'delivered' AND o.partner_settled = 0
        ), 0) as wholesale_owed,
        COALESCE((
          SELECT SUM(amount) FROM shop_settlements WHERE shop_id = s.id
        ), 0) as wholesale_settled
      FROM shops s
      ORDER BY s.id ASC
    `);

    return res.json({
      success: true,
      shops: shops.map((s) => takaFields(s, ['wholesale_owed', 'wholesale_settled']))
    });
  } catch (error) {
    console.error('Fetch Shops Error:', error);
    return res.status(500).json({ success: false, message: 'শপ তালিকা লোড করতে ব্যর্থ হয়েছে' });
  }
});

// Create a new shop (Own or Partner)
router.post('/shops', async (req, res) => {
  try {
    const { name, shop_type, phone, address, contact_person } = req.body;
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) {
      return res.status(400).json({ success: false, message: 'শপের নাম আবশ্যক (১০০ অক্ষরের মধ্যে)' });
    }
    const cleanType = ['own', 'partner'].includes(shop_type) ? shop_type : 'partner';

    const existing = await get('SELECT id FROM shops WHERE name = ?', [name.trim()]);
    if (existing) {
      return res.status(400).json({ success: false, message: 'এই নামের শপ ইতিমধ্যে নিবন্ধিত রয়েছে' });
    }

    const result = await run(
      `INSERT INTO shops (name, shop_type, phone, address, contact_person) VALUES (?, ?, ?, ?, ?)`,
      [name.trim(), cleanType, phone ? String(phone).trim() : null, address ? String(address).trim() : null, contact_person ? String(contact_person).trim() : null]
    );

    return res.status(201).json({
      success: true,
      message: 'শপ সফলভাবে তৈরি করা হয়েছে!',
      id: result.lastID
    });
  } catch (error) {
    console.error('Create Shop Error:', error);
    return res.status(500).json({ success: false, message: 'শপ তৈরিতে ব্যর্থ হয়েছে' });
  }
});

// Update an existing shop
router.put('/shops/:id', async (req, res) => {
  try {
    const shopId = Number(req.params.id);
    if (!Number.isSafeInteger(shopId) || shopId < 1) {
      return res.status(400).json({ success: false, message: 'শপ আইডি সঠিক নয়' });
    }
    const { name, shop_type, phone, address, contact_person, is_active } = req.body;
    const shop = await get('SELECT * FROM shops WHERE id = ?', [shopId]);
    if (!shop) return res.status(404).json({ success: false, message: 'শপ পাওয়া যায়নি' });

    await run(
      `UPDATE shops SET
        name = COALESCE(?, name),
        shop_type = COALESCE(?, shop_type),
        phone = COALESCE(?, phone),
        address = COALESCE(?, address),
        contact_person = COALESCE(?, contact_person),
        is_active = COALESCE(?, is_active),
        updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        name ? name.trim() : null,
        shop_type && ['own', 'partner'].includes(shop_type) ? shop_type : null,
        phone !== undefined ? (phone ? String(phone).trim() : null) : null,
        address !== undefined ? (address ? String(address).trim() : null) : null,
        contact_person !== undefined ? (contact_person ? String(contact_person).trim() : null) : null,
        is_active !== undefined ? Number(is_active) : null,
        shopId
      ]
    );

    return res.json({ success: true, message: 'শপ তথ্য সফলভাবে আপডেট হয়েছে!' });
  } catch (error) {
    console.error('Update Shop Error:', error);
    return res.status(500).json({ success: false, message: 'শপ আপডেট ব্যর্থ হয়েছে' });
  }
});

// Settle Partner Shop wholesale payable
router.post('/shops/:id/settle', async (req, res) => {
  try {
    const shopId = Number(req.params.id);
    if (!Number.isSafeInteger(shopId) || shopId < 1) {
      return res.status(400).json({ success: false, message: 'শপ আইডি সঠিক নয়' });
    }
    const shop = await get('SELECT * FROM shops WHERE id = ?', [shopId]);
    if (!shop) return res.status(404).json({ success: false, message: 'শপ পাওয়া যায়নি' });

    const { amount, trx_id, notes } = req.body;
    const parsedAmount = toPaisa(amount);
    if (parsedAmount === null || parsedAmount <= 0) {
      return res.status(400).json({ success: false, message: 'সঠিক পরিশোধকৃত টাকার পরিমাণ দিন' });
    }

    await withTransaction(async ({ run: txRun, query: txQuery }) => {
      // Find unsettled delivered orders for this shop
      const unsettledOrders = await txQuery(
        `SELECT DISTINCT o.id
         FROM orders o
         JOIN order_items oi ON o.id = oi.order_id
         WHERE (oi.shop_id = ? OR oi.shop_name = ?) AND o.status = 'delivered' AND o.partner_settled = 0`,
        [shopId, shop.name]
      );

      // Mark them as partner_settled
      for (const ord of unsettledOrders) {
        await txRun('UPDATE orders SET partner_settled = 1 WHERE id = ?', [ord.id]);
      }

      const adminId = req.user ? req.user.id : null;
      await txRun(
        `INSERT INTO shop_settlements (
          shop_id, amount, orders_count, trx_id, notes, settled_by_admin_id
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          shopId,
          parsedAmount,
          unsettledOrders.length,
          trx_id ? String(trx_id).trim() : null,
          notes ? String(notes).trim() : null,
          adminId
        ]
      );
    });

    return res.json({
      success: true,
      message: `${shop.name}-এর পাইকারি পাওনা ৳${fromPaisa(parsedAmount)} সফলভাবে পরিশোধ রেকর্ড করা হয়েছে!`
    });
  } catch (error) {
    console.error('Shop Settlement Error:', error);
    return res.status(500).json({ success: false, message: 'শপ সেটেলমেন্ট রেকর্ড করতে ব্যর্থ হয়েছে' });
  }
});

// Shop settlement history
router.get('/shops/:id/settlements', async (req, res) => {
  try {
    const shopId = Number(req.params.id);
    const settlements = await query(
      `SELECT ss.*, u.name as admin_name
       FROM shop_settlements ss
       LEFT JOIN users u ON ss.settled_by_admin_id = u.id
       WHERE ss.shop_id = ?
       ORDER BY ss.id DESC`,
      [shopId]
    );
    return res.json({
      success: true,
      settlements: settlements.map((s) => takaFields(s, ['amount']))
    });
  } catch (error) {
    console.error('Fetch Settlements Error:', error);
    return res.status(500).json({ success: false, message: 'সেটেলমেন্ট রেকর্ড লোড ব্যর্থ হয়েছে' });
  }
});

// ================= RESELLER ACCOUNTS MANAGEMENT =================
// List resellers with stats and balances
router.get('/resellers', async (req, res) => {
  try {
    const resellers = await query(`
      SELECT
        u.id,
        u.name,
        u.phone,
        u.role,
        u.status,
        u.referral_code,
        u.payout_method,
        u.payout_number,
        u.created_at,
        COUNT(DISTINCT CASE WHEN o.status = 'delivered' THEN o.id END) as delivered_sales_count,
        COALESCE(SUM(CASE WHEN o.status = 'delivered' THEN o.total_amount ELSE 0 END), 0) as total_volume,
        COALESCE((
          SELECT SUM(amount) FROM wallet_transactions
          WHERE user_id = u.id AND status IN ('available', 'completed') AND type IN ('commission', 'referral_commission')
        ), 0) as total_commission_earned,
        COALESCE((
          SELECT SUM(amount) FROM wallet_transactions
          WHERE user_id = u.id AND status = 'pending' AND type IN ('commission', 'referral_commission')
        ), 0) as pending_commission,
        COALESCE((
          SELECT SUM(amount) FROM wallet_transactions
          WHERE user_id = u.id AND type = 'payout' AND status IN ('pending', 'approved', 'completed')
        ), 0) as payout_committed
      FROM users u
      LEFT JOIN orders o ON u.id = o.reseller_id
      WHERE u.role = 'reseller'
      GROUP BY u.id
      ORDER BY u.id DESC
    `);

    return res.json({
      success: true,
      resellers: resellers.map((r) => {
        const converted = takaFields(r, ['total_volume', 'total_commission_earned', 'pending_commission', 'payout_committed']);
        converted.available_balance = Math.max(0, (converted.total_commission_earned || 0) - (converted.payout_committed || 0));
        return converted;
      })
    });
  } catch (error) {
    console.error('Fetch Resellers Error:', error);
    return res.status(500).json({ success: false, message: 'রিসেলার তালিকা লোড ব্যর্থ হয়েছে' });
  }
});

// Toggle reseller account status (active vs suspended)
router.put('/resellers/:id/status', async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const { status } = req.body;
    if (!Number.isSafeInteger(userId) || userId < 1) {
      return res.status(400).json({ success: false, message: 'ইউজার আইডি সঠিক নয়' });
    }
    if (!['active', 'suspended'].includes(status)) {
      return res.status(400).json({ success: false, message: 'অবৈধ স্ট্যাটাস (active বা suspended হতে হবে)' });
    }

    await run('UPDATE users SET status = ? WHERE id = ?', [status, userId]);

    return res.json({
      success: true,
      message: `রিসেলার অ্যাকাউন্ট সফলভাবে ${status === 'active' ? 'সক্রিয় (Active)' : 'স্থগিত (Suspended)'} করা হয়েছে!`
    });
  } catch (error) {
    console.error('Update Reseller Status Error:', error);
    return res.status(500).json({ success: false, message: 'রিসেলার স্ট্যাটাস আপডেট ব্যর্থ হয়েছে' });
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
    const validation = validateAnnouncementPayload(req.body);
    if (validation.error) return res.status(400).json({ success: false, message: validation.error });
    const announcement = validation.data;

    const result = await run(
      'INSERT INTO announcements (title, message, type, is_active) VALUES (?, ?, ?, ?)',
      [announcement.title, announcement.message, announcement.type, announcement.is_active]
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
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ success: false, message: 'ঘোষণার আইডি সঠিক নয়' });

    const ann = await get('SELECT * FROM announcements WHERE id = ?', [id]);
    if (!ann) {
      return res.status(404).json({ success: false, message: 'ঘোষণাটি পাওয়া যায়নি' });
    }

    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ success: false, message: 'ঘোষণার তথ্য সঠিকভাবে পাঠান' });
    }
    const validation = validateAnnouncementPayload({ ...ann, ...req.body });
    if (validation.error) return res.status(400).json({ success: false, message: validation.error });
    const announcement = validation.data;

    await run(
      'UPDATE announcements SET title = ?, message = ?, type = ?, is_active = ? WHERE id = ?',
      [
        announcement.title,
        announcement.message,
        announcement.type,
        announcement.is_active,
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
const { getFirebaseBackupStatus } = require('../firebaseBackup');

// Trigger instant manual SQLite backup
router.post('/backup', async (req, res) => {
  try {
    const backupInfo = await performBackup();
    return res.json({
      success: true,
      message: 'ডাটাবেজ সফলভাবে ব্যাকআপ নেওয়া হয়েছে!',
      backup: backupInfo,
      firebaseBackup: getFirebaseBackupStatus()
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
      backups,
      firebaseBackup: getFirebaseBackupStatus()
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

