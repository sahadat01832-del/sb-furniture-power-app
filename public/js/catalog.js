// ============================================================
// SB Furniture & SB POWER — Catalog & Social Sharing Module
// ============================================================

let allProducts = [];
let currentTab = 'all';
let currentCategory = 'all';
let currentBrand = 'all';
let currentShop = 'all';
let currentSort = 'default';
let minPrice = '';
let maxPrice = '';
let searchQuery = '';
let searchTimeout;
let priceFilterTimeout;

// Load Products from API
async function loadProducts() {
  const grid = document.getElementById('productGrid');
  if (!grid) return;
  grid.innerHTML = `
    <div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: var(--sbf-text-muted);">
      <span class="spinner"></span>
      <div style="margin-top: 10px; font-size: 0.9rem;">পণ্য লোড হচ্ছে, অনুগ্রহ করে অপেক্ষা করুন...</div>
    </div>
  `;

  try {
    const endpoint = `/api/products?tab=${encodeURIComponent(currentTab)}&category=${encodeURIComponent(currentCategory)}&brand=${encodeURIComponent(currentBrand)}&shop=${encodeURIComponent(currentShop)}&sort=${encodeURIComponent(currentSort)}`;
    let queryParams = '';
    if (searchQuery.trim()) {
      queryParams += `&search=${encodeURIComponent(searchQuery.trim())}`;
    }
    if (minPrice !== '') {
      queryParams += `&min_price=${encodeURIComponent(minPrice)}`;
    }
    if (maxPrice !== '') {
      queryParams += `&max_price=${encodeURIComponent(maxPrice)}`;
    }

    const fullEndpoint = endpoint + queryParams;
    const fetchUrl = typeof apiUrl === 'function' ? apiUrl(fullEndpoint) : fullEndpoint;
    const res = await fetch(fetchUrl);
    const data = await res.json();

    if (data.success && data.products) {
      allProducts = data.products;
      renderProductGrid(data.products);

      // Deep linking: If URL has ?sku=..., automatically open product detail modal
      const urlSku = new URLSearchParams(window.location.search).get('sku');
      if (urlSku && !window._skuOpened) {
        window._skuOpened = true;
        const targetItem = allProducts.find((p) => p.sku.toUpperCase() === urlSku.trim().toUpperCase());
        if (targetItem) {
          viewProductDetails(targetItem.id);
        }
      }
    } else {
      grid.innerHTML = `
        <div style="grid-column: 1 / -1; text-align: center; padding: 40px;">
          <div style="color: var(--sbp-red); font-size: 1rem; margin-bottom: 12px;">পণ্য লোড করতে ব্যর্থ হয়েছে।</div>
          <button class="btn-submit" style="margin: 0 auto; max-width: 200px;" onclick="loadProducts()">🔄 আবার চেষ্টা করুন</button>
        </div>
      `;
    }
  } catch (err) {
    console.error('Failed to load products:', err);
    grid.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 40px;">
        <div style="color: var(--sbp-red); font-size: 1rem; margin-bottom: 12px;">সার্ভার সংযোগ পেতে সমস্যা হচ্ছে বা ক্লাউড সার্ভার প্রস্তুত হচ্ছে।</div>
        <button class="btn-submit" style="margin: 0 auto; max-width: 200px;" onclick="loadProducts()">🔄 আবার চেষ্টা করুন</button>
      </div>
    `;
  }
}

// Open Custom Order Hotline Modal
function openCustomOrderModal() {
  openModal('customOrderModal');
}

// Handle Order button on product cards
function handleOrderButtonClick(productId) {
  const item = allProducts.find((p) => p.id === productId);
  if (!item) return;
  // If product requires color selection (such as P9 Wireless Headset SBP-103), open modal
  if (item.sku === 'SBP-103' || (item.finish && item.finish.includes('কালার'))) {
    viewProductDetails(item.id);
  } else {
    addToCart(item.id);
  }
}

// Render Product Grid
function renderProductGrid(products) {
  const grid = document.getElementById('productGrid');
  if (!products || products.length === 0) {
    grid.innerHTML = '<div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: var(--sbf-text-muted);">কোনো পণ্য খুঁজে পাওয়া যায়নি।</div>';
    return;
  }

  grid.innerHTML = products.map((item) => {
    const isFurniture = item.brand === 'SB Furniture';
    const isPartner = item.shop_name && !['SB Furniture', 'SB POWER'].includes(item.shop_name);
    const brandBadgeClass = isPartner ? 'brand-partner' : (isFurniture ? 'brand-furniture' : 'brand-power');
    const brandDisplay = isPartner ? `🏪 ${item.shop_name}` : item.brand;

    return `
      <div class="product-card">
        <div class="product-thumb-wrap" onclick="viewProductDetails(${item.id})">
          <img src="${item.image_url}" alt="${item.title}" class="product-thumb" loading="lazy">
          <span class="badge-sku">${item.sku}</span>
          <span class="badge-commission">কমিশন ${item.reseller_commission}৳</span>
          <span class="badge-brand ${brandBadgeClass}">${brandDisplay}</span>
          ${item.vendor_badge ? `<span class="badge-vendor-verified">✓ ${item.vendor_badge}</span>` : ''}
        </div>
        <div class="product-body">
          <h4 class="product-title" onclick="viewProductDetails(${item.id})">${item.title}</h4>
          <div class="product-meta-row">
            <span>${item.category}</span>
            ${item.finish ? ` • <span>${item.finish}</span>` : ''}
          </div>
          <div class="product-price-row">
            <div class="price-box">
              <span class="price-label">বিক্রয় মূল্য</span>
              <span class="price-val">${item.regular_price} ৳</span>
            </div>
            <div class="commission-box">
              <span class="commission-label">আপনার লাভ</span>
              <span class="commission-val">+${item.reseller_commission} ৳</span>
            </div>
          </div>
          <div class="product-actions">
            <button class="btn-share" onclick="copyProductShareCopy(${item.id})" title="ক্যাপশন কপি">
              <span>📋</span> শেয়ার
            </button>
            <button class="btn-wa" onclick="orderViaWhatsApp(${item.id})" title="সরাসরি WhatsApp অর্ডার">
              <span>💬</span> WhatsApp
            </button>
            <button class="btn-order" onclick="handleOrderButtonClick(${item.id})" title="কার্টে যোগ করুন">
              <span>🛒</span> অর্ডার
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// Tab Filtering
function filterByTab(tabName) {
  currentTab = tabName;
  document.querySelectorAll('.commission-tabs-wrap .tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  loadProducts();
}

// Category Filtering
function filterByCategory(catName) {
  currentCategory = catName;
  document.querySelectorAll('.category-pills .cat-pill').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.cat === catName);
  });
  loadProducts();
}

