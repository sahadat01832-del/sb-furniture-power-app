// ============================================================
// SB Power BD — Core App, Native Dialogs, Forms, Wishlist & Wallet
// ============================================================

const readStoredJson = (key, fallback) => {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null');
    return value === null ? fallback : value;
  } catch (error) {
    return fallback;
  }
};

const storedCart = readStoredJson('sb_cart', []);
let cart = (Array.isArray(storedCart) ? storedCart : []).filter((item) =>
  item && item.product && Number.isSafeInteger(Number(item.product.id)) &&
  Number.isSafeInteger(Number(item.quantity)) && Number(item.quantity) > 0 && Number(item.quantity) <= 100
).map((item) => ({
  product: item.product,
  quantity: Number(item.quantity),
  selected_color: typeof item.selected_color === 'string' ? item.selected_color.slice(0, 80) : ''
}));

const storedWishlist = readStoredJson('sb_wishlist', []);
let wishlistIds = Array.isArray(storedWishlist)
  ? [...new Set(storedWishlist.map((id) => Number(id)).filter((id) => Number.isSafeInteger(id) && id > 0))]
  : [];

let currentUser = readStoredJson('sb_user', null);
if (!currentUser || typeof currentUser !== 'object' || typeof currentUser.name !== 'string') currentUser = null;
let authToken = localStorage.getItem('sb_token') || null;
let toastTimer = null;
let supportsDisplayTransitionCache;

const api = (path) => (typeof window.apiUrl === 'function' ? window.apiUrl(path) : path);
const escapeAppHtml = (value) => window.sbEscapeHtml(value);
const isValidBdPhone = (value) => /^01[3-9]\d{8}$/.test(String(value || '').replace(/\D/g, ''));

function announceStatus(message) {
  const text = String(message || '').trim();
  if (!text) return;
  try {
    if (typeof document.ariaNotify === 'function') {
      document.ariaNotify(text);
      return;
    }
  } catch {}
  const announcer = document.getElementById('srAnnouncer');
  if (announcer) {
    announcer.textContent = '';
    requestAnimationFrame(() => { announcer.textContent = text; });
  }
}

// ================= ACCESSIBLE TOP-LAYER TOAST =================
function hideToast() {
  const toast = document.getElementById('toast');
  if (!toast) return;
  clearTimeout(toastTimer);
  try {
    if (typeof toast.hidePopover === 'function' && toast.matches(':popover-open')) {
      toast.hidePopover();
    }
  } catch {}
  toast.classList.remove('show', ':popover-open');
}

function showToast(message) {
  const text = String(message || '').trim();
  if (!text) return;
  announceStatus(text);

  // Per Modern Web Guidance: avoid covering open modal dialogs with background toasts
  if (document.querySelector('dialog[open]:not([data-closing])')) {
    return;
  }

  const toast = document.getElementById('toast');
  const toastText = document.getElementById('toastText');
  if (!toast || !toastText) return;

  toastText.textContent = text;
  clearTimeout(toastTimer);

  try {
    if (Object.hasOwn(HTMLElement.prototype, 'popover') && typeof toast.showPopover === 'function') {
      if (!toast.matches(':popover-open')) toast.showPopover();
    } else {
      toast.classList.add('show');
    }
  } catch {
    toast.classList.add('show');
  }

  const scheduleHide = () => {
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (toast.contains(document.activeElement)) {
        scheduleHide();
        return;
      }
      hideToast();
    }, 3200);
  };
  scheduleHide();

  if (!toast._hoverBound) {
    toast._hoverBound = true;
    toast.addEventListener('pointerenter', () => clearTimeout(toastTimer));
    toast.addEventListener('pointerleave', scheduleHide);
    toast.addEventListener('focusin', () => clearTimeout(toastTimer));
    toast.addEventListener('focusout', scheduleHide);
  }
}

// ================= NATIVE <dialog> MODALS & TOP-LAYER ANIMATION =================
function canTransitionDisplay() {
  if (supportsDisplayTransitionCache !== undefined) return supportsDisplayTransitionCache;
  if (!window.CSS?.supports?.('transition-behavior', 'allow-discrete') || !document.body) {
    supportsDisplayTransitionCache = false;
    return false;
  }
  const probe = document.createElement('div');
  probe.style.cssText = 'transition: display 1s allow-discrete !important; display: block;';
  document.body.appendChild(probe);
  getComputedStyle(probe).display;
  probe.style.display = 'none';
  supportsDisplayTransitionCache = getComputedStyle(probe).display === 'block';
  probe.remove();
  return supportsDisplayTransitionCache;
}

function supportsTopLayerExit() {
  return Boolean(window.CSS?.supports?.('overlay', 'auto') && canTransitionDisplay());
}

async function closeTopLayerDialog(dialog) {
  if (!dialog || !dialog.open) return;
  if (!supportsTopLayerExit()) {
    dialog.setAttribute('data-closing', '');
    const animations = typeof dialog.getAnimations === 'function' ? dialog.getAnimations({ subtree: true }) : [];
    if (animations.length > 0) {
      await Promise.race([
        Promise.allSettled(animations.map((a) => a.finished)),
        new Promise((resolve) => setTimeout(resolve, 600))
      ]);
    }
    if (!dialog.hasAttribute('data-closing')) return;
    dialog.removeAttribute('data-closing');
  }
  dialog.close();
}

function bindDialogHandlers(dialog) {
  if (dialog._dialogInit) return;
  dialog._dialogInit = true;

  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeTopLayerDialog(dialog);
  });

  dialog.addEventListener('close', () => {
    dialog.removeAttribute('data-closing');
    dialog.returnValue = '';
  });

  // Progressive fallback for browsers without <dialog closedby="any">
  if (!('closedBy' in HTMLDialogElement.prototype)) {
    const isOutside = (e) => {
      const rect = dialog.getBoundingClientRect();
      return e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom;
    };
    let pressedOutside = false;
    dialog.addEventListener('pointerdown', (e) => { pressedOutside = isOutside(e); });
    dialog.addEventListener('pointerup', (e) => {
      if (pressedOutside && isOutside(e)) closeTopLayerDialog(dialog);
      pressedOutside = false;
    });
  }
}

function openModal(id) {
  hideToast();
  const modal = document.getElementById(id);
  if (!modal) return;
  if (typeof modal.showModal === 'function') {
    bindDialogHandlers(modal);
    modal.removeAttribute('data-closing');
    if (!modal.open) modal.showModal();
  } else {
    modal.classList.add('active');
  }
}

function closeModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  if (typeof modal.close === 'function') {
    closeTopLayerDialog(modal);
  } else {
    modal.classList.remove('active');
  }
}

// ================= FORM VALIDATION & PASSWORD VISIBILITY HELPERS =================
function setFieldError(inputId, message = '') {
  const input = document.getElementById(inputId);
  const errorEl = document.getElementById(`${inputId}Error`);
  if (input) {
    if (message) {
      input.setAttribute('aria-invalid', 'true');
      if (errorEl) {
        const described = new Set(String(input.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
        described.add(`${inputId}Error`);
        input.setAttribute('aria-describedby', [...described].join(' '));
      }
    } else {
      input.removeAttribute('aria-invalid');
    }
  }
  if (errorEl) {
    errorEl.textContent = message || '';
    errorEl.hidden = !message;
  }
}

function setFormAlertError(alertId, message = '') {
  const el = document.getElementById(alertId);
  if (!el) return;
  el.textContent = message || '';
  el.hidden = !message;
}

function bindFormFieldValidation(form, ruleMap) {
  if (!form || !ruleMap) return;
  Object.entries(ruleMap).forEach(([fieldId, validator]) => {
    const input = document.getElementById(fieldId);
    if (!input || input._valBound) return;
    input._valBound = true;
    input.addEventListener('input', () => {
      if (input.getAttribute('aria-invalid') === 'true') {
        const msg = validator(input.value);
        if (!msg) setFieldError(fieldId, '');
      }
    });
    input.addEventListener('blur', () => {
      if (input.value.trim() || form.dataset.submitted === 'true') {
        setFieldError(fieldId, validator(input.value));
      }
    });
  });
}

function validateFields(checks) {
  let firstInvalid = null;
  for (const [fieldId, message] of checks) {
    setFieldError(fieldId, message);
    if (message && !firstInvalid) firstInvalid = document.getElementById(fieldId);
  }
  if (firstInvalid) firstInvalid.focus();
  return !firstInvalid;
}

function attachPasswordToggles(root = document) {
  root.querySelectorAll('.btn-toggle-pass').forEach((btn) => {
    if (btn._toggleBound) return;
    btn._toggleBound = true;
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.target;
      const input = targetId ? document.getElementById(targetId) : null;
      if (!input) return;
      const reveal = input.type === 'password';
      input.type = reveal ? 'text' : 'password';
      btn.setAttribute('aria-pressed', String(reveal));
      btn.setAttribute('aria-label', reveal ? 'পাসওয়ার্ড লুকান' : 'পাসওয়ার্ড দেখুন');
      btn.textContent = reveal ? 'লুকান' : 'দেখুন';
    });
  });
}

window.setFieldError = setFieldError;
window.setFormAlertError = setFormAlertError;
window.bindFormFieldValidation = bindFormFieldValidation;
window.isValidBdPhone = isValidBdPhone;

// ================= WISHLIST, LIGHTBOX & POLICIES =================
function saveWishlist() {
  try {
    localStorage.setItem('sb_wishlist', JSON.stringify(wishlistIds));
  } catch {}
  updateWishlistBadges();
}

function isProductWishlisted(productId) {
  return wishlistIds.includes(Number(productId));
}
window.isProductWishlisted = isProductWishlisted;

function updateWishlistBadges() {
  const count = wishlistIds.length;
  const navBadge = document.getElementById('navWishBadge');
  const pillCount = document.getElementById('wishPillCount');
  if (navBadge) navBadge.textContent = count;
  if (pillCount) pillCount.textContent = count;
}

function toggleWishlist(productId, detailBtn = null) {
  const idNum = Number(productId);
  if (!Number.isSafeInteger(idNum) || idNum <= 0) return;

  const exists = wishlistIds.includes(idNum);
  if (exists) {
    wishlistIds = wishlistIds.filter((id) => id !== idNum);
  } else {
    wishlistIds = [idNum, ...wishlistIds].slice(0, 60);
  }
  saveWishlist();

  const cardBtn = document.querySelector(`.btn-wishlist-card[data-wish-id="${idNum}"]`);
  if (cardBtn) {
    cardBtn.setAttribute('aria-pressed', String(!exists));
    cardBtn.textContent = !exists ? '❤️' : '🤍';
  }
  if (detailBtn) {
    detailBtn.textContent = !exists ? '❤️ পছন্দে আছে' : '🤍 পছন্দে রাখুন';
  }

  if (typeof wishlistFilterActive !== 'undefined' && wishlistFilterActive && typeof renderProductGrid === 'function') {
    renderProductGrid(allProducts);
  }
  showToast(!exists ? '❤️ পছন্দের তালিকায় যোগ হয়েছে!' : 'পছন্দের তালিকা থেকে সরানো হয়েছে');
}

function openWishlistModal() {
  const body = document.getElementById('wishlistModalBody');
  if (!body) return;
  const productsSource = typeof allProducts !== 'undefined' && Array.isArray(allProducts) ? allProducts : [];
  const items = wishlistIds.map((id) => productsSource.find((p) => Number(p.id) === id)).filter(Boolean);

  if (items.length === 0) {
    body.innerHTML = `
      <div class="empty-state-card" style="margin: 0; border: 0; box-shadow: none;">
        <div class="empty-icon">❤️</div>
        <h2>আপনার পছন্দের তালিকা খালি</h2>
        <p>যেসব পণ্য আপনার ভালো লাগে, সেগুলোর ছবির ওপর থাকা হার্ট (🤍) বাটনে চাপ দিলে এখানে সেভ থাকবে।</p>
        <button type="button" class="btn-submit" style="max-width: 220px; margin: 0 auto;" onclick="closeModal('wishlistModal')">পণ্য দেখুন</button>
      </div>
    `;
  } else {
    body.innerHTML = `
      ${items.map((item) => {
        const rawUrl = typeof window.sbSafeImageUrl === 'function' ? window.sbSafeImageUrl(item.image_url) : item.image_url;
        const corsAttr = typeof window.sbImageCrossOriginAttr === 'function' ? window.sbImageCrossOriginAttr(rawUrl) : '';
        return `
          <div class="cart-item-card">
            <img src="${escapeAppHtml(rawUrl)}" ${corsAttr} alt="${escapeAppHtml(item.title)}" class="cart-item-thumb" width="52" height="52" loading="lazy" onerror="window.sbHandleImageError && window.sbHandleImageError(this)">
            <div style="flex: 1; min-width: 0;">
              <div class="cart-item-title">${escapeAppHtml(item.title)}</div>
              <div class="cart-item-sku">${escapeAppHtml(item.sku)} · ${escapeAppHtml(item.regular_price)} ৳</div>
            </div>
            <div class="cart-qty-controls">
              <button type="button" class="btn-nav" onclick="closeModal('wishlistModal'); viewProductDetails(${item.id});">দেখুন</button>
              <button type="button" class="btn-nav" onclick="toggleWishlist(${item.id}); openWishlistModal();" aria-label="পছন্দ থেকে সরান">🗑️</button>
            </div>
          </div>
        `;
      }).join('')}
      <button type="button" class="btn-submit" style="margin-top: 10px;" onclick="closeModal('wishlistModal'); if(typeof switchMainTab==='function') switchMainTab('shop');">শপে ফিরে যান</button>
    `;
  }
  openModal('wishlistModal');
}

