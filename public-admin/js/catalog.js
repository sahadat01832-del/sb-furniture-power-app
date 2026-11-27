// ============================================================
// SB Power BD — Catalog, Wishlist, Quick-Add & Reseller Sharing
// ============================================================

let allProducts = [];
let rawCatalogProducts = [];
let catalogResellerAccess = false;
let currentTab = 'all';
let currentCategory = 'all';
let currentBrand = 'all';
let currentSort = 'default';
let minPrice = '';
let maxPrice = '';
let searchQuery = '';
let wishlistFilterActive = false;
let searchTimeout;
let priceFilterTimeout;
let catalogDiscoverySeed = (window.SBCatalogAlgorithm && typeof window.SBCatalogAlgorithm.createDiscoverySeed === 'function')
  ? window.SBCatalogAlgorithm.createDiscoverySeed()
  : ((Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0 || 1);

const CATALOG_INTEREST_STORAGE_KEY = 'sb_catalog_interests';

function formatBdt(amount) {
  const num = Number(amount || 0);
  return `${Number.isFinite(num) ? num.toLocaleString('en-US') : amount} ৳`;
}

function loadCatalogInterests() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CATALOG_INTEREST_STORAGE_KEY) || 'null');
    if (parsed && typeof parsed === 'object') {
      return {
        categories: parsed.categories && typeof parsed.categories === 'object' ? parsed.categories : {},
        lastViewedIds: Array.isArray(parsed.lastViewedIds) ? parsed.lastViewedIds : []
      };
    }
  } catch (e) {}
  return { categories: {}, lastViewedIds: [] };
}

function recordCatalogInterest(item) {
  if (!item || !item.id) return;
  try {
    const current = loadCatalogInterests();
    const cat = String(item.category || '').trim();
    if (cat) {
      const nextCount = Math.min(5, Number(current.categories[cat] || 0) + 1);
      current.categories[cat] = nextCount;
      const entries = Object.entries(current.categories).slice(-12);
      current.categories = Object.fromEntries(entries);
    }
    const idNum = Number(item.id);
    current.lastViewedIds = [idNum, ...current.lastViewedIds.filter((id) => Number(id) !== idNum)].slice(0, 10);
    localStorage.setItem(CATALOG_INTEREST_STORAGE_KEY, JSON.stringify(current));
    renderRecentlyViewedShelf();
  } catch (e) {}
}

function clearRecentlyViewed() {
  try {
    const current = loadCatalogInterests();
    current.lastViewedIds = [];
    localStorage.setItem(CATALOG_INTEREST_STORAGE_KEY, JSON.stringify(current));
  } catch (e) {}
  renderRecentlyViewedShelf();
}

function applyCatalogOrdering(products) {
  if (!Array.isArray(products)) return [];
  if (window.SBCatalogAlgorithm && typeof window.SBCatalogAlgorithm.rankCatalogProducts === 'function') {
    return window.SBCatalogAlgorithm.rankCatalogProducts(products, {
      sort: currentSort,
      seed: catalogDiscoverySeed,
      searchQuery,
      recentInterests: loadCatalogInterests()
    });
  }
  return products.slice();
}

const escapeCatalogHtml = (value) => window.sbEscapeHtml(value);
const safeCatalogImageUrl = (value) => window.sbSafeImageUrl(value);
const imageCorsAttrCatalog = (safeUrl) => (typeof window.sbImageCrossOriginAttr === 'function' ? window.sbImageCrossOriginAttr(safeUrl) : '');
const hasResellerAccess = () => {
  const user = (typeof currentUser !== 'undefined' && currentUser)
    ? currentUser
    : (() => { try { return JSON.parse(localStorage.getItem('sb_user') || 'null'); } catch { return null; } })();
  return Boolean(catalogResellerAccess && user && ['reseller', 'admin'].includes(user.role));
};

function getCartQtyForProduct(productId) {
  if (typeof cart === 'undefined' || !Array.isArray(cart)) return 0;
  return cart
    .filter((entry) => entry && entry.product && Number(entry.product.id) === Number(productId))
    .reduce((sum, entry) => sum + Number(entry.quantity || 0), 0);
}

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
      if (typeof currentUser !== 'undefined' && currentUser && ['admin', 'customer', 'reseller'].includes(data.account_role) && currentUser.role !== data.account_role) {
        currentUser.role = data.account_role;
        localStorage.setItem('sb_user', JSON.stringify(currentUser));
      }
      if (typeof updateAuthUI === 'function') updateAuthUI();
      rawCatalogProducts = data.products.slice();
      const orderedProducts = applyCatalogOrdering(rawCatalogProducts);
      allProducts = orderedProducts;
      renderProductGrid(orderedProducts);
      renderRecentlyViewedShelf();

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
          <button type="button" class="btn-submit" style="margin: 0 auto; max-width: 200px;" onclick="loadProducts()">🔄 আবার চেষ্টা করুন</button>
        </div>
      `;
    }
  } catch (err) {
    console.error('Failed to load products:', err);
    if (resultsLabel) resultsLabel.textContent = 'সার্ভারে সংযোগ পাওয়া যায়নি';
    grid.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 40px;">
        <div style="color: var(--sbp-red); font-size: 1rem; margin-bottom: 12px;">সার্ভার সংযোগ পেতে সমস্যা হচ্ছে বা ক্লাউড সার্ভার প্রস্তুত হচ্ছে।</div>
        <button type="button" class="btn-submit" style="margin: 0 auto; max-width: 200px;" onclick="loadProducts()">🔄 আবার চেষ্টা করুন</button>
      </div>
    `;
  }
}

// Open Custom Order Hotline Modal
function openCustomOrderModal() {
  if (typeof openModal === 'function') openModal('customOrderModal');
}