// Shop/Vendor Filtering
function filterByShop(shopName) {
  currentShop = shopName;
  document.querySelectorAll('.shop-filter-wrap .shop-pill').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.shop === shopName);
  });
  loadProducts();
}

// Search Handler
function handleSearch() {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    searchQuery = document.getElementById('searchInput').value;
    loadProducts();
  }, 300);
}

// Sort Handler
function handleSortChange() {
  const sortEl = document.getElementById('sortSelect');
  currentSort = sortEl ? sortEl.value : 'default';
  loadProducts();
}

// Price Filter Handler
function handlePriceFilter() {
  clearTimeout(priceFilterTimeout);
  priceFilterTimeout = setTimeout(() => {
    const minEl = document.getElementById('minPriceInput');
    const maxEl = document.getElementById('maxPriceInput');
    minPrice = minEl && minEl.value ? minEl.value.trim() : '';
    maxPrice = maxEl && maxEl.value ? maxEl.value.trim() : '';
    loadProducts();
  }, 350);
}

// Direct 1-Click WhatsApp Instant Order
function orderViaWhatsApp(productId) {
  const item = allProducts.find((p) => p.id === productId);
  if (!item) return;

  const isFurniture = item.brand === 'SB Furniture';
  let phone = item.vendor_phone || (isFurniture ? '01929621855' : '01634664224');
  let cleanPhone = phone.replace(/\D/g, '');
  if (cleanPhone.startsWith('01')) {
    cleanPhone = '88' + cleanPhone;
  } else if (cleanPhone.startsWith('1') && cleanPhone.length === 10) {
    cleanPhone = '880' + cleanPhone;
  } else if (!cleanPhone.startsWith('88')) {
    cleanPhone = '88' + cleanPhone;
  }

  const activeUser = (typeof currentUser !== 'undefined' && currentUser) ? currentUser : JSON.parse(localStorage.getItem('sb_user') || 'null');
  const refCode = activeUser ? activeUser.referral_code : (localStorage.getItem('sb_ref_code') || '');
  const appBaseUrl = window.location.origin;
  const productLink = refCode ? `${appBaseUrl}/?ref=${refCode}&sku=${item.sku}` : `${appBaseUrl}/?sku=${item.sku}`;

  let msg = `আসসালামু আলাইকুম, আমি সরাসরি এই পণ্যটি অর্ডার করতে চাই:\n\n`;
  msg += `🏷️ প্রোডাক্ট: ${item.title}\n`;
  msg += `🔖 SKU কোড: ${item.sku}\n`;
  msg += `💰 নির্ধারিত মূল্য: ${item.regular_price} ৳\n`;
  if (item.shop_name && !['SB Furniture', 'SB POWER'].includes(item.shop_name)) {
    msg += `🏪 শপ/ভেন্ডর: ${item.shop_name}\n`;
  }
  if (refCode) {
    msg += `🔗 রেফার কোড: ${refCode}\n`;
  }
  msg += `🌐 প্রোডাক্ট লিংক: ${productLink}\n\n`;
  msg += `দয়া করে ডেলিভারি ও অর্ডার কনফার্ম করার নিয়ম জানিয়ে দিন। ধন্যবাদ!`;

  const waUrl = `https://wa.me/${cleanPhone}?text=${encodeURIComponent(msg)}`;
  window.open(waUrl, '_blank');
}

