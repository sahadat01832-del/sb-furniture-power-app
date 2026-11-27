const express = require('express');
const router = express.Router();
const { query, get } = require('../db');
const config = require('../config');
const { toPaisa, takaFields } = require('../money');
const { optionalAuth } = require('../auth');
const { createDiscoverySeed, rankCatalogProducts } = require('../../public/js/catalog-algorithm');

// Money is stored as INTEGER paisa; the API and UI work in taka.
// Commission is limited to approved resellers/admins. Partner identity and
// contact details stay private for every storefront visitor.
const productToClient = (product, includeCommission = false) => {
  if (!product) return product;
  const converted = takaFields(product, includeCommission ? ['regular_price', 'reseller_commission'] : ['regular_price']);
  converted.selling_price = converted.regular_price;
  delete converted.wholesale_price;
  delete converted.shop_id;
  delete converted.shop_name;
  delete converted.shop_type;
  delete converted.vendor_phone;
  delete converted.vendor_badge;
  delete converted.vendor_address;
  if (!includeCommission) {
    delete converted.reseller_commission;
    delete converted.commission_tab;
  }
  if (converted.furniture_cutlist && typeof converted.furniture_cutlist === 'string') {
    try {
      converted.furniture_cutlist = JSON.parse(converted.furniture_cutlist);
    } catch (e) {
      converted.furniture_cutlist = null;
    }
  }
  return converted;
};

const canViewCommission = (req) => Boolean(req.user && ['reseller', 'admin'].includes(req.user.role));
const preventProductCaching = (req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  res.vary('Authorization');
  next();
};

// Categories & Filter Meta
router.get('/meta/categories', preventProductCaching, async (req, res) => {
  try {
    const cats = await query('SELECT DISTINCT category FROM products WHERE is_active = 1 ORDER BY category ASC');
    const brands = await query('SELECT DISTINCT brand FROM products WHERE is_active = 1 ORDER BY brand ASC');
    return res.json({
      success: true,
      categories: cats.map((c) => c.category),
      brands: brands.map((b) => b.brand)
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'ক্যাটাগরি লোড ব্যর্থ হয়েছে' });
  }
});