// Handle 1-Click Cart Add / Variant Modal
function handleOrderButtonClick(productId) {
  const item = allProducts.find((p) => p.id === productId);
  if (!item) return;
  if (Number(item.stock) <= 0) {
    orderViaWhatsApp(item.id);
    return;
  }
  if (item.sku === 'SBP-103' || (item.finish && item.finish.includes('কালার'))) {
    viewProductDetails(item.id);
  } else if (typeof addToCart === 'function') {
    addToCart(item.id);
  } else {
    viewProductDetails(item.id);
  }
}

function renderActiveFilterBar() {
  const bar = document.getElementById('activeFilterBar');
  if (!bar) return;
  const chips = [];
  if (currentBrand !== 'all') chips.push(`ব্র্যান্ড: ${currentBrand}`);
  if (currentCategory !== 'all') chips.push(`ক্যাটাগরি: ${currentCategory}`);
  if (currentTab !== 'all') chips.push(`কমিশন: ${currentTab}`);
  if (minPrice !== '' || maxPrice !== '') chips.push(`দাম: ${minPrice || '০'}–${maxPrice || 'যেকোনো'} ৳`);
  if (searchQuery.trim()) chips.push(`খোঁজা: "${searchQuery.trim()}"`);
  if (wishlistFilterActive) chips.push('❤️ পছন্দের তালিকা');

  if (chips.length === 0) {
    bar.hidden = true;
    if (typeof bar.replaceChildren === 'function') bar.replaceChildren();
    else bar.innerHTML = '';
    return;
  }

  bar.hidden = false;
  bar.innerHTML = `
    ${chips.map((label) => `<span class="active-filter-chip">${escapeCatalogHtml(label)}</span>`).join('')}
    <button type="button" class="active-filter-reset" onclick="resetCatalogFilters()">✕ সব ফিল্টার মুছুন</button>
  `;
}

// Render Product Grid
function renderProductGrid(products) {
  const grid = document.getElementById('productGrid');
  if (!grid) return;
  renderActiveFilterBar();

  const sourceList = Array.isArray(products) ? products : [];
  const visibleProducts = wishlistFilterActive
    ? sourceList.filter((item) => typeof window.isProductWishlisted === 'function' && window.isProductWishlisted(item.id))
    : sourceList;

  const resultsLabel = document.getElementById('productResultCount');
  if (resultsLabel) resultsLabel.textContent = `${visibleProducts.length}টি পণ্য`;

  if (visibleProducts.length === 0) {
    grid.innerHTML = `
      <div class="catalog-empty-state">
        <span aria-hidden="true">${wishlistFilterActive ? '❤️' : '⌕'}</span>
        <h3>${wishlistFilterActive ? 'পছন্দের তালিকায় এখনো কোনো পণ্য নেই' : 'এই নামে কোনো পণ্য পাওয়া যায়নি'}</h3>
        <p>${wishlistFilterActive ? 'যেকোনো পণ্যের কোণার হার্ট (🤍) আইকনে ট্যাপ করে এখানে সেভ করুন।' : 'বানান বা ফিল্টার বদলে আবার খুঁজুন।'}</p>
        <button type="button" onclick="resetCatalogFilters()">সব পণ্য দেখুন</button>
      </div>
    `;
    return;
  }

  grid.innerHTML = visibleProducts.map((item, index) => {
    const isFurniture = item.brand === 'SB Furniture';
    const isLifestyle = item.brand === 'SB Lifestyle & Tools';
    const resellerAccess = hasResellerAccess();
    const brandBadgeClass = isFurniture ? 'brand-furniture' : (isLifestyle ? 'brand-lifestyle' : 'brand-power');
    const rawSafeImageUrl = safeCatalogImageUrl(item.image_url);
    const imageUrl = escapeCatalogHtml(rawSafeImageUrl);
    const imgCors = imageCorsAttrCatalog(rawSafeImageUrl);
    const inStock = Number(item.stock) > 0;
    const inCartQty = getCartQtyForProduct(item.id);
    const wishActive = typeof window.isProductWishlisted === 'function' && window.isProductWishlisted(item.id);

    // Performance & LCP image priority: eager + high on first 2, eager on 3-4, lazy on 5+
    const imgPriorityAttr = index < 2 ? 'fetchpriority="high"' : (index >= 4 ? 'loading="lazy"' : '');
    const deferredClass = index >= 8 ? ' is-deferred-card' : '';

    const stockBadge = inStock
      ? `<span class="badge-stock in-stock">স্টক: ${escapeCatalogHtml(item.stock)}টি</span>`
      : `<span class="badge-stock out-of-stock">স্টক শেষ</span>`;

    const primaryActionLabel = !inStock
      ? 'স্টক শেষ'
      : resellerAccess
        ? 'টুলকিট'
        : inCartQty > 0
          ? `✓ কার্টে (${inCartQty})`
          : 'কার্টে নিন';

    const primaryActionOnclick = resellerAccess
      ? `viewProductDetails(${item.id})`
      : `handleOrderButtonClick(${item.id})`;

    return `
      <article class="product-card${deferredClass}">
        <div class="product-media">
          <button type="button" class="product-thumb-wrap" onclick="viewProductDetails(${item.id})" aria-label="${escapeCatalogHtml(item.title)} — বিস্তারিত দেখুন">
            <img src="${imageUrl}" ${imgCors} alt="${escapeCatalogHtml(item.title)}" class="product-thumb" width="400" height="400" decoding="async" ${imgPriorityAttr} onerror="window.sbHandleImageError && window.sbHandleImageError(this)">
            <span class="badge-sku">${escapeCatalogHtml(item.sku)}</span>
            <span class="badge-brand ${brandBadgeClass}">${escapeCatalogHtml(item.brand)}</span>
          </button>
          <button type="button" class="btn-wishlist-card" data-wish-id="${item.id}" aria-pressed="${wishActive ? 'true' : 'false'}" aria-label="${escapeCatalogHtml(item.title)} পছন্দের তালিকায় ${wishActive ? 'সরিয়ে ফেলুন' : 'যোগ করুন'}" onclick="if(typeof toggleWishlist==='function') toggleWishlist(${item.id})">${wishActive ? '❤️' : '🤍'}</button>
        </div>
        <div class="product-body">
          <div class="product-card-topmeta">
            <span class="product-meta-row">${escapeCatalogHtml(item.category)}</span>
            ${stockBadge}
          </div>
          <button type="button" class="product-title" onclick="viewProductDetails(${item.id})">${escapeCatalogHtml(item.title)}</button>
          ${item.finish ? `<div class="product-finish-line">ফিনিশ: ${escapeCatalogHtml(item.finish)}</div>` : ''}
          <div class="product-price-row">
            <div class="price-box">
              <span class="price-label">মূল্য</span>
              <span class="price-val">${escapeCatalogHtml(formatBdt(item.regular_price))}</span>
            </div>
            ${resellerAccess ? `<div class="commission-box">
              <span class="commission-label">আপনার আয়</span>
              <span class="badge-profit-pill">কমিশন ৳${escapeCatalogHtml(item.reseller_commission)}</span>
            </div>` : ''}
          </div>
          <div class="product-actions">
            ${resellerAccess ? `<button type="button" class="btn-share" onclick="copyProductShareCopy(${item.id})">
              <span aria-hidden="true">📋</span> সেলস পোস্ট কপি
            </button>` : ''}
            <button type="button" class="btn-wa" onclick="orderViaWhatsApp(${item.id})" aria-label="${escapeCatalogHtml(item.title)} WhatsApp-এ অর্ডার করুন">
              <span aria-hidden="true">💬</span><span class="wa-btn-label"> WhatsApp</span>
            </button>
            <button type="button" class="btn-order${inCartQty > 0 && !resellerAccess ? ' is-in-cart' : ''}" ${!inStock && !resellerAccess ? 'disabled' : ''} onclick="${primaryActionOnclick}">
              <span aria-hidden="true">${inStock ? '🛒' : '✕'}</span> <span>${primaryActionLabel}</span>
            </button>
          </div>
        </div>
      </article>
    `;
  }).join('');
}