// 1-Click Social Sharing Copy Generator
function generateShareText(item) {
  const isFurniture = item.brand === 'SB Furniture';
  const isPartner = item.shop_name && !['SB Furniture', 'SB POWER'].includes(item.shop_name);
  const phone = item.vendor_phone || (isFurniture ? '01929621855' : '01634664224');
  const trustLine = isPartner
    ? `🏪 ${item.shop_name} — ভেরিফাইড পার্টনার শপের সেরা কোয়ালিটি গ্যারান্টি!`
    : (isFurniture 
        ? '১৫ বছরের অভিজ্ঞতায় সরাসরি কারখানা থেকে পাইকারি ও সাশ্রয়ী দামে তৈরি করে দেওয়া হয়।' 
        : 'সাশ্রয়ী মূল্যে ১০০% অরিজিনাল সাউন্ড ও গ্যাজেটের সেরা কালেকশন!');
  
  const activeUser = (typeof currentUser !== 'undefined' && currentUser) ? currentUser : JSON.parse(localStorage.getItem('sb_user') || 'null');
  const refCode = activeUser ? activeUser.referral_code : localStorage.getItem('sb_ref_code');
  const appBaseUrl = window.location.origin;
  const productLink = refCode ? `${appBaseUrl}/?ref=${refCode}&sku=${item.sku}` : `${appBaseUrl}/?sku=${item.sku}`;

  let text = `🔥 ${item.title}\n`;
  text += `💵 নির্ধারিত পাইকারি মূল্য: ${item.regular_price} ৳\n`;
  if (isPartner) {
    text += `🏪 শপ/ভেন্ডর: ${item.shop_name}${item.vendor_badge ? ' (' + item.vendor_badge + ')' : ''}\n`;
  }
  if (item.materials) text += `🪵 বোর্ড/উপকরণ: ${item.materials}\n`;
  if (item.finish) text += `🎨 ফিনিশিং ও কালার: ${item.finish}\n`;
  if (item.description) text += `📌 বিবরণ: ${item.description}\n`;
  text += `\n✅ ${trustLine}\n`;
  text += `\n📦 সরাসরি কারখানা রেটে অর্ডার করতে Call / WhatsApp: ${phone}\n`;
  text += `🌐 সরাসরি অনলাইন অর্ডার লিংক: ${productLink}`;

  return text;
}

// Copy Share Text to Clipboard
async function copyProductShareCopy(productId) {
  const item = allProducts.find((p) => p.id === productId);
  if (!item) return;

  const copyText = generateShareText(item);

  try {
    await navigator.clipboard.writeText(copyText);
    showToast('✅ ক্যাপশন ও অর্ডার লিংক সফলভাবে কপি হয়েছে!');
  } catch (err) {
    const textarea = document.createElement('textarea');
    textarea.value = copyText;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    showToast('✅ ক্যাপশন ও লিংক সফলভাবে কপি হয়েছে!');
  }
}

