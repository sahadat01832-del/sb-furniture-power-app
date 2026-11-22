const express = require('express');
const router = express.Router();
const { query, get } = require('../db');
const config = require('../config');

// Categories & Filter Meta
router.get('/meta/categories', async (req, res) => {
  try {
    const cats = await query('SELECT DISTINCT category FROM products WHERE is_active = 1 ORDER BY category ASC');
    const brands = await query('SELECT DISTINCT brand FROM products WHERE is_active = 1 ORDER BY brand ASC');
    const shops = await query('SELECT DISTINCT shop_name FROM products WHERE is_active = 1 AND shop_name IS NOT NULL ORDER BY shop_name ASC');
    return res.json({
      success: true,
      categories: cats.map((c) => c.category),
      brands: brands.map((b) => b.brand),
      shops: shops.map((s) => s.shop_name)
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'ক্যাটাগরি লোড ব্যর্থ হয়েছে' });
  }
});

// Get all products with filters, search, price range, sorting, and pagination
router.get('/', async (req, res) => {
  try {
    const { tab, category, brand, shop, search, min_price, max_price, sort, page, limit } = req.query;

    let whereSql = ' WHERE is_active = 1';
    const params = [];

    // Commission tab filter ('50tk', '100tk', '500tk', '1000tk')
    if (tab && tab !== 'all') {
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

    // Shop/Vendor filter ('SB Furniture', 'SB POWER', 'partner', or custom shop name)
    if (shop && shop !== 'all') {
      if (shop.toLowerCase() === 'partner') {
        whereSql += " AND shop_name NOT IN ('SB Furniture', 'SB POWER') AND shop_name IS NOT NULL";
      } else {
        whereSql += ' AND (shop_name = ? OR brand = ?)';
        params.push(shop, shop);
      }
    }

    // Search query
    if (search && search.trim()) {
      whereSql += ' AND (title LIKE ? OR sku LIKE ? OR description LIKE ? OR shop_name LIKE ? OR materials LIKE ? OR finish LIKE ?)';
      const term = `%${search.trim()}%`;
      params.push(term, term, term, term, term, term);
    }

    // Price range filters
    if (min_price !== undefined && min_price !== '' && !isNaN(parseFloat(min_price))) {
      whereSql += ' AND regular_price >= ?';
      params.push(parseFloat(min_price));
    }
    if (max_price !== undefined && max_price !== '' && !isNaN(parseFloat(max_price))) {
      whereSql += ' AND regular_price <= ?';
      params.push(parseFloat(max_price));
    }

    // Total count for pagination
    const totalCountRow = await get(`SELECT COUNT(*) as total FROM products ${whereSql}`, params);
    const totalCount = totalCountRow ? totalCountRow.total : 0;

    // Sorting
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

    // Pagination
    let paginationSql = '';
    const queryParams = [...params];
    const parsedPage = parseInt(page, 10);
    const parsedLimit = parseInt(limit, 10);
    const effectiveLimit = !isNaN(parsedLimit) && parsedLimit > 0 ? parsedLimit : (!isNaN(parsedPage) && parsedPage > 0 ? 20 : null);

    if (!isNaN(parsedPage) && parsedPage > 0 && effectiveLimit) {
      const offset = (parsedPage - 1) * effectiveLimit;
      paginationSql = ' LIMIT ? OFFSET ?';
      queryParams.push(effectiveLimit, offset);
    } else if (effectiveLimit) {
      paginationSql = ' LIMIT ?';
      queryParams.push(effectiveLimit);
    }

    const products = await query(`SELECT * FROM products ${whereSql} ${orderSql} ${paginationSql}`, queryParams);

    const response = {
      success: true,
      count: products.length,
      total: totalCount,
      products
    };

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
router.get('/:idOrSku', async (req, res) => {
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

    // Generate brand-specific copy preview
    const isFurniture = product.brand === 'SB Furniture';
    let contactPhone = isFurniture ? config.SB_FURNITURE.phone : config.SB_POWER.phone;
    if (product.vendor_phone) {
      contactPhone = product.vendor_phone;
    }

    const isPartnerShop = product.shop_name && !['SB Furniture', 'SB POWER'].includes(product.shop_name);
    const trustLine = isPartnerShop
      ? `🏪 ${product.shop_name} — আমাদের ভেরিফাইড পার্টনার শপের সেরা কোয়ালিটি প্রোডাক্ট!`
      : (isFurniture ? config.SB_FURNITURE.trust_line : 'সাশ্রয়ী মূল্যে ১০০% অরিজিনাল সাউন্ড ও গ্যাজেটের সেরা কালেকশন!');

    const refCode = req.query.ref ? req.query.ref.trim().toUpperCase() : '';
    const productLink = refCode ? `/?ref=${refCode}&sku=${product.sku}` : `/?sku=${product.sku}`;

    let socialShareText = `🔥 ${product.title}\n`;
    socialShareText += `💵 মূল্য: ${product.regular_price} ৳\n`;
    if (isPartnerShop) {
      socialShareText += `🏪 শপ/ভেন্ডর: ${product.shop_name}${product.vendor_badge ? ' (' + product.vendor_badge + ')' : ''}\n`;
    }
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