function openPolicyModal() {
  openModal('policyModal');
}

function openImageLightbox(imageSrc, caption = '') {
  const img = document.getElementById('lightboxImg');
  const capEl = document.getElementById('lightboxCaption');
  if (img) {
    img.src = imageSrc;
    img.alt = caption || 'পণ্যের বড় ছবি';
  }
  if (capEl) capEl.textContent = caption || '';
  openModal('lightboxModal');
}

// ================= APP INITIALIZATION =================
document.addEventListener('DOMContentLoaded', () => {
  captureReferralCode();
  updateCartBadges();
  updateWishlistBadges();
  updateAuthUI();
  loadProducts();
  loadConfig();
  initCheckoutForm();
  initTrackModalForm();

  // Subtle mobile hotline visibility after scrolling past header/filters
  const floatWrap = document.querySelector('.floating-actions');
  if (floatWrap) {
    const syncFloatScroll = () => {
      floatWrap.classList.toggle('is-scrolled', window.scrollY > 180);
    };
    syncFloatScroll();
    window.addEventListener('scroll', syncFloatScroll, { passive: true });
  }
});

// Load Public Config
async function loadConfig() {
  try {
    const res = await fetch(api('/api/config'));
    if (!res.ok) return;
    const data = await res.json();
    if (data.success && data.announcement) {
      const marquee = document.querySelector('.flash-marquee');
      if (marquee && data.announcement.headline) {
        const headline = data.announcement.headline.trim();
        const subtext = data.announcement.subtext ? data.announcement.subtext.trim() : '';
        marquee.textContent = subtext ? `${headline} • ${subtext}` : headline;
      }
    }
  } catch {}
}

// Capture Referral Code from URL (?ref=SB1234ABC)
function captureReferralCode() {
  const urlParams = new URLSearchParams(window.location.search);
  const ref = urlParams.get('ref') || urlParams.get('referral');
  if (ref) {
    localStorage.setItem('sb_ref_code', ref.trim().toUpperCase());
    showToast(`🎉 রেফারেল কোড (${ref.trim().toUpperCase()}) অ্যাক্টিভ হয়েছে!`);
  }
}

// Header & Nav Auth UI
function updateAuthUI() {
  const navText = document.getElementById('navResellerText');
  const hasResellerPermission = typeof hasResellerAccess === 'function' && hasResellerAccess();
  if (navText) {
    navText.textContent = hasResellerPermission && currentUser
      ? `${currentUser.name.split(' ')[0]} • রিসেলার`
      : currentUser
        ? currentUser.name.split(' ')[0]
        : 'আমার অ্যাকাউন্ট';
  }
  const walletTab = document.getElementById('bnavWallet');
  if (walletTab) walletTab.style.display = hasResellerPermission ? '' : 'none';
  document.querySelectorAll('[data-reseller-only]').forEach((element) => {
    element.hidden = !hasResellerPermission;
    element.style.display = hasResellerPermission ? '' : 'none';
  });
  if (!hasResellerPermission) {
    if (typeof currentTab !== 'undefined') currentTab = 'all';
    if (typeof currentSort !== 'undefined' && currentSort === 'commission_desc') currentSort = 'default';
    const sortSelect = document.getElementById('sortSelect');
    if (sortSelect && typeof currentSort !== 'undefined') sortSelect.value = currentSort;
    document.querySelectorAll('.commission-tabs-wrap .tab-btn').forEach((button) => {
      button.classList.toggle('active', button.dataset.tab === 'all');
    });
    if (currentMainTab === 'wallet' && typeof switchMainTab === 'function') switchMainTab('profile');
  }
}

// ================= CART & EXPRESS CHECKOUT =================
function addToCart(productId, selectedColor = '', qty = 1) {
  const item = allProducts.find((p) => p.id === productId);
  if (!item || Number(item.stock) <= 0) return;

  const qtyToAdd = Math.max(1, Math.min(50, Number(qty) || 1));
  const existingIndex = cart.findIndex((c) => c.product.id === productId && c.selected_color === selectedColor);
  if (existingIndex > -1) {
    cart[existingIndex].quantity = Math.min(100, cart[existingIndex].quantity + qtyToAdd);
  } else {
    cart.push({
      product: item,
      quantity: qtyToAdd,
      selected_color: selectedColor
    });
  }

  saveCart();
  if (typeof renderProductGrid === 'function' && Array.isArray(allProducts) && allProducts.length > 0) {
    renderProductGrid(allProducts);
  }
  showToast(`✅ "${item.title.substring(0, 22)}..." কার্টে যুক্ত হয়েছে!`);
}

function addToCartFromModal(productId) {
  const colorSelect = document.getElementById('modalColorSelect');
  const selectedColor = colorSelect ? colorSelect.value : '';
  const qtyEl = document.getElementById('modalDetailQty');
  const qty = Math.max(1, Math.min(50, parseInt(qtyEl ? qtyEl.textContent : '1', 10) || 1));
  closeModal('productDetailModal');
  addToCart(productId, selectedColor, qty);
}

function clearCart() {
  cart = [];
  saveCart();
  renderCartModal();
  if (typeof renderProductGrid === 'function' && Array.isArray(allProducts) && allProducts.length > 0) {
    renderProductGrid(allProducts);
  }
  announceStatus('কার্ট খালি করা হয়েছে');
}

function saveCart() {
  localStorage.setItem('sb_cart', JSON.stringify(cart));
  updateCartBadges(true);
}

function updateCartBadges(animate = false) {
  const totalItems = cart.reduce((sum, item) => sum + item.quantity, 0);
  [document.getElementById('cartBadge'), document.getElementById('floatCartBadge')].forEach((badgeEl) => {
    if (!badgeEl) return;
    badgeEl.textContent = totalItems;
    if (animate) {
      badgeEl.classList.remove('is-badge-pop');
      requestAnimationFrame(() => badgeEl.classList.add('is-badge-pop'));
    }
  });
}

function openCartModal() {
  renderCartModal();
  openModal('cartModal');
}