// View Product Details in Modal
function viewProductDetails(productId) {
  const item = allProducts.find((p) => p.id === productId);
  if (!item) return;

  const isFurniture = item.brand === 'SB Furniture';
  const isPartner = item.shop_name && !['SB Furniture', 'SB POWER'].includes(item.shop_name);
  const phone = item.vendor_phone || (isFurniture ? '01929621855' : '01634664224');

  document.getElementById('modalProductTitle').textContent = item.sku + ' — বিস্তারিত তথ্য';

  let colorSelectorHtml = '';
  if (item.sku === 'SBP-103') {
    colorSelectorHtml = `
      <div class="form-group" style="margin-top: 10px;">
        <label class="form-label">পছন্দের কালার সিলেক্ট করুন (৪টি কালার অ্যাভেলেবল):</label>
        <select id="modalColorSelect" class="form-control">
          <option value="Black">ব্ল্যাক (Black)</option>
          <option value="Silver">সিলভার (Silver)</option>
          <option value="Blue">ব্লু (Blue)</option>
          <option value="Red">রেড (Red)</option>
        </select>
      </div>
    `;
  }

  let vendorInfoHtml = '';
  if (isPartner) {
    vendorInfoHtml = `
      <div style="background: rgba(16, 185, 129, 0.12); border: 1px solid #10b981; border-radius: var(--radius-sm); padding: 10px; margin-bottom: 12px; font-size: 0.85rem;">
        <div style="font-weight: 700; color: #34d399; margin-bottom: 4px;">🏪 পার্টনার শপ: ${item.shop_name}</div>
        ${item.vendor_badge ? `<div style="color: #a7f3d0; font-size: 0.78rem;">✓ ${item.vendor_badge}</div>` : ''}
        ${item.vendor_phone ? `<div style="color: #d1fae5; font-size: 0.78rem;">📞 ভেন্ডর মোবাইল: ${item.vendor_phone}</div>` : ''}
        ${item.vendor_address ? `<div style="color: #9ca3af; font-size: 0.75rem;">📍 শপ লোকেশন: ${item.vendor_address}</div>` : ''}
      </div>
    `;
  }

  document.getElementById('modalProductBody').innerHTML = `
    <div style="text-align: center; margin-bottom: 14px;">
      <img src="${item.image_url}" alt="${item.title}" style="width: 100%; max-height: 280px; object-fit: cover; border-radius: var(--radius-sm);">
    </div>
    <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 10px;">
      <span class="badge-sku" style="position: static;">${item.sku}</span>
      <span class="badge-commission" style="position: static;">রিসেলার কমিশন: ${item.reseller_commission} ৳</span>
      <span style="font-size: 0.75rem; background: #38332f; padding: 3px 8px; border-radius: 4px; color: #fff;">${item.shop_name || item.brand}</span>
      ${item.vendor_badge ? `<span style="font-size: 0.75rem; background: #065f46; color: #a7f3d0; padding: 3px 8px; border-radius: 4px;">✓ ${item.vendor_badge}</span>` : ''}
    </div>
    <h3 style="font-size: 1.15rem; color: #fff; margin-bottom: 8px;">${item.title}</h3>
    <div style="font-size: 1.25rem; font-weight: 700; color: var(--sbp-yellow); margin-bottom: 12px;">
      মূল্য: ${item.regular_price} ৳
    </div>
    ${vendorInfoHtml}
    <div style="background: #292524; padding: 12px; border-radius: var(--radius-sm); font-size: 0.85rem; margin-bottom: 14px; line-height: 1.6;">
      ${item.materials ? `<div><strong>উপকরণ:</strong> ${item.materials}</div>` : ''}
      ${item.finish ? `<div><strong>ফিনিশিং:</strong> ${item.finish}</div>` : ''}
      <div style="margin-top: 6px;">${item.description}</div>
    </div>
    ${colorSelectorHtml}
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 12px;">
      <button class="btn-share" style="padding: 10px;" onclick="copyProductShareCopy(${item.id})">
        📋 সোশ্যাল কপি
      </button>
      <button class="btn-wa" style="padding: 10px;" onclick="orderViaWhatsApp(${item.id})">
        💬 WhatsApp অর্ডার
      </button>
    </div>
    <button class="btn-submit" style="margin-top: 10px; padding: 12px;" onclick="addToCartFromModal(${item.id})">
      🛒 শপিং কার্টে নিন
    </button>
    <div style="margin-top: 14px; text-align: center; font-size: 0.82rem; color: var(--sbf-text-muted);">
      কাস্টমাইজেশন বা সরাসরি অর্ডারে কল করুন: <a href="tel:${phone}" style="color: var(--sbp-yellow); font-weight: 700;">${phone}</a>
    </div>
  `;

  openModal('productDetailModal');
}