// Get all products with filters, search, price range, sorting, and pagination
router.get('/', preventProductCaching, optionalAuth, async (req, res) => {
  try {
    const { tab, category, brand, shop, search, min_price, max_price, sort, page, limit, seed } = req.query;

    const scalarFilters = { tab, category, brand, shop, search, min_price, max_price, sort, page, limit, seed };
    if (Object.values(scalarFilters).some((value) => value !== undefined && typeof value !== 'string')) {
      return res.status(400).json({ success: false, message: 'পণ্যের ফিল্টার সঠিকভাবে দিন' });
    }
    if (seed !== undefined && (!/^\d{1,12}$/.test(seed) || Number(seed) < 1)) {
      return res.status(400).json({ success: false, message: 'ফিড সীড সঠিক নয়' });
    }
    if (search && search.trim().length > 100) {
      return res.status(400).json({ success: false, message: 'সার্চের লেখা ১০০ অক্ষরের মধ্যে দিন' });
    }
    if (tab && tab !== 'all' && !['50tk', '100tk', '200tk', '500tk', '1000tk', '1500tk'].includes(tab)) {
      return res.status(400).json({ success: false, message: 'কমিশন ফিল্টার সঠিক নয়' });
    }
    if (brand && brand !== 'all' && !['SB Furniture', 'SB POWER', 'SB Lifestyle & Tools'].includes(brand)) {
      return res.status(400).json({ success: false, message: 'ব্র্যান্ড ফিল্টার সঠিক নয়' });
    }
    if (shop && shop !== 'all') {
      return res.status(400).json({ success: false, message: 'পণ্য খুঁজতে দোকানের ফিল্টার ব্যবহার করা যাবে না' });
    }
    const pricePattern = /^(?:0|[1-9]\d{0,8})(?:\.\d{1,2})?$/;
    if ((min_price !== undefined && !pricePattern.test(min_price)) || (max_price !== undefined && !pricePattern.test(max_price))) {
      return res.status(400).json({ success: false, message: 'দামের ফিল্টার সঠিক সংখ্যা হতে হবে' });
    }
    if (page !== undefined && (!/^\d{1,7}$/.test(page) || Number(page) < 1)) {
      return res.status(400).json({ success: false, message: 'পৃষ্ঠা নম্বর সঠিক নয়' });
    }
    if (limit !== undefined && (!/^\d{1,3}$/.test(limit) || Number(limit) < 1)) {
      return res.status(400).json({ success: false, message: 'প্রতি পৃষ্ঠার পণ্যের সংখ্যা সঠিক নয়' });
    }

    let whereSql = ' WHERE is_active = 1';
    const params = [];

    const resellerView = canViewCommission(req);

    // Commission filters are unavailable to ordinary customers.
    if (tab && tab !== 'all') {
      if (!resellerView) {
        return res.status(403).json({ success: false, message: 'কমিশন দেখতে রিসেলার অনুমোদন প্রয়োজন' });
      }
      whereSql += ' AND commission_tab = ?';
      params.push(tab);
    }

    // Category filter
    if (category && category !== 'all') {
      whereSql += ' AND category = ?';
      params.push(category);
    }

    // Brand filter ('SB Furniture', 'SB POWER')
    if (brand && brand !== 'all') {
      whereSql += ' AND brand = ?';
      params.push(brand);
    }

    // Search query
    if (search && search.trim()) {
      whereSql += ' AND (title LIKE ? OR sku LIKE ? OR description LIKE ? OR materials LIKE ? OR finish LIKE ?)';
      const term = `%${search.trim()}%`;
      params.push(term, term, term, term, term);
    }

    // Price range filters
    const minPricePaisa = toPaisa(min_price);
    if (minPricePaisa !== null) {
      whereSql += ' AND regular_price >= ?';
      params.push(minPricePaisa);
    }
    const maxPricePaisa = toPaisa(max_price);
    if (maxPricePaisa !== null) {
      whereSql += ' AND regular_price <= ?';
      params.push(maxPricePaisa);
    }

    // Total count for pagination
    const totalCountRow = await get(`SELECT COUNT(*) as total FROM products ${whereSql}`, params);
    const totalCount = totalCountRow ? totalCountRow.total : 0;

    // Pagination & Sorting
    const parsedPage = page === undefined ? NaN : Number(page);
    const parsedLimit = limit === undefined ? NaN : Math.min(Number(limit), 100);
    const effectiveLimit = !isNaN(parsedLimit) && parsedLimit > 0 ? parsedLimit : (!isNaN(parsedPage) && parsedPage > 0 ? 20 : null);
    const offset = !isNaN(parsedPage) && parsedPage > 0 && effectiveLimit ? (parsedPage - 1) * effectiveLimit : 0;

    if (sort === 'commission_desc' && !resellerView) {
      return res.status(403).json({ success: false, message: 'কমিশন অনুযায়ী সাজাতে রিসেলার অনুমোদন প্রয়োজন' });
    }

    const explicitSqlSorts = ['price_asc', 'price_desc', 'commission_desc', 'newest', 'id_asc'];
    let products;
    let discoverySeedUsed = null;

    if (explicitSqlSorts.includes(sort)) {
      let orderSql = ' ORDER BY id ASC';
      if (sort === 'price_asc') {
        orderSql = ' ORDER BY regular_price ASC, id ASC';
      } else if (sort === 'price_desc') {
        orderSql = ' ORDER BY regular_price DESC, id DESC';
      } else if (sort === 'commission_desc') {
        orderSql = ' ORDER BY reseller_commission DESC, id DESC';
      } else if (sort === 'newest') {
        orderSql = ' ORDER BY id DESC';
      }

      let paginationSql = '';
      const queryParams = [...params];
      if (!isNaN(parsedPage) && parsedPage > 0 && effectiveLimit) {
        paginationSql = ' LIMIT ? OFFSET ?';
        queryParams.push(effectiveLimit, offset);
      } else if (effectiveLimit) {
        paginationSql = ' LIMIT ?';
        queryParams.push(effectiveLimit);
      }

      products = await query(`SELECT * FROM products ${whereSql} ${orderSql} ${paginationSql}`, queryParams);
    } else {
      // Smart discovery feed: stable across multi-page requests unless caller supplies a seed
      discoverySeedUsed = seed !== undefined
        ? (Number(seed) >>> 0) || 1
        : (effectiveLimit && !isNaN(parsedPage) && parsedPage > 0
          ? ((Math.floor(Date.now() / (15 * 60 * 1000)) >>> 0) || 1)
          : createDiscoverySeed());

      const matchingRows = await query(`SELECT * FROM products ${whereSql} ORDER BY id ASC`, params);
      const rankedRows = rankCatalogProducts(matchingRows, {
        sort: 'discovery',
        seed: discoverySeedUsed,
        searchQuery: search || ''
      });
      products = effectiveLimit ? rankedRows.slice(offset, offset + effectiveLimit) : rankedRows;
    }

    const response = {
      success: true,
      reseller_access: resellerView,
      account_role: req.user ? req.user.role : null,
      count: products.length,
      total: totalCount,
      products: products.map((product) => productToClient(product, resellerView))
    };
    if (discoverySeedUsed !== null) {
      response.discovery_seed = discoverySeedUsed;
    }

    if (!isNaN(parsedPage) && parsedPage > 0 && effectiveLimit) {
      response.current_page = parsedPage;
      response.limit = effectiveLimit;
      response.total_pages = Math.ceil(totalCount / effectiveLimit);
    }

    return res.json(response);
  } catch (error) {
    console.error('Fetch Products Error:', error);
    return res.status(500).json({ success: false, message: 'পণ্য লোড করতে ব্যর্থ হয়েছে' });
  }
});

