// ============================================================
// SB Furniture & SB POWER — Catalog & Social Sharing Module
// ============================================================

let allProducts = [];
let catalogResellerAccess = false;
let currentTab = 'all';
let currentCategory = 'all';
let currentBrand = 'all';
let currentSort = 'default';
let minPrice = '';
let maxPrice = '';
let searchQuery = '';
let searchTimeout;
let priceFilterTimeout;

const escapeCatalogHtml = (value) => window.sbEscapeHtml(value);
const safeCatalogImageUrl = (value) => window.sbSafeImageUrl(value);
const hasResellerAccess = () => {
  const user = (typeof currentUser !== 'undefined' && currentUser)
    ? currentUser
    : (() => { try { return JSON.parse(localStorage.getItem('sb_user') || 'null'); } catch { return null; } })();
  return Boolean(catalogResellerAccess && user && ['reseller', 'admin'].includes(user.role));
};

// Load Products from API
async function loadProducts() {
  const grid = document.getElementById('productGrid');
  if (!grid) return;
  const resultsLabel = document.getElementById('productResultCount');
  if (resultsLabel) resultsLabel.textContent = 'পণ্য খোঁজা হচ্ছে…';
  grid.innerHTML = `
    <div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: var(--sbf-text-muted);">
      <span class="spinner"></span>
      <div style="margin-top: 10px; font-size: 0.9rem;">পণ্য লোড হচ্ছে, অনুগ্রহ করে অপেক্ষা করুন...</div>
    </div>
  `;

  try {
    const endpoint = `/api/products?tab=${encodeURIComponent(currentTab)}&category=${encodeURIComponent(currentCategory)}&brand=${encodeURIComponent(currentBrand)}&sort=${encodeURIComponent(currentSort)}`;
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
    const token = localStorage.getItem('sb_token');
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const res = await fetch(fetchUrl, { headers, cache: 'no-store' });
    const data = await res.json();

    if (res.status === 403 && !catalogResellerAccess && (currentTab !== 'all' || currentSort === 'commission_desc')) {
      currentTab = 'all';
      currentSort = 'default';
      loadProducts();
      return;
    }

    if (data.success && data.products) {
      catalogResellerAccess = Boolean(data.reseller_access);
      if (currentUser && ['admin', 'customer', 'reseller'].includes(data.account_role) && currentUser.role !== data.account_role) {
        currentUser.role = data.account_role;
        localStorage.setItem('sb_user', JSON.stringify(currentUser));
      }
      if (typeof updateAuthUI === 'function') updateAuthUI();
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
      if (resultsLabel) resultsLabel.textContent = 'পণ্য লোড হয়নি';
      grid.innerHTML = `
        <div style="grid-column: 1 / -1; text-align: center; padding: 40px;">
          <div style="color: var(--sbp-red); font-size: 1rem; margin-bottom: 12px;">পণ্য লোড করতে ব্যর্থ হয়েছে।</div>
          <button class="btn-submit" style="margin: 0 auto; max-width: 200px;" onclick="loadProducts()">🔄 আবার চেষ্টা করুন</button>
        </div>
      `;
    }
  } catch (err) {
    console.error('Failed to load products:', err);
    if (resultsLabel) resultsLabel.textContent = 'সার্ভারে সংযোগ পাওয়া যায়নি';
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
  const resultsLabel = document.getElementById('productResultCount');
  if (resultsLabel) resultsLabel.textContent = `${products ? products.length : 0}টি পণ্য`;
  if (!products || products.length === 0) {
    grid.innerHTML = `
      <div class="catalog-empty-state">
        <span aria-hidden="true">⌕</span>
        <h3>এই নামে কোনো পণ্য পাওয়া যায়নি</h3>
        <p>বানান বা ফিল্টার বদলে আবার খুঁজুন।</p>
        <button type="button" onclick="resetCatalogFilters()">সব পণ্য দেখুন</button>
      </div>
    `;
    return;
  }

  grid.innerHTML = products.map((item) => {
    const isFurniture = item.brand === 'SB Furniture';
    const resellerAccess = hasResellerAccess();
    const brandBadgeClass = isFurniture ? 'brand-furniture' : 'brand-power';
    const imageUrl = escapeCatalogHtml(safeCatalogImageUrl(item.image_url));

    const stockBadge = Number(item.stock) > 0
      ? `<span class="badge-stock in-stock">স্টক: ${item.stock}টি</span>`
      : `<span class="badge-stock out-of-stock">স্টক শেষ</span>`;

    return `
      <article class="product-card">
        <button type="button" class="product-thumb-wrap" onclick="viewProductDetails(${item.id})" aria-label="${escapeCatalogHtml(item.title)} — বিস্তারিত দেখুন">
          <img src="${imageUrl}" alt="${escapeCatalogHtml(item.title)}" class="product-thumb" loading="lazy">
          <span class="badge-sku">${escapeCatalogHtml(item.sku)}</span>
          <span class="badge-brand ${brandBadgeClass}">${escapeCatalogHtml(item.brand)}</span>
        </button>
        <div class="product-body">
          <div class="product-card-topmeta">
            <span class="product-meta-row">${escapeCatalogHtml(item.category)}</span>
            ${stockBadge}
          </div>
          <button type="button" class="product-title" onclick="viewProductDetails(${item.id})">${escapeCatalogHtml(item.title)}</button>
          ${item.finish ? `<div class="product-finish-line">ফিনিশ: ${escapeCatalogHtml(item.finish)}</div>` : ''}
          <div class="product-price-row">
            <div class="price-box">
              <span class="price-label">কাস্টমার মূল্য</span>
              <span class="price-val">${escapeCatalogHtml(item.regular_price)} ৳</span>
            </div>
            ${resellerAccess ? `<div class="commission-box">
              <span class="commission-label">আপনার আয়</span>
              <span class="badge-profit-pill">কমিশন ৳${escapeCatalogHtml(item.reseller_commission)}</span>
            </div>` : ''}
          </div>
          <div class="product-actions">
            ${resellerAccess ? `<button type="button" class="btn-share" onclick="copyProductShareCopy(${item.id})" title="পোস্ট কপি করুন">
              <span aria-hidden="true">📋</span> সেলস পোস্ট কপি
            </button>` : ''}
            <button type="button" class="btn-wa" onclick="orderViaWhatsApp(${item.id})" title="WhatsApp" aria-label="WhatsApp-এ অর্ডার করুন">
              <span aria-hidden="true">💬</span><span class="wa-btn-label"> WhatsApp</span>
            </button>
            <button type="button" class="btn-order" onclick="viewProductDetails(${item.id})" title="পণ্য দেখুন বা অর্ডার করুন">
              <span aria-hidden="true">🛒</span> <span>${resellerAccess ? 'টুলকিট' : 'অর্ডার করুন'}</span>
            </button>
          </div>
        </div>
      </article>
    `;
  }).join('');
}

function resetCatalogFilters() {
  currentTab = 'all';
  currentCategory = 'all';
  currentBrand = 'all';
  currentSort = 'default';
  minPrice = '';
  maxPrice = '';
  searchQuery = '';
  document.getElementById('searchInput').value = '';
  document.getElementById('sortSelect').value = 'default';
  document.getElementById('minPriceInput').value = '';
  document.getElementById('maxPriceInput').value = '';
  document.querySelectorAll('.commission-tabs-wrap .tab-btn').forEach((button) => button.classList.toggle('active', button.dataset.tab === 'all'));
  document.querySelectorAll('.category-pills .cat-pill').forEach((button) => button.classList.toggle('active', button.dataset.cat === 'all'));
  document.querySelectorAll('.quick-shop-pill').forEach((button) => button.classList.toggle('active', button.dataset.brand === 'all'));
  loadProducts();
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

// Own brand filtering. Partner shops remain hidden from the storefront.
function filterByBrand(brandName) {
  currentBrand = brandName;
  document.querySelectorAll('.quick-shop-pill').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.brand === brandName);
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
  let phone = isFurniture ? '01929621855' : '01634664224';
  let cleanPhone = phone.replace(/\D/g, '');
  if (cleanPhone.startsWith('01')) {
    cleanPhone = '88' + cleanPhone;
  } else if (cleanPhone.startsWith('1') && cleanPhone.length === 10) {
    cleanPhone = '880' + cleanPhone;
  } else if (!cleanPhone.startsWith('88')) {
    cleanPhone = '88' + cleanPhone;
  }

  const activeUser = (typeof currentUser !== 'undefined' && currentUser) ? currentUser : JSON.parse(localStorage.getItem('sb_user') || 'null');
  const refCode = activeUser && ['reseller', 'admin'].includes(activeUser.role)
    ? activeUser.referral_code
    : (localStorage.getItem('sb_ref_code') || '');
  const appBaseUrl = window.location.origin;
  const productLink = refCode ? `${appBaseUrl}/?ref=${refCode}&sku=${item.sku}` : `${appBaseUrl}/?sku=${item.sku}`;

  let msg = `আসসালামু আলাইকুম, আমি সরাসরি এই পণ্যটি অর্ডার করতে চাই:\n\n`;
  msg += `🏷️ প্রোডাক্ট: ${item.title}\n`;
  msg += `🔖 SKU কোড: ${item.sku}\n`;
  msg += `💰 নির্ধারিত মূল্য: ${item.regular_price} ৳\n`;
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
  const phone = String(isFurniture ? '01929621855' : '01634664224').replace(/\D/g, '');
  const trustLine = isFurniture
    ? 'SB Furniture-এর ফার্নিচার ও দোকান সাজানোর পণ্য।'
    : 'SB POWER-এর গ্যাজেট; পণ্যের ব্র্যান্ড ও বিবরণ দেখে অর্ডার করুন।';

  const activeUser = (typeof currentUser !== 'undefined' && currentUser) ? currentUser : JSON.parse(localStorage.getItem('sb_user') || 'null');
  const refCode = activeUser && ['reseller', 'admin'].includes(activeUser.role) ? activeUser.referral_code : '';
  const appBaseUrl = window.location.origin;
  const productLink = refCode ? `${appBaseUrl}/?ref=${refCode}&sku=${item.sku}` : `${appBaseUrl}/?sku=${item.sku}`;

  let text = `🔥 ${item.title}\n`;
  text += `💵 বিক্রয় মূল্য: ${item.regular_price} ৳\n`;
  if (item.materials) text += `🪵 বোর্ড/উপকরণ: ${item.materials}\n`;
  if (item.finish) text += `🎨 ফিনিশিং ও কালার: ${item.finish}\n`;
  if (item.description) text += `📌 বিবরণ: ${item.description}\n`;
  text += `\n✅ ${trustLine}\n`;
  text += `\n📦 পণ্য সম্পর্কে জানতে Call / WhatsApp: ${phone}\n`;
  text += `🌐 সরাসরি অনলাইন অর্ডার লিংক: ${productLink}`;

  return text;
}

// Copy Share Text to Clipboard
async function copyProductShareCopy(productId) {
  if (!hasResellerAccess()) return;
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

function renderCustomerProductDetails(item) {
  const isFurniture = item.brand === 'SB Furniture';
  const phone = isFurniture ? '01929621855' : '01634664224';
  const imageUrl = escapeCatalogHtml(safeCatalogImageUrl(item.image_url));
  const colorSelectorHtml = item.sku === 'SBP-103' || (item.finish && item.finish.includes('কালার'))
    ? `<div class="form-group" style="margin-top: 10px;">
        <label class="form-label" for="modalColorSelect">পছন্দের রং</label>
        <select id="modalColorSelect" class="form-control">
          <option value="Black">ব্ল্যাক</option><option value="Silver">সিলভার</option>
          <option value="Blue">ব্লু</option><option value="Red">রেড</option>
        </select>
      </div>`
    : '';

  document.getElementById('modalProductTitle').textContent = `${item.sku} — পণ্যের বিস্তারিত`;
  document.getElementById('modalProductBody').innerHTML = `
    <div class="product-detail-img-wrap">
      <img src="${imageUrl}" alt="${escapeCatalogHtml(item.title)}" class="product-detail-img">
    </div>
    <div class="product-detail-badges">
      <span class="badge-sku">${escapeCatalogHtml(item.sku)}</span>
      <span class="product-detail-brand-tag">${escapeCatalogHtml(item.brand)}</span>
      <span class="product-meta-row">${escapeCatalogHtml(item.category)}</span>
    </div>
    <h3 class="product-detail-title">${escapeCatalogHtml(item.title)}</h3>
    <div class="product-detail-price-bar">
      <div class="product-detail-price">পণ্যের দাম: ${escapeCatalogHtml(item.regular_price)} ৳</div>
    </div>
    <div class="product-detail-desc">
      ${item.materials ? `<div><strong>উপকরণ:</strong> ${escapeCatalogHtml(item.materials)}</div>` : ''}
      ${item.finish ? `<div><strong>ফিনিশিং:</strong> ${escapeCatalogHtml(item.finish)}</div>` : ''}
      <div class="product-detail-desc-body">${escapeCatalogHtml(item.description)}</div>
    </div>
    ${colorSelectorHtml}
    <div class="product-detail-actions">
      <button type="button" class="btn-wa" style="min-block-size: 46px; border-radius: var(--radius-sm); font-weight: 700;" onclick="orderViaWhatsApp(${item.id})">💬 WhatsApp-এ অর্ডার</button>
      <button type="button" class="btn-submit" onclick="addToCartFromModal(${item.id})">🛒 কার্টে যোগ করুন</button>
    </div>
    <div class="product-detail-hotline">
      পণ্য সম্পর্কে জানতে কল করুন: <a href="tel:${phone}">${phone}</a>
    </div>
  `;
  openModal('productDetailModal');
}

// View Product Details with One-Tap Reseller Toolkit
function viewProductDetails(productId) {
  const item = allProducts.find((p) => p.id === productId);
  if (!item) return;

  if (!hasResellerAccess()) {
    renderCustomerProductDetails(item);
    return;
  }

  const isFurniture = item.brand === 'SB Furniture';
  const phone = String(isFurniture ? '01929621855' : '01634664224').replace(/\D/g, '');
  const imageUrl = escapeCatalogHtml(safeCatalogImageUrl(item.image_url));

  document.getElementById('modalProductTitle').textContent = item.sku + ' — বিস্তারিত তথ্য ও রিসেলার টুলকিট';

  let colorSelectorHtml = '';
  if (item.sku === 'SBP-103' || (item.finish && item.finish.includes('কালার'))) {
    colorSelectorHtml = `
      <div class="form-group" style="margin-top: 10px;">
        <label class="form-label">পছন্দের কালার সিলেক্ট করুন:</label>
        <select id="modalColorSelect" class="form-control" onchange="updateToolkitLiveProfit(${item.id})">
          <option value="Black">ব্ল্যাক (Black)</option>
          <option value="Silver">সিলভার (Silver)</option>
          <option value="Blue">ব্লু (Blue)</option>
          <option value="Red">রেড (Red)</option>
        </select>
      </div>
    `;
  }

  const defaultDeliveryFee = isFurniture ? 500 : 80;
  const initialGrandTotal = item.regular_price + defaultDeliveryFee;

  document.getElementById('modalProductBody').innerHTML = `
    <div class="product-detail-img-wrap">
      <img src="${imageUrl}" alt="${escapeCatalogHtml(item.title)}" class="product-detail-img">
    </div>
    <div class="product-detail-badges">
      <span class="badge-sku">${escapeCatalogHtml(item.sku)}</span>
      <span class="badge-profit-pill">কমিশন ৳${escapeCatalogHtml(item.reseller_commission)}</span>
      <span class="product-detail-brand-tag">${escapeCatalogHtml(item.brand)}</span>
    </div>
    <h3 class="product-detail-title">${escapeCatalogHtml(item.title)}</h3>
    <div class="product-detail-price-bar">
      <div class="product-detail-price">
        কাস্টমার মূল্য: ${escapeCatalogHtml(item.regular_price)} ৳
      </div>
      <div class="badge-profit-pill" style="font-size: 0.82rem; padding: 4px 11px;">
        আপনার নিট কমিশন: ৳${escapeCatalogHtml(item.reseller_commission)}
      </div>
    </div>
    <div class="product-detail-desc">
      ${item.materials ? `<div><strong>উপকরণ:</strong> ${escapeCatalogHtml(item.materials)}</div>` : ''}
      ${item.finish ? `<div><strong>ফিনিশিং:</strong> ${escapeCatalogHtml(item.finish)}</div>` : ''}
      <div class="product-detail-desc-body">${escapeCatalogHtml(item.description)}</div>
    </div>
    ${colorSelectorHtml}

    <!-- One-Tap Reseller Toolkit -->
    <div class="reseller-toolkit-box">
      <div class="toolkit-title">
        <span>⚡ রিসেলার টুলকিট</span>
        <span class="toolkit-title-hint">১-ক্লিকে শেয়ার ও অর্ডার</span>
      </div>
      <div class="toolkit-action-grid">
        <button type="button" class="btn-toolkit btn-toolkit-copy" onclick="copyProductShareCopy(${item.id})">
          <span>📋</span> কপি সেলস পোস্ট
        </button>
        <button type="button" class="btn-toolkit btn-toolkit-share" onclick="shareProductToolkit(${item.id})">
          <span>📲</span> ছবি ও লিংক শেয়ার
        </button>
        <button type="button" class="btn-toolkit btn-toolkit-order" onclick="toggleCustomerOrderAccordion()">
          <span>🛒</span> কাস্টমারের জন্য সরাসরি অর্ডার করুন ▾
        </button>
      </div>

      <!-- Instant Customer Order Accordion Form -->
      <div id="custOrderAccordionPanel" class="customer-order-panel" style="display: none;">
        <h4 style="color: var(--brand-primary-hv); font-size: 0.96rem; margin-bottom: 10px;">📦 কাস্টমার অর্ডার ফর্ম (সরাসরি আপনার রেফারে)</h4>

        <div class="form-group">
          <label class="form-label" style="font-size: 0.8rem;">কাস্টমারের পূর্ণ নাম *</label>
          <input type="text" id="tkCustName" class="form-control" placeholder="যেমন: মো: করিম হোসেন">
        </div>
        <div class="form-group">
          <label class="form-label" style="font-size: 0.8rem;">কাস্টমারের মোবাইল নম্বর (১১ ডিজিট) *</label>
          <input type="tel" id="tkCustPhone" class="form-control" inputmode="tel" placeholder="01XXXXXXXXX">
        </div>
        <div class="form-group">
          <label class="form-label" style="font-size: 0.8rem;">সম্পূর্ণ ডেলিভারি ঠিকানা *</label>
          <textarea id="tkCustAddress" class="form-control" rows="2" placeholder="বাড়ি/রোড/এলাকা/উপজেলা/জেলা"></textarea>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
          <div class="form-group">
            <label class="form-label" style="font-size: 0.8rem;">পরিমাণ (Quantity)</label>
            <input type="number" id="tkOrderQty" class="form-control" value="1" min="1" max="50" oninput="updateToolkitLiveProfit(${item.id})">
          </div>
          <div class="form-group">
            <label class="form-label" style="font-size: 0.8rem;">ডেলিভারি এরিয়া</label>
            <select id="tkOrderCity" class="form-control" onchange="updateToolkitLiveProfit(${item.id})">
              <option value="inside_dhaka">ঢাকা ভেতরে (${isFurniture ? '৫০০৳' : '৮০৳'})</option>
              <option value="outside_dhaka">ঢাকার বাইরে (${isFurniture ? '১০০০৳' : '১৫০৳'})</option>
            </select>
          </div>
        </div>

        <!-- Live Profit & Bill Preview -->
        <div class="profit-preview-box">
          <div class="profit-preview-row">
            <span>কাস্টমার পণ্যের মূল্য:</span>
            <span id="tkSubtotal">${item.regular_price} ৳</span>
          </div>
          <div class="profit-preview-row">
            <span>ডেলিভারি চার্জ:</span>
            <span id="tkDeliveryFee">${defaultDeliveryFee} ৳</span>
          </div>
          <div class="profit-preview-row profit-preview-total">
            <span>কাস্টমার মোট বিল (COD):</span>
            <span id="tkGrandTotal">${initialGrandTotal} ৳</span>
          </div>
          <div class="profit-preview-row profit-preview-highlight">
            <span>আপনার নিশ্চিত কমিশন:</span>
            <span id="tkResellerCommission">৳${item.reseller_commission}</span>
          </div>
          <div class="profit-preview-note">
            ✓ অর্ডার সাবমিট হলেই কমিশন আপনার ওয়ালেটে পেন্ডিং হিসেবে যোগ হবে এবং ডেলিভারিতে উত্তোলনযোগ্য হবে!
          </div>
        </div>

        <button type="button" id="btnSubmitTkOrder" class="btn-submit" onclick="submitToolkitCustomerOrder(${item.id})">
          নিশ্চিত করুন ও কাস্টমারের অর্ডার প্লেস করুন
        </button>
      </div>
    </div>

    <!-- Secondary Actions -->
    <div class="product-detail-actions">
      <button type="button" class="btn-wa" style="min-block-size: 46px; border-radius: var(--radius-sm); font-weight: 700;" onclick="orderViaWhatsApp(${item.id})">
        💬 WhatsApp হটলাইন
      </button>
      <button type="button" class="btn-secondary-solid" onclick="addToCartFromModal(${item.id})">
        🛒 নিজের কার্টে নিন
      </button>
    </div>

    <div class="product-detail-hotline">
      কাস্টমাইজেশন বা সরাসরি অর্ডারে কল করুন: <a href="tel:${phone}">${phone}</a>
    </div>
  `;

  openModal('productDetailModal');
}

// Toolkit Web Share API Helper
async function shareProductToolkit(productId) {
  if (!hasResellerAccess()) return;
  const item = allProducts.find((p) => p.id === productId);
  if (!item) return;
  const shareText = generateShareText(item);
  if (navigator.share) {
    try {
      await navigator.share({
        title: item.title,
        text: shareText,
        url: window.location.origin + '/?sku=' + item.sku
      });
      showToast('✅ সফলভাবে শেয়ার করা হয়েছে!');
      return;
    } catch (e) {
      if (e.name !== 'AbortError') copyProductShareCopy(productId);
    }
  } else {
    copyProductShareCopy(productId);
    window.open(item.image_url, '_blank');
  }
}

// Toggle Customer Order Accordion inside Product Modal
function toggleCustomerOrderAccordion() {
  const panel = document.getElementById('custOrderAccordionPanel');
  if (panel) {
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  }
}

// Live Profit Calculator inside Product Modal
function updateToolkitLiveProfit(productId) {
  const item = allProducts.find((p) => p.id === productId);
  if (!item) return;
  const qtyInput = document.getElementById('tkOrderQty');
  const qty = Math.max(1, parseInt(qtyInput ? qtyInput.value : 1, 10) || 1);
  const citySelect = document.getElementById('tkOrderCity');
  const city = citySelect ? citySelect.value : 'inside_dhaka';

  const isFurniture = item.brand === 'SB Furniture';
  const deliveryFee = isFurniture
    ? (city === 'inside_dhaka' ? 500 : 1000)
    : (city === 'inside_dhaka' ? 80 : 150);

  const subtotal = item.regular_price * qty;
  const grandTotal = subtotal + deliveryFee;
  const totalCommission = item.reseller_commission * qty;

  const subtotalEl = document.getElementById('tkSubtotal');
  const delEl = document.getElementById('tkDeliveryFee');
  const totalEl = document.getElementById('tkGrandTotal');
  const commEl = document.getElementById('tkResellerCommission');

  if (subtotalEl) subtotalEl.textContent = `${subtotal} ৳`;
  if (delEl) delEl.textContent = `${deliveryFee} ৳`;
  if (totalEl) totalEl.textContent = `${grandTotal} ৳`;
  if (commEl) commEl.textContent = `৳${totalCommission}`;
}

// One-Tap Customer Order Submission
async function submitToolkitCustomerOrder(productId) {
  const item = allProducts.find((p) => p.id === productId);
  if (!item) return;

  const nameInput = document.getElementById('tkCustName');
  const phoneInput = document.getElementById('tkCustPhone');
  const addressInput = document.getElementById('tkCustAddress');
  const cityInput = document.getElementById('tkOrderCity');
  const qtyInput = document.getElementById('tkOrderQty');
  const colorSelect = document.getElementById('modalColorSelect');

  const customer_name = nameInput ? nameInput.value.trim() : '';
  const customer_phone = phoneInput ? phoneInput.value.trim() : '';
  const delivery_address = addressInput ? addressInput.value.trim() : '';
  const delivery_city = cityInput ? cityInput.value : 'inside_dhaka';
  const quantity = Math.max(1, parseInt(qtyInput ? qtyInput.value : 1, 10) || 1);
  const selected_color = colorSelect ? colorSelect.value : '';

  if (!customer_name) return alert('কাস্টমারের নাম প্রদান করুন');
  if (!/^01[3-9]\d{8}$/.test(customer_phone.replace(/\D/g, ''))) return alert('কাস্টমারের সঠিক ১১ ডিজিটের মোবাইল নম্বর দিন');
  if (!delivery_address) return alert('কাস্টমারের সম্পূর্ণ ঠিকানা লিখুন');

  const btn = document.getElementById('btnSubmitTkOrder');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'অর্ডার প্রসেস হচ্ছে...';
  }

  try {
    const activeUser = (typeof currentUser !== 'undefined' && currentUser) ? currentUser : JSON.parse(localStorage.getItem('sb_user') || 'null');
    const token = (typeof authToken !== 'undefined' && authToken) ? authToken : localStorage.getItem('sb_token');

    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const orderPayload = {
      customer_name,
      customer_phone,
      delivery_address,
      delivery_city,
      items: [{
        product_id: item.id,
        quantity,
        selected_color
      }]
    };
    if (activeUser && activeUser.referral_code) {
      orderPayload.referral_code = activeUser.referral_code;
    }

    const res = await fetch(api('/api/orders'), {
      method: 'POST',
      headers,
      body: JSON.stringify(orderPayload)
    });
    const data = await res.json();

    if (data.success && data.order) {
      closeModal('productDetailModal');
      showToast(`🎉 অর্ডার #${data.order.order_number} সফলভাবে প্লেস হয়েছে!`);
      if (typeof openModal === 'function') {
        const trackInput = document.getElementById('trackOrderInput');
        const phoneTrack = document.getElementById('trackCustomerPhone');
        if (trackInput) trackInput.value = data.order.order_number;
        if (phoneTrack) phoneTrack.value = customer_phone;
        openModal('trackModal');
        if (typeof trackOrder === 'function') trackOrder();
      }
    } else {
      alert(data.message || 'অর্ডার প্লেস ব্যর্থ হয়েছে');
    }
  } catch (err) {
    console.error(err);
    alert('অর্ডার সাবমিট করতে সমস্যা হয়েছে');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'নিশ্চিত করুন ও কাস্টমারের অর্ডার প্লেস করুন';
    }
  }
}