function renderCartModal() {
  const container = document.getElementById('cartItemsContainer');
  const formWrap = document.getElementById('checkoutFormWrap');
  if (!container || !formWrap) return;

  if (cart.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 30px; color: var(--sbf-text-muted);">
        <p style="font-size: 1.1rem; margin-bottom: 8px;">🛒 আপনার কার্ট খালি আছে</p>
        <p style="font-size: 0.85rem; margin-bottom: 14px;">পছন্দের পণ্য দেখে "কার্টে নিন" বাটনে ক্লিক করুন।</p>
        <button type="button" class="btn-secondary-solid" onclick="closeModal('cartModal')">পণ্য ব্রাউজ করুন</button>
      </div>
    `;
    formWrap.style.display = 'none';
    return;
  }

  formWrap.style.display = 'block';
  if (currentUser) {
    const nameInput = document.getElementById('orderCustName');
    const phoneInput = document.getElementById('orderCustPhone');
    if (nameInput && !nameInput.value) nameInput.value = currentUser.name || '';
    if (phoneInput && !phoneInput.value) phoneInput.value = currentUser.phone || '';
  }

  container.innerHTML = `
    ${cart.length > 1 ? `<div class="cart-clear-row"><button type="button" class="btn-text-link" onclick="clearCart()">সব পণ্য সরান</button></div>` : ''}
    ${cart.map((item, index) => {
      const rawUrl = typeof window.sbSafeImageUrl === 'function' ? window.sbSafeImageUrl(item.product.image_url) : item.product.image_url;
      const corsAttr = typeof window.sbImageCrossOriginAttr === 'function' ? window.sbImageCrossOriginAttr(rawUrl) : '';
      return `
        <div class="cart-item-card">
          <img src="${escapeAppHtml(rawUrl)}" ${corsAttr} alt="" class="cart-item-thumb" width="52" height="52" loading="lazy" onerror="window.sbHandleImageError && window.sbHandleImageError(this)">
          <div style="flex: 1; min-width: 0;">
            <div class="cart-item-title">${escapeAppHtml(item.product.title)}</div>
            <div class="cart-item-sku">
              SKU: ${escapeAppHtml(item.product.sku)} ${item.selected_color ? `• কালার: ${escapeAppHtml(item.selected_color)}` : ''}
            </div>
            <div class="cart-item-price">
              ${escapeAppHtml(item.product.regular_price)} ৳ × ${escapeAppHtml(item.quantity)} = ${escapeAppHtml(item.product.regular_price * item.quantity)} ৳
            </div>
          </div>
          <div class="cart-qty-controls">
            <button type="button" class="btn-nav" style="min-height: 36px; padding: 4px 10px;" onclick="changeCartQty(${index}, -1)" aria-label="পরিমাণ কমান">−</button>
            <span class="cart-qty-val">${item.quantity}</span>
            <button type="button" class="btn-nav" style="min-height: 36px; padding: 4px 10px;" onclick="changeCartQty(${index}, 1)" aria-label="পরিমাণ বাড়ান">+</button>
            <button type="button" class="btn-nav" style="min-height: 36px; padding: 4px 9px; color: var(--brand-danger);" onclick="removeCartItem(${index})" aria-label="মুছে ফেলুন">🗑️</button>
          </div>
        </div>
      `;
    }).join('')}
  `;

  calculateCartTotals();
  if (typeof window.loadReferralCreditForCheckout === 'function') window.loadReferralCreditForCheckout();
}

function changeCartQty(index, delta) {
  if (!cart[index]) return;
  if (delta > 0 && cart[index].quantity >= 100) {
    showToast('একটি পণ্যের সর্বোচ্চ অর্ডার ১০০টি');
    return;
  }
  cart[index].quantity += delta;
  if (cart[index].quantity <= 0) cart.splice(index, 1);
  saveCart();
  renderCartModal();
  if (typeof renderProductGrid === 'function' && Array.isArray(allProducts) && allProducts.length > 0) {
    renderProductGrid(allProducts);
  }
}

function removeCartItem(index) {
  cart.splice(index, 1);
  saveCart();
  renderCartModal();
  if (typeof renderProductGrid === 'function' && Array.isArray(allProducts) && allProducts.length > 0) {
    renderProductGrid(allProducts);
  }
}

function calculateCartTotals() {
  const subtotal = cart.reduce((sum, item) => sum + (item.product.regular_price * item.quantity), 0);
  const hasFurniture = cart.some((item) => item.product.brand === 'SB Furniture');
  const cityEl = document.getElementById('orderDeliveryCity');
  const city = cityEl ? cityEl.value : 'inside_dhaka';

  const deliveryFee = hasFurniture
    ? (city === 'inside_dhaka' ? 500 : 1000)
    : (city === 'inside_dhaka' ? 80 : 150);

  const wantsReferralCredit = Boolean(document.getElementById('useReferralCredit')?.checked);
  const availableCredit = Number(window.referralCreditAvailable || 0);
  const discount = wantsReferralCredit ? Math.min(availableCredit, subtotal) : 0;
  const grandTotal = subtotal + deliveryFee - discount;

  const advancePanel = document.getElementById('advanceProtection');
  if (advancePanel) advancePanel.style.display = 'block';

  document.getElementById('cartSubtotal').textContent = `${subtotal} ৳`;
  document.getElementById('cartDeliveryFee').textContent = `${deliveryFee} ৳`;
  const discountRow = document.getElementById('cartReferralDiscountRow');
  const discountLabel = document.getElementById('cartReferralDiscount');
  if (discountRow && discountLabel) {
    discountRow.style.display = discount > 0 ? 'flex' : 'none';
    discountLabel.textContent = `-${discount} ৳`;
  }
  document.getElementById('cartGrandTotal').textContent = `${grandTotal} ৳`;

  const submitBtn = document.getElementById('checkoutSubmitBtn');
  if (submitBtn && !submitBtn.disabled) {
    submitBtn.textContent = `অর্ডার নিশ্চিত করুন — সর্বমোট ${grandTotal} ৳`;
  }
}

function initCheckoutForm() {
  const form = document.getElementById('checkoutForm');
  const phoneInput = document.getElementById('orderCustPhone');
  if (phoneInput && !phoneInput._refSyncBound) {
    phoneInput._refSyncBound = true;
    phoneInput.addEventListener('input', () => {
      if (typeof window.syncReferralCreditCheckout === 'function') window.syncReferralCreditCheckout();
    });
  }
  if (!form || form._bound) return;
  form._bound = true;

  bindFormFieldValidation(form, {
    orderCustName: (v) => (v.trim().length >= 2 ? '' : 'অনুগ্রহ করে আপনার পূর্ণ নাম দিন'),
    orderCustPhone: (v) => (isValidBdPhone(v) ? '' : 'সঠিক ১১ ডিজিটের বাংলাদেশি মোবাইল নম্বর দিন (যেমন 01XXXXXXXXX)'),
    orderCustAddress: (v) => (v.trim().length >= 5 ? '' : 'সম্পূর্ণ ডেলিভারি ঠিকানা দিন')
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitOrder();
  });
}

function showOrderSuccessInTracking(order, phone) {
  const banner = document.getElementById('orderConfirmedBanner');
  if (banner && order) {
    const discNote = Number(order.discount_amount) > 0 ? ` · রেফারেল ছাড়: ${escapeAppHtml(order.discount_amount)} ৳` : '';
    banner.innerHTML = `
      <strong>🎉 ধন্যবাদ! আপনার অর্ডার সফলভাবে গ্রহণ করা হয়েছে।</strong><br>
      অর্ডার নম্বর: <strong>#${escapeAppHtml(order.order_number)}</strong>${discNote}<br>
      আমাদের টিম দ্রুত যোগাযোগ করে ডেলিভারি কনফার্ম করবে।
    `;
    banner.hidden = false;
  }
  trackSpecificOrder(order.order_number, phone, true);
}
window.showOrderSuccessInTracking = showOrderSuccessInTracking;

// Anti-Fraud Order Submission (inline accessible validation, zero alert())
async function submitOrder() {
  const form = document.getElementById('checkoutForm');
  if (form) form.dataset.submitted = 'true';
  setFormAlertError('checkoutSubmitError', '');

  const custName = document.getElementById('orderCustName').value.trim();
  const custPhone = document.getElementById('orderCustPhone').value.trim();
  const custAddress = document.getElementById('orderCustAddress').value.trim();
  const deliveryCity = document.getElementById('orderDeliveryCity').value;
  const trxId = document.getElementById('orderTrxId').value.trim();
  const advancePaid = parseFloat(document.getElementById('orderAdvancePaid').value) || 0;

  const isValid = validateFields([
    ['orderCustName', custName.length >= 2 ? '' : 'অনুগ্রহ করে আপনার পূর্ণ নাম দিন'],
    ['orderCustPhone', isValidBdPhone(custPhone) ? '' : 'সঠিক ১১ ডিজিটের বাংলাদেশি মোবাইল নম্বর দিন'],
    ['orderCustAddress', custAddress.length >= 5 ? '' : 'সম্পূর্ণ ডেলিভারি ঠিকানা দিন']
  ]);
  if (!isValid) return;

  const refCode = localStorage.getItem('sb_ref_code') || (currentUser ? currentUser.referral_code : '');
  const payload = {
    items: cart.map((c) => ({
      product_id: c.product.id,
      quantity: c.quantity,
      selected_color: c.selected_color
    })),
    customer_name: custName,
    customer_phone: custPhone,
    delivery_address: custAddress,
    delivery_city: deliveryCity,
    advance_paid: advancePaid,
    advance_trx_id: trxId,
    referral_code: refCode,
    use_referral_credit: Boolean(document.getElementById('useReferralCredit')?.checked)
  };

  const submitBtn = document.getElementById('checkoutSubmitBtn');
  const originalText = submitBtn ? submitBtn.textContent : 'অর্ডার নিশ্চিত করুন';
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="spinner"></span> অর্ডার প্রসেস হচ্ছে...';
  }

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

    const res = await fetch(api('/api/orders'), {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (data.success && data.order) {
      cart = [];
      saveCart();
      if (typeof renderProductGrid === 'function' && Array.isArray(allProducts) && allProducts.length > 0) {
        renderProductGrid(allProducts);
      }
      const creditCheckbox = document.getElementById('useReferralCredit');
      if (creditCheckbox) creditCheckbox.checked = false;
      if (Number(data.order.discount_amount) > 0) {
        window.referralCreditAvailable = Math.max(0, Number(window.referralCreditAvailable || 0) - Number(data.order.discount_amount));
      }
      closeModal('cartModal');
      showOrderSuccessInTracking(data.order, custPhone);
    } else {
      setFormAlertError('checkoutSubmitError', data.message || 'অর্ডার গ্রহণ করা যায়নি, তথ্য যাচাই করুন।');
    }
  } catch (err) {
    console.error(err);
    setFormAlertError('checkoutSubmitError', 'অর্ডার সাবমিট করতে সমস্যা হয়েছে, ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = originalText;
      calculateCartTotals();
    }
  }
}

// ================= RESELLER PORTAL & ACCOUNT MODAL =================
function openResellerModal() {
  if (currentUser && ['reseller', 'admin'].includes(currentUser.role)) {
    renderResellerDashboard();
  } else if (currentUser && currentUser.role === 'customer') {
    renderCustomerAccount();
  } else {
    renderResellerAuthForms();
  }
  openModal('resellerModal');
}

function openResellerSignup() {
  if (currentUser) {
    openResellerModal();
    return;
  }
  renderResellerAuthForms();
  openModal('resellerModal');
  switchResellerTab('register');
}

function renderResellerAuthForms() {
  document.getElementById('resellerModalTitle').textContent = '👤 অ্যাকাউন্ট লগইন ও রেজিস্ট্রেশন';
  const storedRef = localStorage.getItem('sb_ref_code') || '';
  document.getElementById('resellerModalBody').innerHTML = `
    <div class="reseller-auth-intro">
      <h2>পণ্য কিনতে বা ট্র্যাক করতে অ্যাকাউন্ট ব্যবহার করুন</h2>
      <p>রিসেল করার অনুমতি অ্যাডমিন দেবেন। অনুমোদনের পরেই কমিশন ও রিসেলার টুল দেখা যাবে।</p>
    </div>
    <div class="reseller-auth-tabs" role="tablist" aria-label="অ্যাকাউন্ট লগইন বা নতুন রেজিস্ট্রেশন">
      <button type="button" class="tab-btn active" id="btnShowLogin" role="tab" aria-selected="true" onclick="switchResellerTab('login')">লগইন</button>
      <button type="button" class="tab-btn" id="btnShowRegister" role="tab" aria-selected="false" onclick="switchResellerTab('register')">নতুন অ্যাকাউন্ট খুলুন</button>
    </div>
    <form id="resellerLoginForm" class="reseller-auth-form" role="tabpanel" aria-labelledby="btnShowLogin" novalidate>
      <div class="form-group">
        <label class="form-label" for="resellerLoginPhone">মোবাইল নম্বর <span aria-hidden="true">*</span></label>
        <input type="tel" id="resellerLoginPhone" name="phone" class="form-control" inputmode="tel" autocomplete="tel" enterkeyhint="next" placeholder="01XXXXXXXXX" required>
        <p class="field-error" id="resellerLoginPhoneError" role="alert" hidden></p>
      </div>
      <div class="form-group">
        <label class="form-label" for="resellerLoginPassword">পাসওয়ার্ড <span aria-hidden="true">*</span></label>
        <div class="password-input-wrap">
          <input type="password" id="resellerLoginPassword" name="password" class="form-control" autocomplete="current-password" enterkeyhint="done" placeholder="আপনার পাসওয়ার্ড" required>
          <button type="button" class="btn-toggle-pass" data-target="resellerLoginPassword" aria-pressed="false" aria-label="পাসওয়ার্ড দেখুন">দেখুন</button>
        </div>
        <p class="field-error" id="resellerLoginPasswordError" role="alert" hidden></p>
      </div>
      <div class="form-alert-error" id="resellerLoginAlert" role="alert" hidden></div>
      <button type="submit" class="btn-submit">লগইন করুন</button>
    </form>
    <form id="resellerRegisterForm" class="reseller-auth-form" role="tabpanel" aria-labelledby="btnShowRegister" novalidate hidden>
      <div class="form-group">
        <label class="form-label" for="regName">আপনার পূর্ণ নাম <span aria-hidden="true">*</span></label>
        <input type="text" id="regName" name="name" class="form-control" autocomplete="name" enterkeyhint="next" maxlength="100" placeholder="আপনার নাম" required>
        <p class="field-error" id="regNameError" role="alert" hidden></p>
      </div>
      <div class="form-group">
        <label class="form-label" for="regPhone">মোবাইল নম্বর <span aria-hidden="true">*</span></label>
        <input type="tel" id="regPhone" name="phone" class="form-control" inputmode="tel" autocomplete="tel" enterkeyhint="next" placeholder="01XXXXXXXXX" required>
        <p class="field-error" id="regPhoneError" role="alert" hidden></p>
      </div>
      <div class="form-group">
        <label class="form-label" for="regPassword">পাসওয়ার্ড (কমপক্ষে ৮ অক্ষর) <span aria-hidden="true">*</span></label>
        <div class="password-input-wrap">
          <input type="password" id="regPassword" name="password" class="form-control" autocomplete="new-password" minlength="8" enterkeyhint="next" placeholder="নতুন পাসওয়ার্ড তৈরি করুন" required>
          <button type="button" class="btn-toggle-pass" data-target="regPassword" aria-pressed="false" aria-label="পাসওয়ার্ড দেখুন">দেখুন</button>
        </div>
        <p class="field-error" id="regPasswordError" role="alert" hidden></p>
      </div>
      <div class="form-group">
        <label class="form-label" for="regRefCode">রেফারেল কোড <span>(ঐচ্ছিক)</span></label>
        <input type="text" id="regRefCode" name="referral_code" class="form-control" autocomplete="off" autocorrect="off" autocapitalize="characters" spellcheck="false" value="${escapeAppHtml(storedRef)}" placeholder="কোড থাকলে লিখুন">
      </div>
      <div class="form-alert-error" id="resellerRegAlert" role="alert" hidden></div>
      <button type="submit" class="btn-submit">রেজিস্ট্রেশন সম্পন্ন করুন</button>
    </form>
  `;

  const loginForm = document.getElementById('resellerLoginForm');
  const regForm = document.getElementById('resellerRegisterForm');
  attachPasswordToggles(document.getElementById('resellerModalBody'));
  if (loginForm) {
    bindFormFieldValidation(loginForm, {
      resellerLoginPhone: (v) => (v.trim() ? '' : 'মোবাইল নম্বর দিন'),
      resellerLoginPassword: (v) => (v ? '' : 'পাসওয়ার্ড দিন')
    });
    loginForm.addEventListener('submit', (e) => { e.preventDefault(); submitResellerLogin(); });
  }
  if (regForm) {
    bindFormFieldValidation(regForm, {
      regName: (v) => (v.trim().length >= 2 ? '' : 'সঠিক পূর্ণ নাম দিন (২ থেকে ১০০ অক্ষর)'),
      regPhone: (v) => (isValidBdPhone(v) ? '' : 'সঠিক ১১ ডিজিটের বাংলাদেশি মোবাইল নম্বর দিন'),
      regPassword: (v) => (new TextEncoder().encode(v).length >= 8 ? '' : 'পাসওয়ার্ড কমপক্ষে ৮ অক্ষর হতে হবে')
    });
    regForm.addEventListener('submit', (e) => { e.preventDefault(); submitResellerRegister(); });
  }
}

function renderCustomerAccount() {
  document.getElementById('resellerModalTitle').textContent = '👤 আমার কাস্টমার অ্যাকাউন্ট';
  document.getElementById('resellerModalBody').innerHTML = `
    <div class="customer-account-box">
      <h2 style="margin:0 0 6px; font-size: 1.08rem;">স্বাগতম, ${escapeAppHtml(currentUser.name)}!</h2>
      <p style="margin:0 0 10px; font-size:.9rem; color: var(--text-secondary);">এই অ্যাকাউন্টে আপনি পণ্য কিনতে ও অর্ডার ট্র্যাক করতে পারবেন। রিসেলার হতে অ্যাডমিনের অনুমতি লাগবে।</p>
      <div style="font-size:.85rem; color: var(--text-muted);">অ্যাকাউন্ট ধরন: কাস্টমার</div>
      <div id="customerReferralPanel" style="margin-top:14px;"></div>
      <div style="display:flex; flex-wrap: wrap; gap:8px; margin-top:14px;">
        <button type="button" class="btn-submit" style="flex: 1; min-width: 140px;" onclick="closeModal('resellerModal'); switchMainTab('orders');">আমার অর্ডার</button>
        <button type="button" class="btn-secondary-solid" style="flex: 1; min-width: 120px;" onclick="closeModal('resellerModal'); switchMainTab('shop');">পণ্য দেখুন</button>
        <button type="button" class="btn-nav" onclick="resellerLogout()">লগআউট</button>
      </div>
    </div>
  `;
  if (typeof window.loadMyReferralDashboard === 'function') window.loadMyReferralDashboard('customerReferralPanel');
}

function switchResellerTab(tab) {
  const isLogin = tab === 'login';
  const loginForm = document.getElementById('resellerLoginForm');
  const regForm = document.getElementById('resellerRegisterForm');
  if (loginForm) {
    loginForm.style.display = isLogin ? 'block' : 'none';
    loginForm.hidden = !isLogin;
  }
  if (regForm) {
    regForm.style.display = isLogin ? 'none' : 'block';
    regForm.hidden = isLogin;
  }
  document.getElementById('btnShowLogin')?.setAttribute('aria-selected', String(isLogin));
  document.getElementById('btnShowRegister')?.setAttribute('aria-selected', String(!isLogin));
  document.getElementById('btnShowLogin')?.classList.toggle('active', isLogin);
  document.getElementById('btnShowRegister')?.classList.toggle('active', !isLogin);
}

async function submitResellerLogin() {
  const form = document.getElementById('resellerLoginForm');
  if (form) form.dataset.submitted = 'true';
  setFormAlertError('resellerLoginAlert', '');

  const phone = document.getElementById('resellerLoginPhone').value.trim();
  const password = document.getElementById('resellerLoginPassword').value;
  if (!validateFields([
    ['resellerLoginPhone', phone ? '' : 'ফোন নম্বর দিন'],
    ['resellerLoginPassword', password ? '' : 'পাসওয়ার্ড দিন']
  ])) return;

  try {
    const res = await fetch(api('/api/auth/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, password })
    });
    const data = await res.json();
    if (data.success) {
      authToken = data.token;
      currentUser = data.user;
      localStorage.setItem('sb_token', data.token);
      localStorage.setItem('sb_user', JSON.stringify(data.user));
      updateAuthUI();
      await loadProducts();
      if (['reseller', 'admin'].includes(data.user.role)) renderResellerDashboard();
      else renderCustomerAccount();
      announceStatus(`স্বাগতম, ${data.user.name}`);
    } else {
      setFormAlertError('resellerLoginAlert', data.message || 'লগইন তথ্য সঠিক নয়।');
    }
  } catch (err) {
    console.error(err);
    setFormAlertError('resellerLoginAlert', 'লগইন ব্যর্থ হয়েছে, সার্ভার সংযোগ পরীক্ষা করুন।');
  }
}

async function submitResellerRegister() {
  const form = document.getElementById('resellerRegisterForm');
  if (form) form.dataset.submitted = 'true';
  setFormAlertError('resellerRegAlert', '');

  const name = document.getElementById('regName').value.trim();
  const phone = document.getElementById('regPhone').value.trim();
  const password = document.getElementById('regPassword').value;
  const referral_code = document.getElementById('regRefCode').value.trim();
  const passwordBytes = new TextEncoder().encode(password).length;

  if (!validateFields([
    ['regName', (name.length >= 2 && name.length <= 100) ? '' : 'সঠিক পূর্ণ নাম দিন (২ থেকে ১০০ অক্ষর)'],
    ['regPhone', isValidBdPhone(phone) ? '' : 'সঠিক ১১ ডিজিটের বাংলাদেশি মোবাইল নম্বর দিন'],
    ['regPassword', (passwordBytes >= 8 && passwordBytes <= 72) ? '' : 'পাসওয়ার্ড ৮ থেকে ৭২ বাইটের মধ্যে হতে হবে']
  ])) return;

  try {
    const res = await fetch(api('/api/auth/register'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, phone, password, referral_code })
    });
    const data = await res.json();
    if (data.success) {
      authToken = data.token;
      currentUser = data.user;
      localStorage.setItem('sb_token', data.token);
      localStorage.setItem('sb_user', JSON.stringify(data.user));
      updateAuthUI();
      await loadProducts();
      renderCustomerAccount();
      announceStatus('কাস্টমার অ্যাকাউন্ট তৈরি হয়েছে।');
    } else {
      setFormAlertError('resellerRegAlert', data.message || 'রেজিস্ট্রেশন ব্যর্থ হয়েছে।');
    }
  } catch (err) {
    console.error(err);
    setFormAlertError('resellerRegAlert', 'রেজিস্ট্রেশন ব্যর্থ হয়েছে, আবার চেষ্টা করুন।');
  }
}

// Reseller Dashboard Rendering
async function renderResellerDashboard() {
  if (!currentUser || !['reseller', 'admin'].includes(currentUser.role)) {
    if (currentUser) renderCustomerAccount();
    return;
  }
  document.getElementById('resellerModalTitle').textContent = `💼 ${currentUser.name} — ড্যাশবোর্ড`;
  const body = document.getElementById('resellerModalBody');
  body.innerHTML = '<div class="reseller-loading" role="status">আপনার হিসাব লোড হচ্ছে…</div>';

  try {
    const res = await fetch(api('/api/wallet/summary'), {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const data = await res.json();

    if (!data.success) {
      body.innerHTML = `<div class="reseller-state reseller-state-error" role="alert">${escapeAppHtml(data.message)}</div>`;
      return;
    }

    const s = data.summary;
    const refLink = `${window.location.origin}/?ref=${s.referral_code}`;

    body.innerHTML = `
      <div class="reseller-dashboard">
      <section class="referral-share-box">
        <div class="reseller-section-heading">
          <div><span class="reseller-kicker">রিসেলার লিংক</span><h2>পণ্য শেয়ার করে বিক্রি শুরু করুন</h2></div>
          <span class="reseller-link-icon" aria-hidden="true">↗</span>
        </div>
        <p class="reseller-help-text">এই লিংক দিয়ে আসা অর্ডার সফলভাবে ডেলিভারি হলে সংশ্লিষ্ট পণ্যের কমিশন আপনার হিসাবে যোগ হবে।</p>
        <div class="ref-link-row">
          <input type="text" readonly value="${escapeAppHtml(refLink)}" class="ref-link-input" id="myRefLinkInput" aria-label="আপনার রিসেলার লিংক">
          <button type="button" class="btn-copy-link" onclick="copyReferralLink(this)">লিংক কপি</button>
        </div>
        <div class="reseller-code-line">শেয়ার কোড <strong>${escapeAppHtml(s.referral_code)}</strong></div>
      </section>
      <div id="resellerReferralPanel"></div>
      <section class="reseller-wallet-section" aria-labelledby="resellerWalletHeading">
        <div class="reseller-section-heading">
          <div><span class="reseller-kicker">আপনার হিসাব</span><h2 id="resellerWalletHeading">কমিশন ও ব্যালেন্স</h2></div>
        </div>
        <div class="wallet-cards-grid">
          <div class="wallet-stat-card wallet-stat-available"><div class="wallet-stat-title">উত্তোলনযোগ্য</div><div class="wallet-stat-amount green">${escapeAppHtml(s.available_balance)} ৳</div></div>
          <div class="wallet-stat-card"><div class="wallet-stat-title">ডেলিভারি অপেক্ষায়</div><div class="wallet-stat-amount">${escapeAppHtml(s.pending_commission)} ৳</div></div>
          <div class="wallet-stat-card"><div class="wallet-stat-title">মোট কমিশন পেয়েছেন</div><div class="wallet-stat-amount">${escapeAppHtml(s.total_earned)} ৳</div></div>
          <div class="wallet-stat-card"><div class="wallet-stat-title">মোট উত্তোলন</div><div class="wallet-stat-amount">${escapeAppHtml(s.total_withdrawn)} ৳</div></div>
        </div>
      </section>
      <details class="reseller-payout-panel">
        <summary><span><strong>টাকা তোলার অনুরোধ</strong><small>ন্যূনতম ${escapeAppHtml(s.min_cashout)} ৳</small></span><span aria-hidden="true">＋</span></summary>
        <form id="modalPayoutForm" class="reseller-payout-form" novalidate>
          <div class="payout-form-row">
            <div class="form-group">
              <label class="form-label" for="payoutAmount">টাকার পরিমাণ</label>
              <input type="number" id="payoutAmount" name="amount" class="form-control" min="${escapeAppHtml(s.min_cashout)}" inputmode="numeric" placeholder="যেমন ৫০০" required>
              <p class="field-error" id="payoutAmountError" role="alert" hidden></p>
            </div>
            <div class="form-group">
              <label class="form-label" for="payoutMethod">পেমেন্ট মাধ্যম</label>
              <select id="payoutMethod" name="payment_method" class="form-control"><option value="bkash">বিকাশ</option><option value="nagad">নগদ</option><option value="rocket">রকেট</option></select>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label" for="payoutAccount">যে মোবাইল নম্বরে টাকা নেবেন</label>
            <input type="tel" id="payoutAccount" name="account_number" class="form-control" inputmode="tel" autocomplete="tel" placeholder="01XXXXXXXXX" required>
            <p class="field-error" id="payoutAccountError" role="alert" hidden></p>
          </div>
          <div class="form-alert-error" id="modalPayoutAlert" role="alert" hidden></div>
          <button type="submit" class="btn-submit">ক্যাশআউট রিকোয়েস্ট পাঠান</button>
        </form>
      </details>
      <nav class="reseller-tools" aria-label="রিসেলার টুলস">
        <button type="button" class="reseller-tool-button" onclick="showMyOrders()"><span aria-hidden="true">▤</span>আমার বিক্রি</button>
        <button type="button" class="reseller-tool-button" onclick="showResellerNotifications()"><span aria-hidden="true">♢</span>নোটিশ <span id="resellerNotifBadge" class="badge" style="display:none;">0</span></button>
        <button type="button" class="reseller-tool-button" onclick="showChangePasswordForm()"><span aria-hidden="true">⌑</span>পাসওয়ার্ড</button>
        <button type="button" class="reseller-tool-button reseller-tool-logout" onclick="resellerLogout()"><span aria-hidden="true">↪</span>লগআউট</button>
      </nav>
      <section id="resellerSubContent" class="reseller-subcontent" aria-live="polite"></section>
      </div>
    `;
    const payoutForm = document.getElementById('modalPayoutForm');
    if (payoutForm) {
      payoutForm.addEventListener('submit', (e) => { e.preventDefault(); requestPayout(); });
    }
    if (typeof window.loadMyReferralDashboard === 'function') window.loadMyReferralDashboard('resellerReferralPanel');
    fetch(api('/api/auth/notifications'), { headers: { Authorization: `Bearer ${authToken}` } })
      .then(r => r.json())
      .then(d => { if (d.success && d.unread_count) updateNotificationBadge(d.unread_count); })
      .catch(() => {});
  } catch (err) {
    console.error(err);
    body.innerHTML = '<div class="reseller-state reseller-state-error" role="alert">হিসাব লোড করা যায়নি। ইন্টারনেট দেখে আবার চেষ্টা করুন।</div>';
  }
}

async function copyReferralLink(btnEl = null) {
  const linkInput = document.getElementById('myRefLinkInput');
  if (!linkInput) return;
  try {
    await navigator.clipboard.writeText(linkInput.value);
  } catch {}
  announceStatus('রেফারেল লিংক কপি হয়েছে');
  if (btnEl) {
    const orig = btnEl.textContent;
    btnEl.textContent = '✓ কপি হয়েছে';
    setTimeout(() => { btnEl.textContent = orig; }, 1800);
  }
}

async function requestPayout() {
  const form = document.getElementById('modalPayoutForm');
  if (form) form.dataset.submitted = 'true';
  setFormAlertError('modalPayoutAlert', '');

  const amount = parseFloat(document.getElementById('payoutAmount').value);
  const payment_method = document.getElementById('payoutMethod').value;
  const account_number = document.getElementById('payoutAccount').value.trim();

  if (!validateFields([
    ['payoutAmount', (!isNaN(amount) && amount >= 100) ? '' : 'ন্যূনতম ক্যাশআউট ১০০ টাকা'],
    ['payoutAccount', isValidBdPhone(account_number) ? '' : 'সঠিক ১১ ডিজিটের মোবাইল নম্বর দিন']
  ])) return;

  try {
    const res = await fetch(api('/api/wallet/payout-request'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({ amount, payment_method, account_number })
    });
    const data = await res.json();
    if (data.success) {
      announceStatus(data.message || 'ক্যাশআউট অনুরোধ পাঠানো হয়েছে');
      renderResellerDashboard();
    } else {
      setFormAlertError('modalPayoutAlert', data.message || 'রিকোয়েস্ট ব্যর্থ হয়েছে');
    }
  } catch (err) {
    console.error(err);
    setFormAlertError('modalPayoutAlert', 'ক্যাশআউট রিকোয়েস্ট পাঠাতে ব্যর্থ হয়েছে');
  }
}

async function showMyOrders() {
  const subContent = document.getElementById('resellerSubContent');
  subContent.innerHTML = '<div class="reseller-loading" role="status">বিক্রির তালিকা লোড হচ্ছে…</div>';

  try {
    const res = await fetch(api('/api/orders/reseller-sales'), {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const data = await res.json();

    if (!data.success || data.orders.length === 0) {
      subContent.innerHTML = '<div class="reseller-state">এখনও আপনার শেয়ার থেকে কোনো অর্ডার আসেনি। পণ্য দেখুন এবং লিংক শেয়ার করুন।</div>';
      return;
    }

    subContent.innerHTML = `
      <h3 class="reseller-subheading">আপনার শেয়ার থেকে আসা বিক্রি</h3>
      ${data.orders.map((o) => `
        <article class="reseller-order-card">
          <div class="reseller-order-heading">
            <strong>#${escapeAppHtml(o.order_number)}</strong>
            <span style="color: ${o.status === 'delivered' ? '#10b981' : '#f59e0b'}; font-weight: 700;">
              ${escapeAppHtml(getStatusInBangla(o.status))}
            </span>
          </div>
          <div class="reseller-order-customer">ক্রেতা: ${escapeAppHtml(o.customer_name)}</div>
          ${(o.items && o.items.length) ? `<div class="reseller-order-items">${o.items.map(it => `${escapeAppHtml(it.title)} × ${escapeAppHtml(it.quantity)}`).join(', ')}</div>` : ''}
          <div class="reseller-order-totals">
            <span>অর্ডার: ${escapeAppHtml(o.total_amount)}৳</span>
            <span>কমিশন: ${escapeAppHtml(o.reseller_commission || 0)}৳</span>
          </div>
        </article>
      `).join('')}
    `;
  } catch (err) {
    console.error(err);
    subContent.innerHTML = '<div style="color: var(--sbp-red); font-size: 0.85rem;">লোড ব্যর্থ হয়েছে</div>';
  }
}

function showChangePasswordForm() {
  const subContent = document.getElementById('resellerSubContent');
  subContent.innerHTML = `
    <form id="modalChangePassForm" class="reseller-password-panel" novalidate>
      <h3 class="reseller-subheading">পাসওয়ার্ড পরিবর্তন</h3>
      <div class="form-group">
        <label class="form-label" for="oldPassInput">বর্তমান পাসওয়ার্ড</label>
        <div class="password-input-wrap">
          <input type="password" id="oldPassInput" name="old_password" class="form-control" autocomplete="current-password" placeholder="বর্তমান পাসওয়ার্ড" required>
          <button type="button" class="btn-toggle-pass" data-target="oldPassInput" aria-pressed="false" aria-label="পাসওয়ার্ড দেখুন">দেখুন</button>
        </div>
        <p class="field-error" id="oldPassInputError" role="alert" hidden></p>
      </div>
      <div class="form-group">
        <label class="form-label" for="newPassInput">নতুন পাসওয়ার্ড (কমপক্ষে ৮ অক্ষর)</label>
        <div class="password-input-wrap">
          <input type="password" id="newPassInput" name="new_password" class="form-control" autocomplete="new-password" minlength="8" placeholder="নতুন পাসওয়ার্ড" required>
          <button type="button" class="btn-toggle-pass" data-target="newPassInput" aria-pressed="false" aria-label="পাসওয়ার্ড দেখুন">দেখুন</button>
        </div>
        <p class="field-error" id="newPassInputError" role="alert" hidden></p>
      </div>
      <div class="form-alert-error" id="modalChangePassAlert" role="alert" hidden></div>
      <button type="submit" class="btn-submit">পাসওয়ার্ড পরিবর্তন করুন</button>
    </form>
  `;
  attachPasswordToggles(subContent);
  document.getElementById('modalChangePassForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    submitChangePassword();
  });
}

async function submitChangePassword() {
  setFormAlertError('modalChangePassAlert', '');
  const old_password = document.getElementById('oldPassInput').value;
  const new_password = document.getElementById('newPassInput').value;
  const newPasswordBytes = new TextEncoder().encode(new_password).length;

  if (!validateFields([
    ['oldPassInput', old_password ? '' : 'বর্তমান পাসওয়ার্ড দিন'],
    ['newPassInput', (newPasswordBytes >= 8 && newPasswordBytes <= 72) ? '' : 'নতুন পাসওয়ার্ড ৮ থেকে ৭২ বাইটের মধ্যে হতে হবে']
  ])) return;

  try {
    const res = await fetch(api('/api/auth/change-password'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({ old_password, new_password })
    });
    const data = await res.json();
    if (data.success) {
      if (data.token) {
        authToken = data.token;
        localStorage.setItem('sb_token', data.token);
      }
      announceStatus(data.message || 'পাসওয়ার্ড পরিবর্তিত হয়েছে');
      showMyOrders();
    } else {
      setFormAlertError('modalChangePassAlert', data.message || 'পাসওয়ার্ড পরিবর্তন ব্যর্থ হয়েছে');
    }
  } catch (err) {
    setFormAlertError('modalChangePassAlert', 'পাসওয়ার্ড পরিবর্তনে সমস্যা হয়েছে');
  }
}

function resellerLogout() {
  currentUser = null;
  authToken = null;
  catalogResellerAccess = false;
  localStorage.removeItem('sb_user');
  localStorage.removeItem('sb_token');
  updateAuthUI();
  loadProducts();
  if (currentMainTab === 'wallet') switchMainTab('profile');
  if (document.getElementById('resellerModal')?.open) renderResellerAuthForms();
  if (currentMainTab === 'profile') loadProfileView();
  showToast('লগআউট সম্পন্ন হয়েছে');
}

// ================= NOTIFICATIONS & CUSTOMER HISTORY =================
async function showResellerNotifications() {
  const subContent = document.getElementById('resellerSubContent');
  subContent.innerHTML = '<div class="reseller-loading" role="status">নোটিশ লোড হচ্ছে…</div>';
  try {
    const res = await fetch(api('/api/auth/notifications'), { headers: { Authorization: `Bearer ${authToken}` } });
    const data = await res.json();
    if (!data.success || !data.notifications || data.notifications.length === 0) {
      subContent.innerHTML = '<div class="reseller-state">এখন কোনো নোটিশ নেই।</div>';
      return;
    }
    const unread = data.unread_count || 0;
    subContent.innerHTML = `
      <div class="reseller-notice-list-heading">
        <h3 class="reseller-subheading">নোটিশ (${data.notifications.length})</h3>
        ${unread > 0 ? `<button type="button" class="btn-nav" onclick="markAllNotificationsRead()">সব পঠিত করুন</button>` : ''}
      </div>
      ${data.notifications.map((n) => `
        <button type="button" class="reseller-notice-card ${n.is_read ? 'is-read' : 'is-unread'}" onclick="markNotificationRead(${n.id}, this)">
          <span class="reseller-notice-heading"><strong>${escapeAppHtml(n.title)}</strong><time datetime="${escapeAppHtml(n.created_at)}">${new Date(n.created_at).toLocaleDateString('bn-BD')}</time></span>
          <span class="reseller-notice-message">${escapeAppHtml(n.message)}</span>
        </button>
      `).join('')}
    `;
    updateNotificationBadge(unread);
  } catch (e) {
    subContent.innerHTML = '<div class="reseller-state reseller-state-error" role="alert">নোটিশ লোড করা যায়নি। আবার চেষ্টা করুন।</div>';
  }
}

async function markNotificationRead(id, el) {
  try {
    await fetch(api(`/api/auth/notifications/${id}/read`), { method: 'PUT', headers: { Authorization: `Bearer ${authToken}` } });
    if (el) { el.classList.remove('is-unread'); el.classList.add('is-read'); }
  } catch {}
}

async function markAllNotificationsRead() {
  try {
    await fetch(api('/api/auth/notifications/read-all'), { method: 'PUT', headers: { Authorization: `Bearer ${authToken}` } });
    showResellerNotifications();
  } catch {}
}

function updateNotificationBadge(count) {
  const badge = document.getElementById('resellerNotifBadge');
  if (badge) {
    badge.textContent = count;
    badge.style.display = count > 0 ? 'inline-block' : 'none';
  }
}

async function loadCustomerOrderHistory() {
  const resultDiv = document.getElementById('trackOrderResult');
  if (!authToken) {
    resultDiv.innerHTML = '<div style="text-align:center; padding:14px;">নিজের অর্ডার ইতিহাস দেখতে আগে লগইন করুন।</div>';
    closeModal('trackModal');
    openResellerModal();
    return;
  }
  resultDiv.innerHTML = '<div style="text-align: center;"><span class="spinner"></span> আপনার সকল অর্ডার লোড হচ্ছে...</div>';
  try {
    const res = await fetch(api('/api/orders/my-orders'), {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const data = await res.json();
    if (!data.success || !data.orders || data.orders.length === 0) {
      resultDiv.innerHTML = '<div style="color: var(--sbf-text-muted); text-align: center; padding: 14px;">আপনার কোনো পূর্ববর্তী অর্ডার নেই।</div>';
      return;
    }
    window._lastTrackOrders = data.orders;
    resultDiv.innerHTML = `
      <div style="font-size: 0.88rem; color: var(--text-primary); font-weight: 600; margin-bottom: 8px;">আপনার মোট ${data.orders.length}টি অর্ডার পাওয়া গেছে:</div>
      ${data.orders.map((o) => `
        <button type="button" class="track-order-list-item" style="inline-size: 100%; text-align: start;" onclick="renderSingleOrderTrackingFromData(${o.id})">
          <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px;">
            <strong>#${escapeAppHtml(o.order_number)}</strong>
            <span style="color: ${getStatusBadgeBg(o.status)}; font-weight: 700; font-size: 0.8rem;">${escapeAppHtml(getStatusInBangla(o.status))}</span>
          </div>
          <div style="font-size: 0.78rem; color: var(--text-muted); margin-top: 4px;">মোট: ${escapeAppHtml(o.total_amount)}৳ • তারিখ: ${new Date(o.created_at).toLocaleDateString('bn-BD')}</div>
        </button>
      `).join('')}
    `;
  } catch (e) {
    resultDiv.innerHTML = '<div style="color: var(--sbp-red); text-align: center;">অর্ডার হিস্ট্রি লোড ব্যর্থ হয়েছে।</div>';
  }
}

// ================= ORDER TRACKING & VISUAL TIMELINE =================
function openTrackModal() {
  const banner = document.getElementById('orderConfirmedBanner');
  if (banner) banner.hidden = true;
  openModal('trackModal');
}

function initTrackModalForm() {
  const form = document.getElementById('trackModalForm');
  if (!form || form._bound) return;
  form._bound = true;
  bindFormFieldValidation(form, {
    trackOrderInput: (v) => (v.trim() ? '' : 'অর্ডার নম্বর লিখুন'),
    trackCustomerPhone: (v) => (v.trim() ? '' : 'অর্ডারের সময় দেওয়া মোবাইল নম্বর লিখুন')
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    trackOrder();
  });
}

async function trackOrder() {
  const form = document.getElementById('trackModalForm');
  if (form) form.dataset.submitted = 'true';
  const orderNumber = document.getElementById('trackOrderInput').value.trim();
  const phone = document.getElementById('trackCustomerPhone').value.trim();

  if (!validateFields([
    ['trackOrderInput', orderNumber ? '' : 'অর্ডার নম্বর লিখুন'],
    ['trackCustomerPhone', phone ? '' : 'অর্ডারের সময় দেওয়া মোবাইল নম্বর লিখুন']
  ])) return;

  trackSpecificOrder(orderNumber, phone, false);
}

async function trackSpecificOrder(orderNumber, customerPhone = '', keepConfirmationBanner = false) {
  if (!keepConfirmationBanner) {
    const banner = document.getElementById('orderConfirmedBanner');
    if (banner) banner.hidden = true;
  }
  openModal('trackModal');
  document.getElementById('trackOrderInput').value = orderNumber;
  const phoneInput = document.getElementById('trackCustomerPhone');
  const phone = customerPhone || (phoneInput ? phoneInput.value.trim() : '');
  if (phoneInput && customerPhone) phoneInput.value = customerPhone;
  const resultDiv = document.getElementById('trackOrderResult');
  resultDiv.innerHTML = '<div style="text-align: center; color: var(--sbf-text-muted);"><span class="spinner"></span> অর্ডার খোঁজ করা হচ্ছে...</div>';

  try {
    const res = await fetch(api('/api/orders/track'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order_number: orderNumber, phone })
    });
    const data = await res.json();

    if (!data.success || !data.order) {
      resultDiv.innerHTML = `<div style="color: var(--sbp-red); text-align: center;">${escapeAppHtml(data.message || 'কোনো অর্ডার খুঁজে পাওয়া যায়নি')}</div>`;
      return;
    }
    renderSingleOrderTracking(data.order, resultDiv);
  } catch (err) {
    console.error(err);
    resultDiv.innerHTML = '<div style="color: var(--sbp-red); text-align: center;">অর্ডার ট্র্যাকিং ব্যর্থ হয়েছে।</div>';
  }
}

function renderSingleOrderTrackingFromData(orderId) {
  const o = (window._lastTrackOrders || []).find((x) => x.id === orderId);
  if (o) {
    const resultDiv = document.getElementById('trackOrderResult');
    renderSingleOrderTracking(o, resultDiv);
  }
}

function buildOrderStepperHtml(status) {
  if (status === 'cancelled') {
    return '<div class="form-alert-error" style="margin: 10px 0;">✕ এই অর্ডারটি বাতিল করা হয়েছে।</div>';
  }
  const steps = [
    { key: 'pending', label: '১. অর্ডার গ্রহণ' },
    { key: 'confirmed', label: '২. নিশ্চিত' },
    { key: 'shipped', label: '৩. কুরিয়ারে' },
    { key: 'delivered', label: '৪. ডেলিভারি' }
  ];
  const currentIdx = Math.max(0, steps.findIndex((s) => s.key === status));
  return `
    <div class="order-stepper" aria-label="অর্ডার অগ্রগতি">
      ${steps.map((step, idx) => {
        const cls = idx < currentIdx ? 'is-done' : idx === currentIdx ? 'is-current' : '';
        return `<div class="order-step ${cls}">${step.label}</div>`;
      }).join('')}
    </div>
  `;
}

function renderSingleOrderTracking(o, container) {
  container.innerHTML = `
    <div class="track-order-card">
      <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 6px;">
        <h2 style="color: var(--text-primary); margin: 0; font-size: 1rem;">অর্ডার #${escapeAppHtml(o.order_number)}</h2>
        <span style="background: ${getStatusBadgeBg(o.status)}; color: #fff; padding: 3px 10px; border-radius: 999px; font-size: 0.76rem; font-weight: 700;">
          ${escapeAppHtml(getStatusInBangla(o.status))}
        </span>
      </div>
      ${buildOrderStepperHtml(o.status)}
      <div style="font-size: 0.86rem; line-height: 1.65; color: var(--text-secondary);">
        <div><strong>গ্রাহকের নাম:</strong> ${escapeAppHtml(o.customer_name)}</div>
        <div><strong>মোবাইল:</strong> ${escapeAppHtml(o.customer_phone)}</div>
        <div><strong>ঠিকানা:</strong> ${escapeAppHtml(o.delivery_address)} (${o.delivery_city === 'inside_dhaka' ? 'ঢাকা ভেতরে' : 'ঢাকা বাইরে'})</div>
        <div><strong>সর্বমোট:</strong> ${escapeAppHtml(o.total_amount)} ৳ (অগ্রিম: ${escapeAppHtml(o.advance_paid)} ৳)</div>
        ${o.advance_trx_id ? `<div><strong>অগ্রিম TrxID:</strong> ${escapeAppHtml(o.advance_trx_id)}</div>` : ''}
      </div>
      <div style="margin-top: 12px; border-top: 1px solid var(--border-subtle); padding-top: 10px;">
        <strong style="font-size: 0.84rem; color: var(--text-primary);">পণ্যসমূহ:</strong>
        ${(o.items || []).map((it) => `
          <div style="font-size: 0.82rem; color: var(--text-secondary); display: flex; justify-content: space-between; margin-top: 4px;">
            <span>${escapeAppHtml(it.title)} × ${escapeAppHtml(it.quantity)}</span>
            <span class="tabular" style="font-weight: 600;">${escapeAppHtml(it.total_price)} ৳</span>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

const BANGLA_STATUS_MAP = {
  pending: 'অপেক্ষমান (Pending)',
  confirmed: 'নিশ্চিত করা হয়েছে (Confirmed)',
  shipped: 'কুরিয়ারে পাঠানো হয়েছে (Shipped)',
  delivered: 'ডেলিভারি সম্পন্ন (Delivered)',
  cancelled: 'বাতিল (Cancelled)'
};
const STATUS_BADGE_BG_MAP = {
  pending: '#d97706',
  confirmed: '#2563eb',
  shipped: '#7c3aed',
  delivered: '#059669',
  cancelled: '#dc2626'
};
const getStatusInBangla = (status) => BANGLA_STATUS_MAP[status] || status;
const getStatusBadgeBg = (status) => STATUS_BADGE_BG_MAP[status] || '#44403c';

// ================= NAVIGATION & VIEW SWITCHING =================
let currentMainTab = 'shop';

function switchMainTab(tab) {
  if (tab === 'wallet' && (!currentUser || !hasResellerAccess())) {
    showToast('রিসেলার ওয়ালেট দেখতে অ্যাডমিন অনুমতি প্রয়োজন');
    switchMainTab('profile');
    return;
  }
  currentMainTab = tab;

  const navSets = [
    { shop: document.getElementById('bnavShop'), orders: document.getElementById('bnavOrders'), wallet: document.getElementById('bnavWallet'), profile: document.getElementById('bnavProfile') },
    { shop: document.getElementById('dnavShop'), orders: document.getElementById('dnavOrders'), wallet: document.getElementById('dnavWallet') }
  ];
  navSets.forEach((group) => {
    Object.keys(group).forEach((key) => {
      const btn = group[key];
      if (btn) {
        const isActive = key === tab;
        btn.classList.toggle('active', isActive);
        if (isActive) btn.setAttribute('aria-current', 'page');
        else btn.removeAttribute('aria-current');
      }
    });
  });

  const views = {
    shop: document.getElementById('viewShop'),
    orders: document.getElementById('viewOrders'),
    wallet: document.getElementById('viewWallet'),
    profile: document.getElementById('viewProfile')
  };
  Object.keys(views).forEach((key) => {
    if (views[key]) views[key].classList.toggle('active', key === tab);
  });

  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (tab === 'orders') loadOrdersView();
  else if (tab === 'wallet') loadWalletView();
  else if (tab === 'profile') loadProfileView();
}

// 1. Orders View Loader
async function loadOrdersView() {
  const container = document.getElementById('ordersViewContent');
  if (!container) return;

  if (!currentUser || !authToken) {
    container.innerHTML = `
      <div class="empty-state-card">
        <div class="empty-icon">💼</div>
        <h3>অর্ডারের তালিকা দেখতে লগইন করুন</h3>
        <p>কাস্টমার অ্যাকাউন্টে নিজের অর্ডার, আর অনুমোদিত রিসেলার অ্যাকাউন্টে বিক্রির হিসাব দেখা যাবে।</p>
        <button type="button" class="btn-submit" style="max-width: 240px; margin: 0 auto;" onclick="switchMainTab('profile')">অ্যাকাউন্ট লগইন / তৈরি</button>
      </div>

      <form id="inlineTrackForm" class="surface-card" novalidate>
        <h3 style="color: var(--text-primary); font-size: 1rem; margin-bottom: 12px;">🔍 যেকোনো অর্ডার ট্র্যাক করুন</h3>
        <div class="form-group">
          <label class="form-label" style="font-size: 0.82rem;" for="inlineTrackOrder">অর্ডার নম্বর (যেমন: SB-123456-789) <span aria-hidden="true">*</span></label>
          <input type="text" id="inlineTrackOrder" name="order_number" class="form-control" autocomplete="off" autocapitalize="characters" placeholder="SB-XXXXXX-XXX" required>
          <p class="field-error" id="inlineTrackOrderError" role="alert" hidden></p>
        </div>
        <div class="form-group">
          <label class="form-label" style="font-size: 0.82rem;" for="inlineTrackPhone">অর্ডারে দেওয়া মোবাইল নম্বর <span aria-hidden="true">*</span></label>
          <input type="tel" id="inlineTrackPhone" name="phone" class="form-control" inputmode="tel" autocomplete="tel" placeholder="01XXXXXXXXX" required>
          <p class="field-error" id="inlineTrackPhoneError" role="alert" hidden></p>
        </div>
        <button type="submit" class="btn-submit">অর্ডার ট্র্যাক করুন</button>
        <div id="inlineTrackResult" style="margin-top: 14px;" aria-live="polite"></div>
      </form>
    `;
    const form = document.getElementById('inlineTrackForm');
    if (form) {
      bindFormFieldValidation(form, {
        inlineTrackOrder: (v) => (v.trim() ? '' : 'অর্ডার নম্বর লিখুন'),
        inlineTrackPhone: (v) => (v.trim() ? '' : 'মোবাইল নম্বর দিন')
      });
      form.addEventListener('submit', (e) => { e.preventDefault(); inlineTrackOrderSubmit(); });
    }
    return;
  }

  container.innerHTML = '<div class="reseller-loading"><span class="spinner"></span> আপনার অর্ডারের তালিকা লোড হচ্ছে...</div>';

  try {
    const res = await fetch(api('/api/orders/my-orders'), {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const data = await res.json();

    if (!data.success) {
      container.innerHTML = `<div class="reseller-state reseller-state-error">${escapeAppHtml(data.message)}</div>`;
      return;
    }

    const orders = data.orders || [];
    const orderCountLabel = hasResellerAccess() ? 'মোট অর্ডার ও বিক্রি' : 'মোট অর্ডার';
    const customerLabel = hasResellerAccess() ? 'ক্রেতা' : 'নাম';

    let ordersHtml = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px;">
        <span style="font-size: 0.92rem; color: var(--text-secondary);">${orderCountLabel}: <strong style="color: var(--text-primary);">${orders.length}টি</strong></span>
        <button type="button" class="btn-nav" onclick="loadOrdersView()">🔄 রিফ্রেশ</button>
      </div>
    `;

    if (orders.length === 0) {
      ordersHtml += `
        <div class="empty-state-card">
          <div class="empty-icon">🛒</div>
          <h3>এখনও কোনো অর্ডার আসেনি</h3>
          <p>আপনার করা অর্ডার এখানে দেখা যাবে। পণ্য দেখতে ক্যাটালগে যান।</p>
          <button type="button" class="btn-submit" style="max-width: 220px; margin: 0 auto;" onclick="switchMainTab('shop')">পণ্য দেখতে যান</button>
        </div>
      `;
    } else {
      ordersHtml += orders.map((o) => `
        <article class="surface-card">
          <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 8px;">
            <strong style="color: var(--text-primary); font-size: 0.96rem;">#${escapeAppHtml(o.order_number)}</strong>
            <span style="background: ${getStatusBadgeBg(o.status)}; color: #fff; padding: 3px 10px; border-radius: 999px; font-size: 0.74rem; font-weight: 700;">
              ${escapeAppHtml(getStatusInBangla(o.status))}
            </span>
          </div>
          ${buildOrderStepperHtml(o.status)}
          <div style="font-size: 0.86rem; color: var(--text-secondary); margin-bottom: 8px;">
            <span>${customerLabel}: <strong style="color: var(--text-primary);">${escapeAppHtml(o.customer_name)}</strong></span> • <span>${escapeAppHtml(o.customer_phone)}</span>
          </div>
          ${(o.items && o.items.length) ? `
            <div class="surface-inset" style="font-size: 0.82rem; color: var(--text-secondary); margin-bottom: 10px;">
              ${o.items.map(it => `${escapeAppHtml(it.title)} × ${escapeAppHtml(it.quantity)}`).join('<br>')}
            </div>
          ` : ''}
          <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid var(--border-subtle); padding-top: 10px; font-size: 0.9rem;">
            <span class="tabular">অর্ডার মোট: <strong>${escapeAppHtml(o.total_amount)}৳</strong></span>
            ${hasResellerAccess() ? `<span class="badge-profit-pill">কমিশন: ৳${escapeAppHtml(o.reseller_commission || 0)}</span>` : ''}
          </div>
        </article>
      `).join('');
    }

    container.innerHTML = ordersHtml;
  } catch (err) {
    console.error(err);
    container.innerHTML = '<div style="color: var(--brand-danger); text-align: center; padding: 20px;">অর্ডার তালিকা লোড ব্যর্থ হয়েছে।</div>';
  }
}

async function inlineTrackOrderSubmit() {
  const form = document.getElementById('inlineTrackForm');
  if (form) form.dataset.submitted = 'true';
  const orderNum = (document.getElementById('inlineTrackOrder') ? document.getElementById('inlineTrackOrder').value : '').trim().toUpperCase();
  const phone = (document.getElementById('inlineTrackPhone') ? document.getElementById('inlineTrackPhone').value : '').trim();
  const resContainer = document.getElementById('inlineTrackResult');

  if (!validateFields([
    ['inlineTrackOrder', orderNum ? '' : 'অর্ডার নম্বর দিন'],
    ['inlineTrackPhone', phone ? '' : 'অর্ডারের সময় দেওয়া মোবাইল নম্বর দিন']
  ])) return;

  if (resContainer) resContainer.innerHTML = '<div style="text-align: center; color: var(--text-muted);"><span class="spinner"></span> খোঁজা হচ্ছে...</div>';
  try {
    const res = await fetch(api('/api/orders/track'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order_number: orderNum, phone })
    });
    const data = await res.json();
    if (data.success && data.order) {
      renderSingleOrderTracking(data.order, resContainer);
    } else if (resContainer) {
      resContainer.innerHTML = `<div class="form-alert-error">${escapeAppHtml(data.message || 'অর্ডার পাওয়া যায়নি')}</div>`;
    }
  } catch (err) {
    if (resContainer) resContainer.innerHTML = '<div class="form-alert-error">ট্র্যাকিং ব্যর্থ হয়েছে।</div>';
  }
}