// Get single product by ID or SKU
router.get('/:idOrSku', preventProductCaching, optionalAuth, async (req, res) => {
  try {
    const param = req.params.idOrSku;
    let product;

    if (/^\d+$/.test(param)) {
      product = await get('SELECT * FROM products WHERE id = ? AND is_active = 1', [parseInt(param, 10)]);
    } else {
      product = await get('SELECT * FROM products WHERE sku = ? AND is_active = 1', [param.toUpperCase()]);
    }

    if (!product) {
      return res.status(404).json({ success: false, message: 'পণ্যটি খুঁজে পাওয়া যায়নি' });
    }

    const resellerView = canViewCommission(req);
    product = productToClient(product, resellerView);

    // Generate brand-specific copy preview
    const isFurniture = product.brand === 'SB Furniture';
    const isLifestyle = product.brand === 'SB Lifestyle & Tools';
    const contactPhone = isFurniture ? config.SB_FURNITURE.phone : config.SB_POWER.phone;
    const trustLine = isFurniture
      ? config.SB_FURNITURE.trust_line
      : isLifestyle
        ? 'SB Lifestyle & Tools-এর পণ্য; কন্ডিশন ও বিবরণ দেখে অর্ডার করুন।'
        : 'SB POWER-এর গ্যাজেট; পণ্যের ব্র্যান্ড ও বিবরণ দেখে অর্ডার করুন।';

    if (req.query.ref !== undefined && (typeof req.query.ref !== 'string' || req.query.ref.length > 40 || !/^[a-z0-9_-]*$/i.test(req.query.ref))) {
      return res.status(400).json({ success: false, message: 'রেফারেল কোড সঠিক নয়' });
    }
    const refCode = req.query.ref ? req.query.ref.trim().toUpperCase() : '';
    const productLink = refCode ? `/?ref=${refCode}&sku=${product.sku}` : `/?sku=${product.sku}`;

    let socialShareText = `🔥 ${product.title}\n`;
    socialShareText += `💵 মূল্য: ${product.regular_price} ৳\n`;
    if (product.materials) socialShareText += `🪵 ম্যাটেরিয়াল: ${product.materials}\n`;
    if (product.finish) socialShareText += `🎨 ফিনিশ: ${product.finish}\n`;
    if (product.description) socialShareText += `📌 বিবরণ: ${product.description}\n`;
    if (trustLine) socialShareText += `\n✅ ${trustLine}\n`;
    socialShareText += `\n📦 সরাসরি অর্ডার করতে বা বিস্তারিত জানতে WhatsApp / Call: ${contactPhone}\n`;
    socialShareText += `🌐 সরাসরি অনলাইন অর্ডার লিংক: ${productLink}`;

    return res.json({
      success: true,
      product: {
        ...product,
        share_copy: socialShareText,
        contact_phone: contactPhone,
        product_link: productLink
      }
    });
  } catch (error) {
    console.error('Single Product Error:', error);
    return res.status(500).json({ success: false, message: 'সার্ভার ত্রুটি' });
  }
});

module.exports = router;