function renderRecentlyViewedShelf() {
  const section = document.getElementById('recentlyViewedSection');
  const container = document.getElementById('recentlyViewedList');
  if (!section || !container || !Array.isArray(allProducts) || allProducts.length === 0) return;

  const { lastViewedIds } = loadCatalogInterests();
  const matched = (lastViewedIds || [])
    .map((id) => allProducts.find((p) => Number(p.id) === Number(id)))
    .filter(Boolean)
    .slice(0, 6);

  if (matched.length === 0) {
    section.hidden = true;
    if (typeof container.replaceChildren === 'function') container.replaceChildren();
    return;
  }

  section.hidden = false;
  container.innerHTML = matched.map((item) => {
    const rawUrl = safeCatalogImageUrl(item.image_url);
    return `
      <button type="button" class="recent-mini-card" onclick="viewProductDetails(${item.id})">
        <img src="${escapeCatalogHtml(rawUrl)}" ${imageCorsAttrCatalog(rawUrl)} alt="${escapeCatalogHtml(item.title)}" width="160" height="160" loading="lazy" decoding="async" onerror="window.sbHandleImageError && window.sbHandleImageError(this)">
        <span class="recent-mini-title">${escapeCatalogHtml(item.title)}</span>
        <span class="recent-mini-price">${escapeCatalogHtml(formatBdt(item.regular_price))}</span>
      </button>
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
  wishlistFilterActive = false;

  const searchEl = document.getElementById('searchInput');
  const sortEl = document.getElementById('sortSelect');
  const minEl = document.getElementById('minPriceInput');
  const maxEl = document.getElementById('maxPriceInput');
  const clearBtn = document.getElementById('btnClearSearch');
  const wishPill = document.getElementById('btnQuickWishlist');
  if (searchEl) searchEl.value = '';
  if (sortEl) sortEl.value = 'default';
  if (minEl) minEl.value = '';
  if (maxEl) maxEl.value = '';
  if (clearBtn) clearBtn.hidden = true;
  if (wishPill) wishPill.setAttribute('aria-pressed', 'false');

  document.querySelectorAll('.commission-tabs-wrap .tab-btn').forEach((button) => button.classList.toggle('active', button.dataset.tab === 'all'));
  document.querySelectorAll('.category-pills .cat-pill').forEach((button) => button.classList.toggle('active', button.dataset.cat === 'all'));
  document.querySelectorAll('.quick-shop-pill[data-brand]').forEach((button) => button.classList.toggle('active', button.dataset.brand === 'all'));
  loadProducts();
}

function toggleWishlistFilter() {
  wishlistFilterActive = !wishlistFilterActive;
  const wishPill = document.getElementById('btnQuickWishlist');
  if (wishPill) wishPill.setAttribute('aria-pressed', String(wishlistFilterActive));
  renderProductGrid(allProducts);
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

// Brand filtering
function filterByBrand(brandName) {
  currentBrand = brandName;
  wishlistFilterActive = false;
  const wishPill = document.getElementById('btnQuickWishlist');
  if (wishPill) wishPill.setAttribute('aria-pressed', 'false');
  document.querySelectorAll('.quick-shop-pill[data-brand]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.brand === brandName);
  });
  loadProducts();
}

function syncSearchClearButton() {
  const input = document.getElementById('searchInput');
  const btn = document.getElementById('btnClearSearch');
  if (btn && input) btn.hidden = !input.value.trim();
}

function clearCatalogSearch() {
  const input = document.getElementById('searchInput');
  if (input) {
    input.value = '';
    input.focus();
  }
  searchQuery = '';
  syncSearchClearButton();
  loadProducts();
}

function handleSearchNow() {
  clearTimeout(searchTimeout);
  const input = document.getElementById('searchInput');
  searchQuery = input ? input.value : '';
  syncSearchClearButton();
  loadProducts();
}

// Search Handler
function handleSearch() {
  syncSearchClearButton();
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    const input = document.getElementById('searchInput');
    searchQuery = input ? input.value : '';
    loadProducts();
  }, 300);
}

// Sort Handler
function handleSortChange() {
  const sortEl = document.getElementById('sortSelect');
  currentSort = sortEl ? sortEl.value : 'default';
  loadProducts();
}

// Rotate discovery feed seed
function reshuffleCatalogFeed() {
  let attempts = 0;
  let nextSeed = catalogDiscoverySeed;
  while (nextSeed === catalogDiscoverySeed && attempts < 5) {
    attempts += 1;
    nextSeed = (window.SBCatalogAlgorithm && typeof window.SBCatalogAlgorithm.createDiscoverySeed === 'function')
      ? window.SBCatalogAlgorithm.createDiscoverySeed()
      : (((catalogDiscoverySeed + attempts * 2654435761) ^ Date.now()) >>> 0 || 1);
  }
  catalogDiscoverySeed = nextSeed;

  const sortEl = document.getElementById('sortSelect');
  if (sortEl) sortEl.value = 'default';

  if (currentSort !== 'default' || rawCatalogProducts.length === 0) {
    currentSort = 'default';
    loadProducts();
  } else {
    const orderedProducts = applyCatalogOrdering(rawCatalogProducts);
    allProducts = orderedProducts;
    renderProductGrid(orderedProducts);
  }

  if (typeof showToast === 'function') {
    showToast('✨ নতুনভাবে পণ্য সাজানো হয়েছে!');
  }
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
  if (cleanPhone.startsWith('01')) cleanPhone = '88' + cleanPhone;
  else if (cleanPhone.startsWith('1') && cleanPhone.length === 10) cleanPhone = '880' + cleanPhone;
  else if (!cleanPhone.startsWith('88')) cleanPhone = '88' + cleanPhone;

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
  if (refCode) msg += `🔗 রেফার কোড: ${refCode}\n`;
  msg += `🌐 প্রোডাক্ট লিংক: ${productLink}\n\n`;
  msg += `দয়া করে ডেলিভারি ও অর্ডার কনফার্ম করার নিয়ম জানিয়ে দিন। ধন্যবাদ!`;

  window.open(`https://wa.me/${cleanPhone}?text=${encodeURIComponent(msg)}`, '_blank', 'noopener');
}

function formatInlineProductMarkdown(escapedLine) {
  return String(escapedLine || '').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

function formatProductDescriptionHtml(rawDescription) {
  const escaped = escapeCatalogHtml(String(rawDescription || '').trim());
  if (!escaped) return '';

  const lines = escaped.split(/\r?\n/);
  const out = [];
  let listItems = [];
  let tableRows = [];

  const flushList = () => {
    if (!listItems.length) return;
    out.push(`<ul class="pd-md-list">${listItems.map((item) => `<li>${item}</li>`).join('')}</ul>`);
    listItems = [];
  };

  const flushTable = () => {
    if (!tableRows.length) return;
    const isSeparatorRow = (row) => /^\|[\s:|\-]+\|$/.test(row.trim());
    const parseCells = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => formatInlineProductMarkdown(c.trim()));

    const dataRows = tableRows.filter((row) => !isSeparatorRow(row));
    if (dataRows.length === 0) {
      tableRows = [];
      return;
    }

    const headerCells = parseCells(dataRows[0]);
    const bodyRows = dataRows.slice(1).map(parseCells);
    out.push(
      `<div class="pd-md-table-wrap"><table class="pd-md-table"><thead><tr>${headerCells.map((c) => `<th scope="col">${c}</th>`).join('')}</tr></thead>${bodyRows.length ? `<tbody>${bodyRows.map((cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>` : ''}</table></div>`
    );
    tableRows = [];
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      flushList();
      flushTable();
      continue;
    }

    if (trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length > 2) {
      flushList();
      tableRows.push(trimmed);
      continue;
    }
    flushTable();

    if (trimmed.startsWith('### ')) {
      flushList();
      out.push(`<h5 class="pd-md-h3">${formatInlineProductMarkdown(trimmed.slice(4))}</h5>`);
    } else if (trimmed.startsWith('## ')) {
      flushList();
      out.push(`<h4 class="pd-md-h2">${formatInlineProductMarkdown(trimmed.slice(3))}</h4>`);
    } else if (trimmed.startsWith('# ')) {
      flushList();
      out.push(`<h4 class="pd-md-h2">${formatInlineProductMarkdown(trimmed.slice(2))}</h4>`);
    } else if (/^(?:-|•|\*)\s+/.test(trimmed)) {
      listItems.push(formatInlineProductMarkdown(trimmed.replace(/^(?:-|•|\*)\s+/, '')));
    } else {
      flushList();
      out.push(`<p class="pd-md-p">${formatInlineProductMarkdown(trimmed)}</p>`);
    }
  }

  flushList();
  flushTable();
  return out.join('');
}

function stripMarkdownForPlainShare(rawText) {
  return String(rawText || '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^\|[\s:|\-]+\|$/gm, '')
    .replace(/^\|\s*|\s*\|$/gm, '')
    .replace(/\s*\|\s*/g, ': ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 1-Click Social Sharing Copy Generator
function generateShareText(item) {
  const isFurniture = item.brand === 'SB Furniture';
  const isLifestyle = item.brand === 'SB Lifestyle & Tools';
  const phone = String(isFurniture ? '01929621855' : '01634664224').replace(/\D/g, '');
  const trustLine = isFurniture
    ? 'SB Furniture-এর ফার্নিচার ও দোকান সাজানোর পণ্য।'
    : isLifestyle
      ? 'SB Lifestyle & Tools-এর পণ্য; কন্ডিশন ও বিবরণ দেখে অর্ডার করুন।'
      : 'SB POWER-এর গ্যাজেট; পণ্যের ব্র্যান্ড ও বিবরণ দেখে অর্ডার করুন।';

  const activeUser = (typeof currentUser !== 'undefined' && currentUser) ? currentUser : JSON.parse(localStorage.getItem('sb_user') || 'null');
  const refCode = activeUser && ['reseller', 'admin'].includes(activeUser.role) ? activeUser.referral_code : '';
  const appBaseUrl = window.location.origin;
  const productLink = refCode ? `${appBaseUrl}/?ref=${refCode}&sku=${item.sku}` : `${appBaseUrl}/?sku=${item.sku}`;

  if (item.caption && String(item.caption).trim()) {
    let post = String(item.caption).trim();
    if (!post.includes(phone)) post += `\n\n📞 Call / WhatsApp: ${phone}`;
    post += `\n🌐 সরাসরি অনলাইন অর্ডার লিংক: ${productLink}`;
    return post;
  }

  let text = `🔥 ${item.title}\n`;
  text += `💵 বিক্রয় মূল্য: ${item.regular_price} ৳\n`;
  if (item.materials) text += `🪵 বোর্ড/উপকরণ: ${item.materials}\n`;
  if (item.finish) text += `🎨 ফিনিশিং ও কালার: ${item.finish}\n`;
  if (item.description) text += `📌 বিবরণ:\n${stripMarkdownForPlainShare(item.description)}\n`;
  text += `\n✅ ${trustLine}\n`;
  text += `\n📦 পণ্য সম্পর্কে জানতে Call / WhatsApp: ${phone}\n`;
  text += `🌐 সরাসরি অনলাইন অর্ডার লিংক: ${productLink}`;

  return text;
}

async function copyTextWithFeedback(text, triggerBtn, feedbackText) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }
  if (triggerBtn) {
    const original = triggerBtn.innerHTML;
    triggerBtn.textContent = feedbackText;
    setTimeout(() => { triggerBtn.innerHTML = original; }, 1800);
  }
  if (typeof showToast === 'function') showToast(feedbackText);
}

// Copy Share Text to Clipboard
async function copyProductShareCopy(productId, triggerBtn = null) {
  if (!hasResellerAccess()) return;
  const item = allProducts.find((p) => p.id === productId);
  if (!item) return;
  await copyTextWithFeedback(generateShareText(item), triggerBtn, '✅ ক্যাপশন ও লিংক কপি হয়েছে!');
}

async function copyCustomerProductLink(productIdOrSku, triggerBtn = null) {
  const found = typeof productIdOrSku === 'number'
    ? allProducts.find((p) => Number(p.id) === productIdOrSku)
    : allProducts.find((p) => String(p.sku) === String(productIdOrSku));
  const sku = found ? found.sku : String(productIdOrSku || '');
  const title = found ? `${found.title} (${sku})` : `${sku} — SB Power BD`;
  const link = `${window.location.origin}/?sku=${encodeURIComponent(sku)}`;
  if (navigator.share) {
    try {
      await navigator.share({ title, url: link });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  await copyTextWithFeedback(link, triggerBtn, '🔗 প্রোডাক্ট লিংক কপি হয়েছে!');
}

function openProductLightboxById(productId) {
  const item = allProducts.find((p) => Number(p.id) === Number(productId));
  if (!item || typeof openImageLightbox !== 'function') return;
  openImageLightbox(safeCatalogImageUrl(item.image_url), item.title || '');
}

function changeDetailQty(delta, maxStock = 50) {
  const qtyEl = document.getElementById('modalDetailQty');
  if (!qtyEl) return;
  const current = parseInt(qtyEl.textContent, 10) || 1;
  const limit = Math.max(1, Math.min(50, Number(maxStock) || 50));
  const next = Math.max(1, Math.min(limit, current + delta));
  qtyEl.textContent = String(next);
}

function renderCustomerProductDetails(item) {
  const isFurniture = item.brand === 'SB Furniture';
  const phone = isFurniture ? '01929621855' : '01634664224';
  const deliveryEta = isFurniture ? '২–৫ কার্যদিবস (ঢাকা ৫০০৳ / বাইরে ১০০০৳)' : '১–৩ কার্যদিবস (ঢাকা ৮০৳ / বাইরে ১৫০৳)';
  const inStock = Number(item.stock) > 0;
  const wishActive = typeof window.isProductWishlisted === 'function' && window.isProductWishlisted(item.id);
  const rawSafeImageUrl = safeCatalogImageUrl(item.image_url);
  const imageUrl = escapeCatalogHtml(rawSafeImageUrl);
  const imgCors = imageCorsAttrCatalog(rawSafeImageUrl);
  const colorSelectorHtml = item.sku === 'SBP-103' || (item.finish && item.finish.includes('কালার'))
    ? `<div class="form-group" style="margin-top: 10px;">
        <label class="form-label" for="modalColorSelect">পছন্দের রং নির্বাচন করুন</label>
        <select id="modalColorSelect" class="form-control">
          <option value="Black">ব্ল্যাক (Black)</option><option value="Silver">সিলভার (Silver)</option>
          <option value="Blue">ব্লু (Blue)</option><option value="Red">রেড (Red)</option>
        </select>
      </div>`
    : '';

  document.getElementById('modalProductTitle').textContent = `${item.sku} — পণ্যের বিস্তারিত`;
  document.getElementById('modalProductBody').innerHTML = `
    <div class="product-detail-img-wrap">
      <button type="button" class="product-detail-zoom-btn" onclick="openProductLightboxById(${item.id})" aria-label="পণ্যের ছবি বড় করে দেখুন">
        <img src="${imageUrl}" ${imgCors} alt="${escapeCatalogHtml(item.title)}" class="product-detail-img" width="600" height="400" decoding="async" onerror="window.sbHandleImageError && window.sbHandleImageError(this)">
        <span class="product-detail-zoom-hint">🔍 বড় করে দেখুন</span>
      </button>
    </div>
    <div class="product-detail-badges">
      <span class="badge-sku">${escapeCatalogHtml(item.sku)}</span>
      <span class="product-detail-brand-tag">${escapeCatalogHtml(item.brand)}</span>
      <span class="badge-stock ${inStock ? 'in-stock' : 'out-of-stock'}">${inStock ? `স্টক: ${escapeCatalogHtml(item.stock)}টি` : 'স্টক শেষ'}</span>
    </div>
    <h2 class="product-detail-title">${escapeCatalogHtml(item.title)}</h2>
    <div class="product-detail-price-bar">
      <div class="product-detail-price">মূল্য: ${escapeCatalogHtml(formatBdt(item.regular_price))}</div>
      <span class="badge-profit-pill">✓ ক্যাশ অন ডেলিভারি</span>
    </div>
    <div class="pd-trust-strip">
      <div class="pd-trust-chip"><strong>🚚 ডেলিভারি</strong>${deliveryEta}</div>
      <div class="pd-trust-chip"><strong>🛡️ নিশ্চয়তা</strong>যাচাইকৃত পণ্য ও সরাসরি সাপোর্ট</div>
    </div>
    <div class="product-detail-desc">
      ${item.materials ? `<div><strong>উপকরণ:</strong> ${escapeCatalogHtml(item.materials)}</div>` : ''}
      ${item.finish ? `<div><strong>ফিনিশিং:</strong> ${escapeCatalogHtml(item.finish)}</div>` : ''}
      <div class="product-detail-desc-body">${formatProductDescriptionHtml(item.description)}</div>
    </div>
    ${colorSelectorHtml}
    ${inStock ? `
      <div class="pd-qty-bar">
        <span class="form-label" style="margin: 0;">পরিমাণ নির্বাচন</span>
        <div class="pd-qty-controls">
          <button type="button" class="btn-nav" onclick="changeDetailQty(-1, ${Number(item.stock)})" aria-label="পরিমাণ কমান">−</button>
          <span class="pd-qty-val" id="modalDetailQty">1</span>
          <button type="button" class="btn-nav" onclick="changeDetailQty(1, ${Number(item.stock)})" aria-label="পরিমাণ বাড়ান">+</button>
        </div>
      </div>
    ` : ''}
    <div class="product-detail-actions">
      <button type="button" class="btn-wa" style="min-block-size: 48px; border-radius: var(--radius-sm); font-weight: 700;" onclick="orderViaWhatsApp(${item.id})">💬 WhatsApp-এ অর্ডার</button>
      <button type="button" class="btn-submit" ${inStock ? '' : 'disabled'} onclick="addToCartFromModal(${item.id})">${inStock ? '🛒 কার্টে যোগ করুন' : 'স্টক শেষ'}</button>
    </div>
    <div class="pd-detail-share-row">
      <button type="button" class="btn-secondary-solid" data-wish-detail-btn onclick="toggleWishlist(${item.id}, this)">${wishActive ? '❤️ পছন্দে আছে' : '🤍 পছন্দে রাখুন'}</button>
      <button type="button" class="btn-secondary-solid" onclick="copyCustomerProductLink(${item.id}, this)">🔗 লিংক শেয়ার</button>
    </div>
    <div class="product-detail-hotline">
      পণ্য সম্পর্কে জানতে কল করুন: <a href="tel:${phone}">${phone}</a>
    </div>
  `;
  if (typeof openModal === 'function') openModal('productDetailModal');
}

// View Product Details with One-Tap Reseller Toolkit
function viewProductDetails(productId) {
  const item = allProducts.find((p) => p.id === productId);
  if (!item) return;
  recordCatalogInterest(item);

  if (!hasResellerAccess()) {
    renderCustomerProductDetails(item);
    return;
  }

  const isFurniture = item.brand === 'SB Furniture';
  const phone = String(isFurniture ? '01929621855' : '01634664224').replace(/\D/g, '');
  const rawSafeImageUrl = safeCatalogImageUrl(item.image_url);
  const imageUrl = escapeCatalogHtml(rawSafeImageUrl);
  const imgCors = imageCorsAttrCatalog(rawSafeImageUrl);
  const inStock = Number(item.stock) > 0;
  const wishActive = typeof window.isProductWishlisted === 'function' && window.isProductWishlisted(item.id);

  document.getElementById('modalProductTitle').textContent = item.sku + ' — বিস্তারিত তথ্য ও রিসেলার টুলকিট';

  let colorSelectorHtml = '';
  if (item.sku === 'SBP-103' || (item.finish && item.finish.includes('কালার'))) {
    colorSelectorHtml = `
      <div class="form-group" style="margin-top: 10px;">
        <label class="form-label" for="modalColorSelect">পছন্দের কালার সিলেক্ট করুন:</label>
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
      <button type="button" class="product-detail-zoom-btn" onclick="openProductLightboxById(${item.id})" aria-label="পণ্যের ছবি বড় করে দেখুন">
        <img src="${imageUrl}" ${imgCors} alt="${escapeCatalogHtml(item.title)}" class="product-detail-img" width="600" height="400" decoding="async" onerror="window.sbHandleImageError && window.sbHandleImageError(this)">
        <span class="product-detail-zoom-hint">🔍 বড় করে দেখুন</span>
      </button>
    </div>
    <div class="product-detail-badges">
      <span class="badge-sku">${escapeCatalogHtml(item.sku)}</span>
      <span class="badge-profit-pill">কমিশন ৳${escapeCatalogHtml(item.reseller_commission)}</span>
      <span class="product-detail-brand-tag">${escapeCatalogHtml(item.brand)}</span>
    </div>
    <h2 class="product-detail-title">${escapeCatalogHtml(item.title)}</h2>
    <div class="product-detail-price-bar">
      <div class="product-detail-price">
        কাস্টমার মূল্য: ${escapeCatalogHtml(formatBdt(item.regular_price))}
      </div>
      <div class="badge-profit-pill" style="font-size: 0.82rem; padding: 4px 11px;">
        আপনার নিট কমিশন: ৳${escapeCatalogHtml(item.reseller_commission)}
      </div>
    </div>
    <div class="product-detail-desc">
      ${item.materials ? `<div><strong>উপকরণ:</strong> ${escapeCatalogHtml(item.materials)}</div>` : ''}
      ${item.finish ? `<div><strong>ফিনিশিং:</strong> ${escapeCatalogHtml(item.finish)}</div>` : ''}
      <div class="product-detail-desc-body">${formatProductDescriptionHtml(item.description)}</div>
    </div>
    ${colorSelectorHtml}

    <!-- One-Tap Reseller Toolkit -->
    <div class="reseller-toolkit-box">
      <div class="toolkit-title">
        <span>⚡ রিসেলার টুলকিট</span>
        <span class="toolkit-title-hint">১-ক্লিকে শেয়ার ও অর্ডার</span>
      </div>
      <div class="toolkit-action-grid">
        <button type="button" class="btn-toolkit btn-toolkit-copy" onclick="copyProductShareCopy(${item.id}, this)">
          <span aria-hidden="true">📋</span> কপি সেলস পোস্ট
        </button>
        <button type="button" class="btn-toolkit btn-toolkit-share" onclick="shareProductToolkit(${item.id}, this)">
          <span aria-hidden="true">📲</span> ছবি ও লিংক শেয়ার
        </button>
        <button type="button" id="btnToggleTkAccordion" class="btn-toolkit btn-toolkit-order" aria-expanded="false" aria-controls="custOrderAccordionPanel" onclick="toggleCustomerOrderAccordion()">
          <span aria-hidden="true">🛒</span> কাস্টমারের জন্য সরাসরি অর্ডার করুন ▾
        </button>
      </div>

      <!-- Accessible Customer Order Form -->
      <div id="custOrderAccordionPanel" class="customer-order-panel" hidden>
        <h3 style="color: var(--brand-primary-hv); font-size: 0.96rem; margin-bottom: 10px;">📦 কাস্টমার অর্ডার ফর্ম (সরাসরি আপনার রেফারে)</h3>
        <form id="toolkitOrderForm" novalidate>
          <div class="form-group">
            <label class="form-label form-label-sm" for="tkCustName">কাস্টমারের পূর্ণ নাম <span aria-hidden="true">*</span></label>
            <input type="text" id="tkCustName" name="customer_name" class="form-control" autocomplete="name" maxlength="100" required placeholder="যেমন: মো: করিম হোসেন">
            <p class="field-error" id="tkCustNameError" role="alert" hidden></p>
          </div>
          <div class="form-group">
            <label class="form-label form-label-sm" for="tkCustPhone">কাস্টমারের মোবাইল নম্বর (১১ ডিজিট) <span aria-hidden="true">*</span></label>
            <input type="tel" id="tkCustPhone" name="customer_phone" class="form-control" inputmode="tel" autocomplete="tel" maxlength="15" required placeholder="01XXXXXXXXX">
            <p class="field-error" id="tkCustPhoneError" role="alert" hidden></p>
          </div>
          <div class="form-group">
            <label class="form-label form-label-sm" for="tkCustAddress">সম্পূর্ণ ডেলিভারি ঠিকানা <span aria-hidden="true">*</span></label>
            <textarea id="tkCustAddress" name="delivery_address" class="form-control" rows="2" autocomplete="street-address" maxlength="300" required placeholder="বাড়ি/রোড/এলাকা/উপজেলা/জেলা"></textarea>
            <p class="field-error" id="tkCustAddressError" role="alert" hidden></p>
          </div>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
            <div class="form-group">
              <label class="form-label form-label-sm" for="tkOrderQty">পরিমাণ (Quantity)</label>
              <input type="number" id="tkOrderQty" name="quantity" class="form-control" inputmode="numeric" value="1" min="1" max="50" oninput="updateToolkitLiveProfit(${item.id})">
            </div>
            <div class="form-group">
              <label class="form-label form-label-sm" for="tkOrderCity">ডেলিভারি এরিয়া</label>
              <select id="tkOrderCity" name="delivery_city" class="form-control" onchange="updateToolkitLiveProfit(${item.id})">
                <option value="inside_dhaka">ঢাকা ভেতরে (${isFurniture ? '৫০০৳' : '৮০৳'})</option>
                <option value="outside_dhaka">ঢাকার বাইরে (${isFurniture ? '১০০০৳' : '১৫০৳'})</option>
              </select>
            </div>
          </div>

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

          <div class="form-alert-error" id="tkOrderSubmitError" role="alert" hidden></div>
          <button type="submit" id="btnSubmitTkOrder" class="btn-submit">নিশ্চিত করুন ও কাস্টমারের অর্ডার প্লেস করুন</button>
        </form>
      </div>
    </div>

    <div class="product-detail-actions">
      <button type="button" class="btn-wa" style="min-block-size: 46px; border-radius: var(--radius-sm); font-weight: 700;" onclick="orderViaWhatsApp(${item.id})">
        💬 WhatsApp হটলাইন
      </button>
      <button type="button" class="btn-secondary-solid" ${inStock ? '' : 'disabled'} onclick="addToCartFromModal(${item.id})">
        🛒 নিজের কার্টে নিন
      </button>
    </div>
    <div class="pd-detail-share-row">
      <button type="button" class="btn-secondary-solid" data-wish-detail-btn onclick="toggleWishlist(${item.id}, this)">${wishActive ? '❤️ পছন্দে আছে' : '🤍 পছন্দে রাখুন'}</button>
    </div>

    <div class="product-detail-hotline">
      কাস্টমাইজেশন বা সরাসরি অর্ডারে কল করুন: <a href="tel:${phone}">${phone}</a>
    </div>
  `;

  const tkForm = document.getElementById('toolkitOrderForm');
  if (tkForm) {
    tkForm.addEventListener('submit', (e) => {
      e.preventDefault();
      submitToolkitCustomerOrder(item.id);
    });
    if (typeof bindToolkitBlurValidation === 'function') bindToolkitBlurValidation(tkForm);
  }

  if (typeof openModal === 'function') openModal('productDetailModal');
}

// Toolkit Web Share API Helper
async function shareProductToolkit(productId, triggerBtn = null) {
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
      if (typeof showToast === 'function') showToast('✅ সফলভাবে শেয়ার করা হয়েছে!');
      return;
    } catch (e) {
      if (e.name !== 'AbortError') copyProductShareCopy(productId, triggerBtn);
    }
  } else {
    copyProductShareCopy(productId, triggerBtn);
    window.open(safeCatalogImageUrl(item.image_url), '_blank', 'noopener');
  }
}

function toggleCustomerOrderAccordion() {
  const panel = document.getElementById('custOrderAccordionPanel');
  const btn = document.getElementById('btnToggleTkAccordion');
  if (!panel) return;
  const nextOpen = panel.hidden;
  panel.hidden = !nextOpen;
  if (btn) btn.setAttribute('aria-expanded', String(nextOpen));
}

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

function bindToolkitBlurValidation(form) {
  const checks = {
    tkCustName: (val) => (val.trim().length >= 2 ? '' : 'কাস্টমারের সঠিক পূর্ণ নাম দিন'),
    tkCustPhone: (val) => (typeof isValidBdPhone === 'function' && isValidBdPhone(val) ? '' : 'সঠিক ১১ ডিজিটের মোবাইল নম্বর দিন'),
    tkCustAddress: (val) => (val.trim().length >= 5 ? '' : 'কাস্টমারের সম্পূর্ণ ডেলিভারি ঠিকানা লিখুন')
  };
  if (typeof window.bindFormFieldValidation === 'function') {
    window.bindFormFieldValidation(form, checks);
  }
}

// One-Tap Customer Order Submission (inline validation, zero alert())
async function submitToolkitCustomerOrder(productId) {
  const item = allProducts.find((p) => p.id === productId);
  if (!item) return;

  const form = document.getElementById('toolkitOrderForm');
  const nameInput = document.getElementById('tkCustName');
  const phoneInput = document.getElementById('tkCustPhone');
  const addressInput = document.getElementById('tkCustAddress');
  const cityInput = document.getElementById('tkOrderCity');
  const qtyInput = document.getElementById('tkOrderQty');
  const colorSelect = document.getElementById('modalColorSelect');
  const formAlert = document.getElementById('tkOrderSubmitError');

  if (formAlert) {
    formAlert.hidden = true;
    formAlert.textContent = '';
  }

  const customer_name = nameInput ? nameInput.value.trim() : '';
  const customer_phone = phoneInput ? phoneInput.value.trim() : '';
  const delivery_address = addressInput ? addressInput.value.trim() : '';
  const delivery_city = cityInput ? cityInput.value : 'inside_dhaka';
  const quantity = Math.max(1, parseInt(qtyInput ? qtyInput.value : 1, 10) || 1);
  const selected_color = colorSelect ? colorSelect.value : '';

  const checks = [
    ['tkCustName', customer_name.length >= 2 ? '' : 'কাস্টমারের সঠিক পূর্ণ নাম দিন'],
    ['tkCustPhone', (typeof isValidBdPhone === 'function' ? isValidBdPhone(customer_phone) : /^01[3-9]\d{8}$/.test(customer_phone.replace(/\D/g, ''))) ? '' : 'সঠিক ১১ ডিজিটের মোবাইল নম্বর দিন'],
    ['tkCustAddress', delivery_address.length >= 5 ? '' : 'কাস্টমারের সম্পূর্ণ ঠিকানা লিখুন']
  ];
  let firstBadEl = null;
  for (const [id, errMsg] of checks) {
    if (typeof window.setFieldError === 'function') window.setFieldError(id, errMsg);
    if (errMsg && !firstBadEl) firstBadEl = document.getElementById(id);
  }
  if (firstBadEl) {
    firstBadEl.focus();
    return;
  }

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
      if (typeof closeModal === 'function') closeModal('productDetailModal');
      if (typeof showOrderSuccessInTracking === 'function') {
        showOrderSuccessInTracking(data.order, customer_phone);
      } else if (typeof openModal === 'function') {
        const trackInput = document.getElementById('trackOrderInput');
        const phoneTrack = document.getElementById('trackCustomerPhone');
        if (trackInput) trackInput.value = data.order.order_number;
        if (phoneTrack) phoneTrack.value = customer_phone;
        openModal('trackModal');
        if (typeof trackOrder === 'function') trackOrder();
      }
    } else if (formAlert) {
      formAlert.textContent = data.message || 'অর্ডার প্লেস ব্যর্থ হয়েছে';
      formAlert.hidden = false;
    }
  } catch (err) {
    console.error(err);
    if (formAlert) {
      formAlert.textContent = 'অর্ডার সাবমিট করতে সমস্যা হয়েছে, আবার চেষ্টা করুন।';
      formAlert.hidden = false;
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'নিশ্চিত করুন ও কাস্টমারের অর্ডার প্লেস করুন';
    }
    if (form) form.dataset.submitted = 'true';
  }
}