// 2. Wallet View Loader
async function loadWalletView() {
  const container = document.getElementById('walletViewContent');
  if (!container) return;

  if (!currentUser || !authToken) {
    container.innerHTML = `
      <div class="empty-state-card">
        <div class="empty-icon">💰</div>
        <h3>রিসেলার ওয়ালেটে প্রবেশ করুন</h3>
        <p>বিকাশ ও নগদে সরাসরি কমিশন ক্যাশআউট করতে আপনার অ্যাকাউন্টে লগইন করুন।</p>
        <button type="button" class="btn-submit" style="max-width: 240px; margin: 0 auto;" onclick="switchMainTab('profile')">লগইন / রেজিস্ট্রেশন</button>
      </div>
    `;
    return;
  }

  if (!hasResellerAccess()) {
    container.innerHTML = `
      <div class="empty-state-card">
        <h3>রিসেলার অনুমতি প্রয়োজন</h3>
        <p>অ্যাডমিন রিসেলার অনুমতি দিলে কমিশন ও ক্যাশআউট এখানে দেখা যাবে।</p>
      </div>
    `;
    return;
  }

  container.innerHTML = '<div class="reseller-loading"><span class="spinner"></span> ওয়ালেট হিসাব লোড হচ্ছে...</div>';

  try {
    const [summaryRes, txRes] = await Promise.all([
      fetch(api('/api/wallet/summary'), { headers: { Authorization: `Bearer ${authToken}` } }),
      fetch(api('/api/wallet/transactions'), { headers: { Authorization: `Bearer ${authToken}` } })
    ]);
    const summaryData = await summaryRes.json();
    const txData = await txRes.json();

    if (!summaryData.success) {
      container.innerHTML = `<div class="reseller-state reseller-state-error">${escapeAppHtml(summaryData.message)}</div>`;
      return;
    }

    const s = summaryData.summary;
    const transactions = (txData.success && txData.transactions) ? txData.transactions : [];

    container.innerHTML = `
      <div class="wallet-kpi-grid">
        <div class="wallet-kpi-card is-available">
          <div class="wallet-kpi-label" style="color: var(--clr-emerald-700);">উত্তোলনযোগ্য ব্যালেন্স</div>
          <div class="wallet-kpi-value" style="color: var(--clr-emerald-700);">${escapeAppHtml(s.available_balance)} ৳</div>
          <div class="wallet-kpi-sub" style="color: var(--clr-emerald-700);">✓ সরাসরি ক্যাশআউট করা যাবে</div>
        </div>
        <div class="wallet-kpi-card is-pending">
          <div class="wallet-kpi-label" style="color: var(--clr-amber-700);">পেন্ডিং কমিশন</div>
          <div class="wallet-kpi-value" style="color: var(--clr-amber-700);">${escapeAppHtml(s.pending_commission)} ৳</div>
          <div class="wallet-kpi-sub" style="color: var(--clr-amber-700);">⏳ ডেলিভারির পর যোগ হবে</div>
        </div>
        <div class="wallet-kpi-card is-earned">
          <div class="wallet-kpi-label" style="color: var(--brand-power);">মোট অর্জিত আয়</div>
          <div class="wallet-kpi-value" style="color: var(--brand-power);">${escapeAppHtml(s.total_earned)} ৳</div>
          <div class="wallet-kpi-sub">উত্তোলিত: ${escapeAppHtml(s.total_withdrawn)} ৳</div>
        </div>
      </div>

      <form id="inlinePayoutForm" class="surface-card" novalidate>
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
          <h3 style="color: var(--text-primary); font-size: 0.98rem; margin: 0;">💸 ক্যাশআউট রিকোয়েস্ট (বিকাশ / নগদ / রকেট)</h3>
          <span style="font-size: 0.76rem; color: var(--text-muted); font-weight: 600;">ন্যূনতম: ${escapeAppHtml(s.min_cashout)} ৳</span>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
          <div class="form-group">
            <label class="form-label" style="font-size: 0.8rem;" for="inlinePayoutAmount">টাকার পরিমাণ (৳)</label>
            <input type="number" id="inlinePayoutAmount" name="amount" class="form-control" inputmode="numeric" min="${escapeAppHtml(s.min_cashout)}" placeholder="যেমন ৫০০" required>
            <p class="field-error" id="inlinePayoutAmountError" role="alert" hidden></p>
          </div>
          <div class="form-group">
            <label class="form-label" style="font-size: 0.8rem;" for="inlinePayoutMethod">পেমেন্ট মেথড</label>
            <select id="inlinePayoutMethod" name="payment_method" class="form-control">
              <option value="bkash">বিকাশ (bKash)</option>
              <option value="nagad">নগদ (Nagad)</option>
              <option value="rocket">রকেট (Rocket)</option>
            </select>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label" style="font-size: 0.8rem;" for="inlinePayoutAccount">টাকা গ্রহণের মোবাইল নম্বর</label>
          <input type="tel" id="inlinePayoutAccount" name="account_number" class="form-control" inputmode="tel" autocomplete="tel" placeholder="01XXXXXXXXX" value="${escapeAppHtml(currentUser.payout_number || currentUser.phone || '')}" required>
          <p class="field-error" id="inlinePayoutAccountError" role="alert" hidden></p>
        </div>
        <div class="form-alert-error" id="inlinePayoutAlert" role="alert" hidden></div>
        <button type="submit" class="btn-submit">টাকা তোলার রিকোয়েস্ট পাঠান</button>
      </form>

      <div class="surface-card">
        <h3 style="color: var(--text-primary); font-size: 0.98rem; margin-bottom: 10px;">📜 সাম্প্রতিক লেনদেন হিস্ট্রি</h3>
        ${transactions.length === 0 ? '<div class="reseller-state">কোনো লেনদেন রেকর্ড নেই</div>' : `
          <div style="display: flex; flex-direction: column; gap: 8px;">
            ${transactions.map((tx) => {
              const isCredit = tx.type === 'commission' || tx.type === 'referral_commission' || tx.type === 'referral_bonus' || tx.type === 'team_bonus';
              const sign = isCredit ? '+' : '-';
              const color = isCredit ? 'var(--brand-success)' : 'var(--brand-danger)';
              return `
                <div class="wallet-tx-row">
                  <div>
                    <div style="font-weight: 700; color: var(--text-primary);">${escapeAppHtml(tx.notes || (isCredit ? 'কমিশন আয়' : 'ক্যাশআউট'))}</div>
                    <div style="font-size: 0.74rem; color: var(--text-muted);">${escapeAppHtml(new Date(tx.created_at).toLocaleDateString('bn-BD'))} • স্ট্যাটাস: ${escapeAppHtml(getStatusInBangla(tx.status))}</div>
                  </div>
                  <div class="tabular" style="font-weight: 700; font-size: 0.96rem; color: ${color};">
                    ${sign}${escapeAppHtml(tx.amount)} ৳
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        `}
      </div>
    `;
    document.getElementById('inlinePayoutForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      submitInlinePayout(s.available_balance);
    });
  } catch (err) {
    console.error(err);
    container.innerHTML = '<div style="color: var(--brand-danger); text-align: center; padding: 20px;">ওয়ালেট লোড ব্যর্থ হয়েছে।</div>';
  }
}

async function submitInlinePayout(availableBalance) {
  setFormAlertError('inlinePayoutAlert', '');
  const amtInput = document.getElementById('inlinePayoutAmount');
  const methodSelect = document.getElementById('inlinePayoutMethod');
  const accInput = document.getElementById('inlinePayoutAccount');

  const amount = parseFloat(amtInput ? amtInput.value : 0);
  const payment_method = methodSelect ? methodSelect.value : 'bkash';
  const account_number = (accInput ? accInput.value : '').trim();

  let amtErr = '';
  if (isNaN(amount) || amount < 100) amtErr = 'ন্যূনতম ক্যাশআউট ১০০ টাকা';
  else if (amount > availableBalance) amtErr = `পর্যাপ্ত ব্যালেন্স নেই (উত্তোলনযোগ্য ${availableBalance}৳)`;

  if (!validateFields([
    ['inlinePayoutAmount', amtErr],
    ['inlinePayoutAccount', isValidBdPhone(account_number) ? '' : 'সঠিক ১১ ডিজিটের মোবাইল নম্বর দিন']
  ])) return;

  try {
    const res = await fetch(api('/api/wallet/payout-request'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({ amount, payment_method, account_number })
    });
    const data = await res.json();
    if (data.success) {
      showToast(data.message || '✅ ক্যাশআউট রিকোয়েস্ট সফল হয়েছে!');
      loadWalletView();
    } else {
      setFormAlertError('inlinePayoutAlert', data.message || 'রিকোয়েস্ট ব্যর্থ হয়েছে');
    }
  } catch (err) {
    console.error(err);
    setFormAlertError('inlinePayoutAlert', 'ক্যাশআউট রিকোয়েস্ট পাঠাতে ব্যর্থ হয়েছে');
  }
}

// 3. Profile View Loader
function loadProfileView() {
  const container = document.getElementById('profileViewContent');
  if (!container) return;

  if (!currentUser || !authToken) {
    container.innerHTML = `
      <div class="surface-card" style="max-width: 480px; margin: 0 auto;">
        <div class="reseller-auth-tabs" style="margin-bottom: 16px;" role="tablist" aria-label="লগইন ও রেজিস্ট্রেশন">
          <button type="button" id="tabLoginBtn" role="tab" aria-selected="true" class="tab-btn active" onclick="toggleAuthTab('login')">লগইন</button>
          <button type="button" id="tabRegBtn" role="tab" aria-selected="false" class="tab-btn" onclick="toggleAuthTab('register')">নতুন রেজিস্ট্রেশন</button>
        </div>

        <form id="inlineLoginForm" novalidate>
          <div class="form-group">
            <label class="form-label" style="font-size: 0.82rem;" for="inLoginPhone">মোবাইল নম্বর (১১ ডিজিট)</label>
            <input type="tel" id="inLoginPhone" name="phone" class="form-control" inputmode="tel" autocomplete="tel" placeholder="01XXXXXXXXX" required>
            <p class="field-error" id="inLoginPhoneError" role="alert" hidden></p>
          </div>
          <div class="form-group">
            <label class="form-label" style="font-size: 0.82rem;" for="inLoginPass">পাসওয়ার্ড</label>
            <div class="password-input-wrap">
              <input type="password" id="inLoginPass" name="password" class="form-control" autocomplete="current-password" placeholder="আপনার পাসওয়ার্ড" required>
              <button type="button" class="btn-toggle-pass" data-target="inLoginPass" aria-pressed="false" aria-label="পাসওয়ার্ড দেখুন">দেখুন</button>
            </div>
            <p class="field-error" id="inLoginPassError" role="alert" hidden></p>
          </div>
          <div class="form-alert-error" id="inlineLoginAlert" role="alert" hidden></div>
          <button type="submit" class="btn-submit">লগইন করুন</button>
        </form>

        <form id="inlineRegForm" style="display: none;" novalidate hidden>
          <div class="form-group">
            <label class="form-label" style="font-size: 0.82rem;" for="inRegName">আপনার পূর্ণ নাম <span aria-hidden="true">*</span></label>
            <input type="text" id="inRegName" name="name" class="form-control" autocomplete="name" placeholder="যেমন: মো: শাহীন" required>
            <p class="field-error" id="inRegNameError" role="alert" hidden></p>
          </div>
          <div class="form-group">
            <label class="form-label" style="font-size: 0.82rem;" for="inRegPhone">মোবাইল নম্বর (১১ ডিজিট) <span aria-hidden="true">*</span></label>
            <input type="tel" id="inRegPhone" name="phone" class="form-control" inputmode="tel" autocomplete="tel" placeholder="01XXXXXXXXX" required>
            <p class="field-error" id="inRegPhoneError" role="alert" hidden></p>
          </div>
          <div class="form-group">
            <label class="form-label" style="font-size: 0.82rem;" for="inRegPass">পাসওয়ার্ড (কমপক্ষে ৮ অক্ষর) <span aria-hidden="true">*</span></label>
            <div class="password-input-wrap">
              <input type="password" id="inRegPass" name="password" class="form-control" autocomplete="new-password" minlength="8" placeholder="পাসওয়ার্ড দিন" required>
              <button type="button" class="btn-toggle-pass" data-target="inRegPass" aria-pressed="false" aria-label="পাসওয়ার্ড দেখুন">দেখুন</button>
            </div>
            <p class="field-error" id="inRegPassError" role="alert" hidden></p>
          </div>
          <div class="form-group">
            <label class="form-label" style="font-size: 0.82rem;" for="inRegRef">রেফারেল কোড (ঐচ্ছিক)</label>
            <input type="text" id="inRegRef" name="referral_code" class="form-control" autocomplete="off" autocapitalize="characters" placeholder="কোড থাকলে লিখুন" value="${escapeAppHtml(localStorage.getItem('sb_ref_code') || '')}">
          </div>
          <div class="form-alert-error" id="inlineRegAlert" role="alert" hidden></div>
          <button type="submit" class="btn-submit">অ্যাকাউন্ট তৈরি করুন</button>
        </form>
      </div>
    `;
    attachPasswordToggles(container);
    document.getElementById('inlineLoginForm')?.addEventListener('submit', (e) => { e.preventDefault(); submitInlineLogin(); });
    document.getElementById('inlineRegForm')?.addEventListener('submit', (e) => { e.preventDefault(); submitInlineRegister(); });
    return;
  }

  if (!hasResellerAccess()) {
    container.innerHTML = `
      <div class="profile-stack">
        <div class="surface-card">
          <h3 style="color: var(--text-primary); font-size: 1.08rem; margin: 0 0 6px;">${escapeAppHtml(currentUser.name)}</h3>
          <div style="font-size: 0.86rem; color: var(--text-muted);">📞 ${escapeAppHtml(currentUser.phone)}</div>
          <span class="badge-profit-pill" style="margin-top: 10px;">কাস্টমার অ্যাকাউন্ট</span>
          <p style="font-size: 0.86rem; color: var(--text-secondary); margin: 12px 0 0;">আপনি পণ্য কিনতে পারবেন। রিসেলার হিসেবে কমিশন দেখতে ও পণ্য শেয়ার করতে অ্যাডমিনের অনুমতি প্রয়োজন।</p>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 14px;">
            <button type="button" class="btn-submit" onclick="switchMainTab('orders')">আমার অর্ডার</button>
            <button type="button" class="btn-secondary-solid" onclick="switchMainTab('shop')">পণ্য দেখুন</button>
          </div>
        </div>
        <form id="inlinePassForm" class="surface-card" novalidate>
          <h3 style="color: var(--text-primary); font-size: 0.96rem; margin-bottom: 10px;">🔒 পাসওয়ার্ড পরিবর্তন</h3>
          <div class="form-group">
            <label class="form-label" for="inlineOldPass">বর্তমান পাসওয়ার্ড</label>
            <div class="password-input-wrap">
              <input type="password" id="inlineOldPass" name="old_password" class="form-control" autocomplete="current-password" required>
              <button type="button" class="btn-toggle-pass" data-target="inlineOldPass" aria-pressed="false" aria-label="পাসওয়ার্ড দেখুন">দেখুন</button>
            </div>
            <p class="field-error" id="inlineOldPassError" role="alert" hidden></p>
          </div>
          <div class="form-group">
            <label class="form-label" for="inlineNewPass">নতুন পাসওয়ার্ড (কমপক্ষে ৮ অক্ষর)</label>
            <div class="password-input-wrap">
              <input type="password" id="inlineNewPass" name="new_password" class="form-control" autocomplete="new-password" minlength="8" required>
              <button type="button" class="btn-toggle-pass" data-target="inlineNewPass" aria-pressed="false" aria-label="পাসওয়ার্ড দেখুন">দেখুন</button>
            </div>
            <p class="field-error" id="inlineNewPassError" role="alert" hidden></p>
          </div>
          <div class="form-alert-error" id="inlinePassAlert" role="alert" hidden></div>
          <button type="submit" class="btn-submit">পাসওয়ার্ড আপডেট করুন</button>
        </form>
        <button type="button" class="btn-danger-soft" onclick="resellerLogout()">🚪 অ্যাকাউন্ট থেকে লগআউট</button>
      </div>
    `;
    attachPasswordToggles(container);
    document.getElementById('inlinePassForm')?.addEventListener('submit', (e) => { e.preventDefault(); submitInlinePasswordChange(); });
    return;
  }

  // Reseller Profile Dashboard View
  const refLink = `${window.location.origin}/?ref=${currentUser.referral_code || ''}`;
  container.innerHTML = `
    <div class="profile-stack">
      <div class="surface-card">
        <div style="display: flex; align-items: center; gap: 14px; margin-bottom: 14px;">
          <div class="profile-avatar">${escapeAppHtml(currentUser.name.charAt(0))}</div>
          <div>
            <h3 style="color: var(--text-primary); font-size: 1.12rem; margin: 0;">${escapeAppHtml(currentUser.name)}</h3>
            <div style="font-size: 0.84rem; color: var(--text-muted); margin-top: 2px;">📞 ${escapeAppHtml(currentUser.phone)}</div>
            <div style="display: flex; gap: 6px; margin-top: 6px;">
              <span class="badge-profit-pill">💼 অনুমোদিত রিসেলার</span>
              <span class="badge-stock in-stock">অ্যাকাউন্ট সক্রিয়</span>
            </div>
          </div>
        </div>

        <div class="surface-inset" style="margin-top: 10px;">
          <div style="font-size: 0.82rem; font-weight: 700; color: var(--brand-primary-hv); margin-bottom: 6px;">🔗 আপনার পার্সোনাল রেফারেল লিংক</div>
          <div style="display: flex; gap: 8px;">
            <input type="text" readonly value="${escapeAppHtml(refLink)}" class="form-control" style="font-size: 0.84rem;" id="inlineRefLink" aria-label="আপনার রেফারেল লিংক">
            <button type="button" class="btn-copy-link" style="min-height: 46px;" onclick="copyInlineRefLink()">কপি</button>
          </div>
          <div style="font-size: 0.78rem; color: var(--text-muted); margin-top: 6px;">রেফারেল কোড: <strong style="color: var(--text-primary);">${escapeAppHtml(currentUser.referral_code || '')}</strong></div>
        </div>
      </div>

      <form id="inlinePayoutSettingsForm" class="surface-card" novalidate>
        <h3 style="color: var(--text-primary); font-size: 0.98rem; margin-bottom: 12px;">📱 স্থায়ী ক্যাশআউট অ্যাকাউন্ট সেটিংস</h3>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
          <div class="form-group">
            <label class="form-label" style="font-size: 0.8rem;" for="setPayoutMethod">পেমেন্ট মেথড</label>
            <select id="setPayoutMethod" name="payout_method" class="form-control">
              <option value="bkash" ${currentUser.payout_method === 'bkash' ? 'selected' : ''}>বিকাশ (bKash)</option>
              <option value="nagad" ${currentUser.payout_method === 'nagad' ? 'selected' : ''}>নগদ (Nagad)</option>
              <option value="rocket" ${currentUser.payout_method === 'rocket' ? 'selected' : ''}>রকেট (Rocket)</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label" style="font-size: 0.8rem;" for="setPayoutNumber">মোবাইল নম্বর</label>
            <input type="tel" id="setPayoutNumber" name="payout_number" class="form-control" inputmode="tel" autocomplete="tel" placeholder="01XXXXXXXXX" value="${escapeAppHtml(currentUser.payout_number || '')}">
          </div>
        </div>
        <div class="form-alert-error" id="payoutSettingsAlert" role="alert" hidden></div>
        <button type="submit" class="btn-submit">ক্যাশআউট তথ্য সংরক্ষণ করুন</button>
      </form>

      <form id="inlinePassForm" class="surface-card" novalidate>
        <h3 style="color: var(--text-primary); font-size: 0.98rem; margin-bottom: 12px;">🔒 পাসওয়ার্ড পরিবর্তন</h3>
        <div class="form-group">
          <label class="form-label" style="font-size: 0.8rem;" for="inlineOldPass">বর্তমান পাসওয়ার্ড</label>
          <div class="password-input-wrap">
            <input type="password" id="inlineOldPass" name="old_password" class="form-control" autocomplete="current-password" placeholder="পুরাতন পাসওয়ার্ড" required>
            <button type="button" class="btn-toggle-pass" data-target="inlineOldPass" aria-pressed="false" aria-label="পাসওয়ার্ড দেখুন">দেখুন</button>
          </div>
          <p class="field-error" id="inlineOldPassError" role="alert" hidden></p>
        </div>
        <div class="form-group">
          <label class="form-label" style="font-size: 0.8rem;" for="inlineNewPass">নতুন পাসওয়ার্ড (কমপক্ষে ৮ অক্ষর)</label>
          <div class="password-input-wrap">
            <input type="password" id="inlineNewPass" name="new_password" class="form-control" autocomplete="new-password" minlength="8" placeholder="নতুন পাসওয়ার্ড" required>
            <button type="button" class="btn-toggle-pass" data-target="inlineNewPass" aria-pressed="false" aria-label="পাসওয়ার্ড দেখুন">দেখুন</button>
          </div>
          <p class="field-error" id="inlineNewPassError" role="alert" hidden></p>
        </div>
        <div class="form-alert-error" id="inlinePassAlert" role="alert" hidden></div>
        <button type="submit" class="btn-secondary-solid" style="width: 100%;">পাসওয়ার্ড আপডেট করুন</button>
      </form>

      <button type="button" class="btn-danger-soft" onclick="resellerLogout()">
        🚪 অ্যাকাউন্ট থেকে লগআউট
      </button>
    </div>
  `;
  attachPasswordToggles(container);
  document.getElementById('inlinePayoutSettingsForm')?.addEventListener('submit', (e) => { e.preventDefault(); savePayoutSettings(); });
  document.getElementById('inlinePassForm')?.addEventListener('submit', (e) => { e.preventDefault(); submitInlinePasswordChange(); });
}

function copyInlineRefLink() {
  const link = document.getElementById('inlineRefLink');
  if (link) {
    navigator.clipboard?.writeText(link.value);
    showToast('✅ রেফারেল লিংক কপি হয়েছে!');
  }
}

async function savePayoutSettings() {
  setFormAlertError('payoutSettingsAlert', '');
  const methodSelect = document.getElementById('setPayoutMethod');
  const numberInput = document.getElementById('setPayoutNumber');
  const payout_method = methodSelect ? methodSelect.value : null;
  const payout_number = numberInput ? numberInput.value.trim() : null;

  try {
    const res = await fetch(api('/api/auth/me'), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({ name: currentUser.name, payout_method, payout_number })
    });
    const data = await res.json();
    if (data.success) {
      currentUser = data.user;
      localStorage.setItem('sb_user', JSON.stringify(data.user));
      showToast('✅ ক্যাশআউট তথ্য সংরক্ষিত হয়েছে!');
    } else {
      setFormAlertError('payoutSettingsAlert', data.message || 'তথ্য সংরক্ষণ ব্যর্থ হয়েছে');
    }
  } catch (e) {
    setFormAlertError('payoutSettingsAlert', 'সেটিংস সংরক্ষণ ব্যর্থ হয়েছে');
  }
}

async function submitInlinePasswordChange() {
  setFormAlertError('inlinePassAlert', '');
  const old_password = (document.getElementById('inlineOldPass') ? document.getElementById('inlineOldPass').value : '').trim();
  const new_password = (document.getElementById('inlineNewPass') ? document.getElementById('inlineNewPass').value : '').trim();
  const newPasswordBytes = new TextEncoder().encode(new_password).length;

  if (!validateFields([
    ['inlineOldPass', old_password ? '' : 'বর্তমান পাসওয়ার্ড দিন'],
    ['inlineNewPass', (newPasswordBytes >= 8 && newPasswordBytes <= 72) ? '' : 'নতুন পাসওয়ার্ড কমপক্ষে ৮ অক্ষরের হতে হবে']
  ])) return;

  try {
    const res = await fetch(api('/api/auth/change-password'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({ old_password, new_password })
    });
    const data = await res.json();
    if (data.success) {
      if (data.token) {
        authToken = data.token;
        localStorage.setItem('sb_token', data.token);
      }
      showToast('✅ পাসওয়ার্ড সফলভাবে আপডেট হয়েছে!');
      loadProfileView();
    } else {
      setFormAlertError('inlinePassAlert', data.message || 'পাসওয়ার্ড আপডেট ব্যর্থ');
    }
  } catch (e) {
    setFormAlertError('inlinePassAlert', 'পাসওয়ার্ড আপডেট ব্যর্থ হয়েছে');
  }
}

function toggleAuthTab(type) {
  const isLogin = type === 'login';
  const loginForm = document.getElementById('inlineLoginForm');
  const regForm = document.getElementById('inlineRegForm');
  const loginBtn = document.getElementById('tabLoginBtn');
  const regBtn = document.getElementById('tabRegBtn');

  if (loginForm) {
    loginForm.style.display = isLogin ? 'block' : 'none';
    loginForm.hidden = !isLogin;
  }
  if (regForm) {
    regForm.style.display = isLogin ? 'none' : 'block';
    regForm.hidden = isLogin;
  }
  if (loginBtn) {
    loginBtn.classList.toggle('active', isLogin);
    loginBtn.setAttribute('aria-selected', String(isLogin));
  }
  if (regBtn) {
    regBtn.classList.toggle('active', !isLogin);
    regBtn.setAttribute('aria-selected', String(!isLogin));
  }
}

async function submitInlineLogin() {
  setFormAlertError('inlineLoginAlert', '');
  const phone = (document.getElementById('inLoginPhone') ? document.getElementById('inLoginPhone').value : '').trim();
  const password = (document.getElementById('inLoginPass') ? document.getElementById('inLoginPass').value : '').trim();

  if (!validateFields([
    ['inLoginPhone', phone ? '' : 'ফোন নম্বর দিন'],
    ['inLoginPass', password ? '' : 'পাসওয়ার্ড দিন']
  ])) return;

  try {
    const res = await fetch(api('/api/auth/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, password })
    });
    const data = await res.json();
    if (data.success) {
      authToken = data.token;
      currentUser = data.user;
      localStorage.setItem('sb_token', data.token);
      localStorage.setItem('sb_user', JSON.stringify(data.user));
      updateAuthUI();
      await loadProducts();
      showToast(`স্বাগতম, ${data.user.name}!`);
      loadProfileView();
    } else {
      setFormAlertError('inlineLoginAlert', data.message || 'লগইন তথ্য সঠিক নয়');
    }
  } catch (err) {
    setFormAlertError('inlineLoginAlert', 'লগইন ব্যর্থ হয়েছে');
  }
}

async function submitInlineRegister() {
  setFormAlertError('inlineRegAlert', '');
  const name = (document.getElementById('inRegName') ? document.getElementById('inRegName').value : '').trim();
  const phone = (document.getElementById('inRegPhone') ? document.getElementById('inRegPhone').value : '').trim();
  const password = (document.getElementById('inRegPass') ? document.getElementById('inRegPass').value : '').trim();
  const referral_code = (document.getElementById('inRegRef') ? document.getElementById('inRegRef').value : '').trim();
  const passwordBytes = new TextEncoder().encode(password).length;

  if (!validateFields([
    ['inRegName', name.length >= 2 ? '' : 'সঠিক পূর্ণ নাম দিন'],
    ['inRegPhone', isValidBdPhone(phone) ? '' : 'সঠিক ১১ ডিজিটের মোবাইল নম্বর দিন'],
    ['inRegPass', (passwordBytes >= 8 && passwordBytes <= 72) ? '' : 'পাসওয়ার্ড কমপক্ষে ৮ অক্ষরের হতে হবে']
  ])) return;

  try {
    const res = await fetch(api('/api/auth/register'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, phone, password, referral_code })
    });
    const data = await res.json();
    if (data.success) {
      authToken = data.token;
      currentUser = data.user;
      localStorage.setItem('sb_token', data.token);
      localStorage.setItem('sb_user', JSON.stringify(data.user));
      updateAuthUI();
      await loadProducts();
      showToast('কাস্টমার অ্যাকাউন্ট তৈরি হয়েছে।');
      loadProfileView();
    } else {
      setFormAlertError('inlineRegAlert', data.message || 'রেজিস্ট্রেশন ব্যর্থ হয়েছে');
    }
  } catch (err) {
    setFormAlertError('inlineRegAlert', 'রেজিস্ট্রেশন ব্যর্থ হয়েছে');
  }
}
