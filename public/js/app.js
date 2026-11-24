// ============================================================
// SB Furniture & SB POWER — Core App & Reseller Wallet Controller
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
let currentUser = readStoredJson('sb_user', null);
if (!currentUser || typeof currentUser !== 'object' || typeof currentUser.name !== 'string') currentUser = null;
let authToken = localStorage.getItem('sb_token') || null;

const api = (path) => (typeof window.apiUrl === 'function' ? window.apiUrl(path) : path);
const escapeAppHtml = (value) => window.sbEscapeHtml(value);

// Initialize Application
document.addEventListener('DOMContentLoaded', () => {
  captureReferralCode();
  updateCartBadges();
  updateAuthUI();
  loadProducts();
  loadConfig();
});

// Load Public Config, Flash Deals & Brand Metadata
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
  } catch (err) {
    // Graceful offline fallback
  }
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

// Toast Notifications
function showToast(message) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3000);
}

// Modal Helpers (Accessible & responsive)
function openModal(id) {
  const modal = document.getElementById(id);
  if (modal) {
    modal.classList.add('active');
    if (!modal._backdropInit) {
      modal._backdropInit = true;
      modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal(id);
      });
    }
  }
}

function closeModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.classList.remove('active');
}

// Global Escape Key to dismiss active modals
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.active').forEach((m) => {
      m.classList.remove('active');
    });
  }
});

// Header Auth UI
function updateAuthUI() {
  const navText = document.getElementById('navResellerText');
  const hasResellerPermission = typeof hasResellerAccess === 'function' && hasResellerAccess();
  if (navText) {
    navText.textContent = hasResellerPermission && currentUser
      ? `${currentUser.name.split(' ')[0]} • রিসেলার`
      : 'আমার অ্যাকাউন্ট';
  }
  const walletTab = document.getElementById('bnavWallet');
  if (walletTab) walletTab.style.display = hasResellerPermission ? '' : 'none';
  document.querySelectorAll('[data-reseller-only]').forEach((element) => {
    element.hidden = !hasResellerPermission;
    element.style.display = hasResellerPermission ? '' : 'none';
  });
  if (!hasResellerPermission) {
    currentTab = 'all';
    if (currentSort === 'commission_desc') currentSort = 'default';
    const sortSelect = document.getElementById('sortSelect');
    if (sortSelect) sortSelect.value = currentSort;
    document.querySelectorAll('.commission-tabs-wrap .tab-btn').forEach((button) => {
      button.classList.toggle('active', button.dataset.tab === 'all');
    });
    if (currentMainTab === 'wallet' && typeof switchMainTab === 'function') switchMainTab('profile');
  }
}

// ================= CART & CHECKOUT =================
function addToCart(productId, selectedColor = '') {
  const item = allProducts.find((p) => p.id === productId);
  if (!item) return;

  const existingIndex = cart.findIndex((c) => c.product.id === productId && c.selected_color === selectedColor);
  if (existingIndex > -1) {
    cart[existingIndex].quantity += 1;
  } else {
    cart.push({
      product: item,
      quantity: 1,
      selected_color: selectedColor
    });
  }

  saveCart();
  showToast(`✅ "${item.title.substring(0, 24)}..." কার্টে যুক্ত হয়েছে!`);
}

function addToCartFromModal(productId) {
  const colorSelect = document.getElementById('modalColorSelect');
  const selectedColor = colorSelect ? colorSelect.value : '';
  addToCart(productId, selectedColor);
  closeModal('productDetailModal');
}

function saveCart() {
  localStorage.setItem('sb_cart', JSON.stringify(cart));
  updateCartBadges();
}

function updateCartBadges() {
  const totalItems = cart.reduce((sum, item) => sum + item.quantity, 0);
  const b1 = document.getElementById('cartBadge');
  const b2 = document.getElementById('floatCartBadge');
  if (b1) b1.textContent = totalItems;
  if (b2) b2.textContent = totalItems;
}

function openCartModal() {
  renderCartModal();
  openModal('cartModal');
}

function renderCartModal() {
  const container = document.getElementById('cartItemsContainer');
  const formWrap = document.getElementById('checkoutFormWrap');

  if (cart.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 30px; color: var(--sbf-text-muted);">
        <p style="font-size: 1.1rem; margin-bottom: 8px;">🛒 আপনার কার্ট খালি আছে</p>
        <p style="font-size: 0.85rem;">পণ্য ব্রাউজ করে "অর্ডার" বাটনে ক্লিক করুন।</p>
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

  container.innerHTML = cart.map((item, index) => `
    <div style="display: flex; align-items: center; justify-content: space-between; background: #292524; padding: 10px; border-radius: var(--radius-sm); margin-bottom: 8px;">
      <div style="flex: 1; margin-right: 10px;">
        <div style="font-size: 0.88rem; font-weight: 600; color: #fff;">${escapeAppHtml(item.product.title)}</div>
        <div style="font-size: 0.75rem; color: var(--sbf-text-muted);">
          SKU: ${escapeAppHtml(item.product.sku)} ${item.selected_color ? `• কালার: ${escapeAppHtml(item.selected_color)}` : ''}
        </div>
        <div style="font-size: 0.85rem; color: var(--sbp-yellow); font-weight: 700;">
          ${escapeAppHtml(item.product.regular_price)} ৳ × ${escapeAppHtml(item.quantity)} = ${escapeAppHtml(item.product.regular_price * item.quantity)} ৳
        </div>
      </div>
      <div style="display: flex; align-items: center; gap: 6px;">
        <button class="btn-nav" style="padding: 4px 8px;" onclick="changeCartQty(${index}, -1)">-</button>
        <span style="font-weight: 700; min-width: 20px; text-align: center;">${item.quantity}</span>
        <button class="btn-nav" style="padding: 4px 8px;" onclick="changeCartQty(${index}, 1)">+</button>
        <button class="btn-nav" style="padding: 4px 8px; color: var(--sbp-red);" onclick="removeCartItem(${index})">🗑️</button>
      </div>
    </div>
  `).join('');

  calculateCartTotals();
  if (typeof window.loadReferralCreditForCheckout === 'function') window.loadReferralCreditForCheckout();
}

function changeCartQty(index, delta) {
  if (cart[index]) {
    if (delta > 0 && cart[index].quantity >= 100) {
      return showToast('একটি পণ্যের সর্বোচ্চ অর্ডার ১০০টি');
    }
    cart[index].quantity += delta;
    if (cart[index].quantity <= 0) {
      cart.splice(index, 1);
    }
    saveCart();
    renderCartModal();
  }
}

function removeCartItem(index) {
  cart.splice(index, 1);
  saveCart();
  renderCartModal();
}

function calculateCartTotals() {
  const subtotal = cart.reduce((sum, item) => sum + (item.product.regular_price * item.quantity), 0);
  const hasFurniture = cart.some((item) => item.product.brand === 'SB Furniture');
  const city = document.getElementById('orderDeliveryCity').value;

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

}

// Anti-Fraud Order Submission
async function submitOrder() {
  const custName = document.getElementById('orderCustName').value.trim();
  const custPhone = document.getElementById('orderCustPhone').value.trim();
  const custAddress = document.getElementById('orderCustAddress').value.trim();
  const deliveryCity = document.getElementById('orderDeliveryCity').value;
  const trxId = document.getElementById('orderTrxId').value.trim();
  const advancePaid = parseFloat(document.getElementById('orderAdvancePaid').value) || 0;

  if (!custName) return alert('অনুগ্রহ করে আপনার নাম দিন');
  if (!/^01[3-9]\d{8}$/.test(custPhone.replace(/\D/g, ''))) return alert('সঠিক ১১ ডিজিটের বাংলাদেশি মোবাইল নম্বর দিন');
  if (!custAddress) return alert('সম্পূর্ণ ডেলিভারি ঠিকানা দিন');

  // Keep the share link that brought this shopper here, including after login.
  // If there is no incoming link, an authenticated reseller can enter a sale
  // for a separate customer using their own code.
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

  const submitBtn = document.querySelector('#cartModal .btn-submit');
  const originalText = submitBtn ? submitBtn.innerHTML : 'নিশ্চিত করুন ও অর্ডার প্লেস করুন';
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
    if (data.success) {
      cart = [];
      saveCart();
      const creditCheckbox = document.getElementById('useReferralCredit');
      if (creditCheckbox) creditCheckbox.checked = false;
      if (Number(data.order.discount_amount) > 0) {
        window.referralCreditAvailable = Math.max(0, Number(window.referralCreditAvailable || 0) - Number(data.order.discount_amount));
      }
      closeModal('cartModal');

      alert(`🎉 ধন্যবাদ! আপনার অর্ডারটি সফলভাবে গ্রহণ করা হয়েছে।\nঅর্ডার নম্বর: ${data.order.order_number}${Number(data.order.discount_amount) > 0 ? `\nReferral discount: ${data.order.discount_amount} ৳` : ''}\n\nআপনার সাথে দ্রুত যোগাযোগ করে ডেলিভারি কনফার্ম করা হবে।`);
      trackSpecificOrder(data.order.order_number, custPhone);
    } else {
      alert(`ত্রুটি: ${data.message}`);
    }
  } catch (err) {
    console.error(err);
    alert('অর্ডার সাবমিট করতে সমস্যা হয়েছে, পুনরায় চেষ্টা করুন।');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = originalText;
    }
  }
}

// ================= RESELLER PORTAL & WALLET =================
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
      <h4>পণ্য কিনতে কাস্টমার অ্যাকাউন্ট খুলুন</h4>
      <p>রিসেল করার অনুমতি অ্যাডমিন দেবেন। অনুমোদনের পরেই কমিশন ও রিসেলার টুল দেখা যাবে।</p>
    </div>
    <div class="reseller-auth-tabs" role="tablist" aria-label="রিসেলার অ্যাকাউন্ট">
      <button type="button" class="tab-btn active" id="btnShowLogin" role="tab" aria-selected="true" onclick="switchResellerTab('login')">লগইন</button>
      <button type="button" class="tab-btn" id="btnShowRegister" role="tab" aria-selected="false" onclick="switchResellerTab('register')">কাস্টমার অ্যাকাউন্ট খুলুন</button>
    </div>
    <div id="resellerLoginForm" class="reseller-auth-form" role="tabpanel" aria-labelledby="btnShowLogin">
      <div class="form-group"><label class="form-label" for="resellerLoginPhone">মোবাইল নম্বর</label><input type="tel" id="resellerLoginPhone" class="form-control" inputmode="tel" autocomplete="tel" placeholder="01XXXXXXXXX" required></div>
      <div class="form-group"><label class="form-label" for="resellerLoginPassword">পাসওয়ার্ড</label><input type="password" id="resellerLoginPassword" class="form-control" autocomplete="current-password" placeholder="আপনার পাসওয়ার্ড" required></div>
      <button class="btn-submit" onclick="submitResellerLogin()">লগইন করুন</button>
    </div>
    <div id="resellerRegisterForm" class="reseller-auth-form" role="tabpanel" aria-labelledby="btnShowRegister" hidden>
      <div class="form-group"><label class="form-label" for="regName">আপনার পূর্ণ নাম</label><input type="text" id="regName" class="form-control" autocomplete="name" maxlength="100" placeholder="আপনার নাম" required></div>
      <div class="form-group"><label class="form-label" for="regPhone">মোবাইল নম্বর</label><input type="tel" id="regPhone" class="form-control" inputmode="tel" autocomplete="tel" placeholder="01XXXXXXXXX" required></div>
      <div class="form-group"><label class="form-label" for="regPassword">পাসওয়ার্ড (কমপক্ষে ৮ অক্ষর)</label><input type="password" id="regPassword" class="form-control" autocomplete="new-password" minlength="8" placeholder="নতুন পাসওয়ার্ড তৈরি করুন" required></div>
      <div class="form-group"><label class="form-label" for="regRefCode">রেফারেল কোড <span>(ঐচ্ছিক)</span></label><input type="text" id="regRefCode" class="form-control" value="${escapeAppHtml(storedRef)}" placeholder="কোড থাকলে লিখুন"></div>
      <button class="btn-submit" onclick="submitResellerRegister()">রেজিস্ট্রেশন সম্পন্ন করুন</button>
    </div>
  `;
}

function renderCustomerAccount() {
  document.getElementById('resellerModalTitle').textContent = '👤 আমার কাস্টমার অ্যাকাউন্ট';
  document.getElementById('resellerModalBody').innerHTML = `
    <div style="background:#f8fafc; border:1px solid #dbe3ec; border-radius:12px; padding:16px; color:#1f2937;">
      <h4 style="margin:0 0 6px;">স্বাগতম, ${escapeAppHtml(currentUser.name)}!</h4>
      <p style="margin:0 0 10px; font-size:.9rem;">এই অ্যাকাউন্টে আপনি পণ্য কিনতে পারবেন। রিসেলার হতে অ্যাডমিনের অনুমতি লাগবে।</p>
      <div style="font-size:.85rem; color:#475569;">অ্যাকাউন্ট: কাস্টমার</div>
      <div id="customerReferralPanel" style="margin-top:14px;"></div>
      <div style="display:flex; gap:8px; margin-top:14px;">
        <button type="button" class="btn-submit" onclick="closeModal('resellerModal'); switchMainTab('shop');">পণ্য দেখুন</button>
        <button type="button" class="btn-nav" onclick="resellerLogout()">লগআউট</button>
      </div>
    </div>
  `;
  if (typeof window.loadMyReferralDashboard === 'function') window.loadMyReferralDashboard('customerReferralPanel');
}

function switchResellerTab(tab) {
  const isLogin = tab === 'login';
  document.getElementById('resellerLoginForm').style.display = isLogin ? 'block' : 'none';
  document.getElementById('resellerRegisterForm').style.display = isLogin ? 'none' : 'block';
  document.getElementById('resellerRegisterForm').hidden = isLogin;
  document.getElementById('btnShowLogin').setAttribute('aria-selected', String(isLogin));
  document.getElementById('btnShowRegister').setAttribute('aria-selected', String(!isLogin));
  document.getElementById('btnShowLogin').classList.toggle('active', isLogin);
  document.getElementById('btnShowRegister').classList.toggle('active', !isLogin);
}

async function submitResellerLogin() {
  const phone = document.getElementById('resellerLoginPhone').value.trim();
  const password = document.getElementById('resellerLoginPassword').value;

  if (!phone || !password) return alert('ফোন নম্বর ও পাসওয়ার্ড দিন');

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
      showToast(`স্বাগতম, ${data.user.name}!`);
    } else {
      alert(data.message);
    }
  } catch (err) {
    console.error(err);
    alert('লগইন ব্যর্থ হয়েছে');
  }
}

async function submitResellerRegister() {
  const name = document.getElementById('regName').value.trim();
  const phone = document.getElementById('regPhone').value.trim();
  const password = document.getElementById('regPassword').value;
  const referral_code = document.getElementById('regRefCode').value.trim();

  if (!name || name.length < 2 || name.length > 100) return alert('সঠিক পূর্ণ নাম দিন (২ থেকে ১০০ অক্ষর)');
  if (!/^01[3-9]\d{8}$/.test(phone.replace(/\D/g, ''))) return alert('সঠিক ১১ ডিজিটের বাংলাদেশি মোবাইল নম্বর দিন');
  const passwordBytes = new TextEncoder().encode(password).length;
  if (passwordBytes < 8 || passwordBytes > 72) return alert('পাসওয়ার্ড ৮ থেকে ৭২ বাইটের মধ্যে হতে হবে');

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
      showToast('কাস্টমার অ্যাকাউন্ট তৈরি হয়েছে। রিসেল করতে অ্যাডমিনের অনুমতি লাগবে।');
    } else {
      alert(data.message);
    }
  } catch (err) {
    console.error(err);
    alert('রেজিস্ট্রেশন ব্যর্থ হয়েছে');
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
          <div><span class="reseller-kicker">রিসেলার লিংক</span><h4>পণ্য শেয়ার করে বিক্রি শুরু করুন</h4></div>
          <span class="reseller-link-icon" aria-hidden="true">↗</span>
        </div>
        <p class="reseller-help-text">এই লিংক দিয়ে আসা অর্ডার সফলভাবে ডেলিভারি হলে সংশ্লিষ্ট পণ্যের কমিশন আপনার হিসাবে যোগ হবে।</p>
        <div class="ref-link-row">
          <input type="text" readonly value="${escapeAppHtml(refLink)}" class="ref-link-input" id="myRefLinkInput">
          <button type="button" class="btn-copy-link" onclick="copyReferralLink()">লিংক কপি</button>
        </div>
        <div class="reseller-code-line">শেয়ার কোড <strong>${escapeAppHtml(s.referral_code)}</strong></div>
      </section>
      <div id="resellerReferralPanel"></div>
      <section class="reseller-wallet-section" aria-labelledby="resellerWalletHeading">
        <div class="reseller-section-heading">
          <div><span class="reseller-kicker">আপনার হিসাব</span><h4 id="resellerWalletHeading">কমিশন ও ব্যালেন্স</h4></div>
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
        <div class="reseller-payout-form">
          <div class="payout-form-row">
            <div class="form-group"><label class="form-label" for="payoutAmount">টাকার পরিমাণ</label><input type="number" id="payoutAmount" class="form-control" min="${escapeAppHtml(s.min_cashout)}" inputmode="numeric" placeholder="যেমন ৫০০"></div>
            <div class="form-group"><label class="form-label" for="payoutMethod">পেমেন্ট মাধ্যম</label><select id="payoutMethod" class="form-control"><option value="bkash">বিকাশ</option><option value="nagad">নগদ</option><option value="rocket">রকেট</option></select></div>
          </div>
          <div class="form-group"><label class="form-label" for="payoutAccount">যে মোবাইল নম্বরে টাকা নেবেন</label><input type="tel" id="payoutAccount" class="form-control" inputmode="tel" autocomplete="tel" placeholder="01XXXXXXXXX"></div>
          <button type="button" class="btn-submit" onclick="requestPayout()">ক্যাশআউট রিকোয়েস্ট পাঠান</button>
        </div>
      </details>
      <nav class="reseller-tools" aria-label="রিসেলার অ্যাকাউন্ট">
        <button type="button" class="reseller-tool-button" onclick="showMyOrders()"><span aria-hidden="true">▤</span>আমার বিক্রি</button>
        <button type="button" class="reseller-tool-button" onclick="showResellerNotifications()"><span aria-hidden="true">♢</span>নোটিশ <span id="resellerNotifBadge" class="badge" style="display:none;">0</span></button>
        <button type="button" class="reseller-tool-button" onclick="showChangePasswordForm()"><span aria-hidden="true">⌑</span>পাসওয়ার্ড</button>
        <button type="button" class="reseller-tool-button reseller-tool-logout" onclick="resellerLogout()"><span aria-hidden="true">↪</span>লগআউট</button>
      </nav>
      <section id="resellerSubContent" class="reseller-subcontent" aria-live="polite"></section>
      </div>
    `;
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

function copyReferralLink() {
  const linkInput = document.getElementById('myRefLinkInput');
  if (!linkInput) return;
  navigator.clipboard.writeText(linkInput.value);
  showToast('✅ রেফারেল লিংক কপি হয়েছে!');
}

async function requestPayout() {
  const amount = parseFloat(document.getElementById('payoutAmount').value);
  const payment_method = document.getElementById('payoutMethod').value;
  const account_number = document.getElementById('payoutAccount').value.trim();

  if (isNaN(amount) || amount < 100) return alert('ন্যূনতম ক্যাশআউট ১০০ টাকা');
  if (!account_number || account_number.length < 11) return alert('সঠিক ১১ ডিজিটের মোবাইল নম্বর দিন');

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
      alert(data.message);
      renderResellerDashboard();
    } else {
      alert(`ত্রুটি: ${data.message}`);
    }
  } catch (err) {
    console.error(err);
    alert('ক্যাশআউট রিকোয়েস্ট পাঠাতে ব্যর্থ হয়েছে');
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
      <h4 class="reseller-subheading">আপনার শেয়ার থেকে আসা বিক্রি</h4>
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
    <div class="reseller-password-panel">
      <h4 class="reseller-subheading">পাসওয়ার্ড পরিবর্তন</h4>
      <div class="form-group">
        <label class="form-label" for="oldPassInput">বর্তমান পাসওয়ার্ড</label>
        <input type="password" id="oldPassInput" class="form-control" autocomplete="current-password" placeholder="বর্তমান পাসওয়ার্ড" required>
      </div>
      <div class="form-group">
        <label class="form-label" for="newPassInput">নতুন পাসওয়ার্ড (কমপক্ষে ৮ অক্ষর)</label>
        <input type="password" id="newPassInput" class="form-control" autocomplete="new-password" minlength="8" placeholder="নতুন পাসওয়ার্ড" required>
      </div>
      <button class="btn-submit" onclick="submitChangePassword()">পাসওয়ার্ড পরিবর্তন করুন</button>
    </div>
  `;
}

async function submitChangePassword() {
  const old_password = document.getElementById('oldPassInput').value;
  const new_password = document.getElementById('newPassInput').value;
  if (!old_password || !new_password) return alert('সকল ফিল্ড পূরণ করুন');
  const newPasswordBytes = new TextEncoder().encode(new_password).length;
  if (newPasswordBytes < 8 || newPasswordBytes > 72) return alert('নতুন পাসওয়ার্ড ৮ থেকে ৭২ বাইটের মধ্যে হতে হবে');

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
      // A password change revokes older tokens; keep this device signed in.
      if (data.token) {
        authToken = data.token;
        localStorage.setItem('sb_token', data.token);
      }
      alert(data.message);
      showMyOrders();
    } else {
      alert(data.message);
    }
  } catch (err) {
    alert('পাসওয়ার্ড পরিবর্তনে সমস্যা হয়েছে');
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
  renderResellerAuthForms();
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
        <h4 class="reseller-subheading">নোটিশ (${data.notifications.length})</h4>
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
  } catch (e) {}
}

async function markAllNotificationsRead() {
  try {
    await fetch(api('/api/auth/notifications/read-all'), { method: 'PUT', headers: { Authorization: `Bearer ${authToken}` } });
    showResellerNotifications();
  } catch (e) {}
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
      <div style="font-size: 0.88rem; color: #fff; margin-bottom: 8px;">আপনার মোট ${data.orders.length}টি অর্ডার পাওয়া গেছে:</div>
      ${data.orders.map((o) => `
        <div style="background: #292524; padding: 10px; border-radius: var(--radius-sm); border: 1px solid var(--sbf-border); margin-bottom: 8px; cursor: pointer;" onclick="renderSingleOrderTrackingFromData(${o.id})">
          <div style="display: flex; justify-content: space-between;"><strong>#${escapeAppHtml(o.order_number)}</strong><span style="color: ${getStatusBadgeBg(o.status)}; font-weight: 700; font-size: 0.8rem;">${escapeAppHtml(getStatusInBangla(o.status))}</span></div>
          <div style="font-size: 0.78rem; color: var(--sbf-text-muted); margin-top: 4px;">মোট: ${escapeAppHtml(o.total_amount)}৳ • তারিখ: ${new Date(o.created_at).toLocaleDateString('bn-BD')}</div>
        </div>
      `).join('')}
    `;
  } catch (e) {
    resultDiv.innerHTML = '<div style="color: var(--sbp-red); text-align: center;">অর্ডার হিস্ট্রি লোড ব্যর্থ হয়েছে।</div>';
  }
}

// ================= ORDER TRACKING =================
function openTrackModal() {
  openModal('trackModal');
}

async function trackOrder() {
  const orderNumber = document.getElementById('trackOrderInput').value.trim();
  const phone = document.getElementById('trackCustomerPhone').value.trim();
  if (!orderNumber) return alert('অর্ডার নম্বর লিখুন');
  if (!phone) return alert('অর্ডারের সময় দেওয়া মোবাইল নম্বর লিখুন');
  trackSpecificOrder(orderNumber, phone);
}

async function trackSpecificOrder(orderNumber, customerPhone = '') {
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

function renderSingleOrderTracking(o, container) {
  container.innerHTML = `
    <div style="background: #292524; padding: 14px; border-radius: var(--radius-sm); border: 1px solid var(--sbf-border);">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
        <h4 style="color: #fff;">অর্ডার #${escapeAppHtml(o.order_number)}</h4>
        <span style="background: ${getStatusBadgeBg(o.status)}; color: #fff; padding: 3px 10px; border-radius: 20px; font-size: 0.78rem; font-weight: 700;">
          ${escapeAppHtml(getStatusInBangla(o.status))}
        </span>
      </div>
      <div style="font-size: 0.85rem; line-height: 1.6; color: #d6d3d1;">
        <div><strong>গ্রাহকের নাম:</strong> ${escapeAppHtml(o.customer_name)}</div>
        <div><strong>মোবাইল:</strong> ${escapeAppHtml(o.customer_phone)}</div>
        <div><strong>ঠিকানা:</strong> ${escapeAppHtml(o.delivery_address)} (${o.delivery_city === 'inside_dhaka' ? 'ঢাকা ভেতরে' : 'ঢাকা বাইরে'})</div>
        <div><strong>সর্বমোট:</strong> ${escapeAppHtml(o.total_amount)} ৳ (অগ্রিম: ${escapeAppHtml(o.advance_paid)} ৳)</div>
        ${o.advance_trx_id ? `<div><strong>অগ্রিম TrxID:</strong> ${escapeAppHtml(o.advance_trx_id)}</div>` : ''}
      </div>
      <div style="margin-top: 12px; border-top: 1px solid var(--sbf-border); padding-top: 8px;">
        <strong style="font-size: 0.82rem; color: #fff;">পণ্যসমূহ:</strong>
        ${(o.items || []).map((it) => `
          <div style="font-size: 0.8rem; color: var(--sbf-text-muted); display: flex; justify-content: space-between; margin-top: 4px;">
            <span>${escapeAppHtml(it.title)} × ${escapeAppHtml(it.quantity)}</span>
            <span>${escapeAppHtml(it.total_price)} ৳</span>
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
  shipped: '#8b5cf6',
  delivered: '#10b981',
  cancelled: '#ef4444'
};
const getStatusInBangla = (status) => BANGLA_STATUS_MAP[status] || status;
const getStatusBadgeBg = (status) => STATUS_BADGE_BG_MAP[status] || '#44403c';

// ================= MODERN BOTTOM NAVIGATION & VIEWS =================
let currentMainTab = 'shop';

function switchMainTab(tab) {
  if (tab === 'wallet' && (!currentUser || !hasResellerAccess())) {
    showToast('রিসেলার ওয়ালেট দেখতে অ্যাডমিন অনুমতি প্রয়োজন');
    switchMainTab('profile');
    return;
  }
  currentMainTab = tab;

  // Update bottom nav active classes
  const navItems = {
    shop: document.getElementById('bnavShop'),
    orders: document.getElementById('bnavOrders'),
    wallet: document.getElementById('bnavWallet'),
    profile: document.getElementById('bnavProfile')
  };
  Object.keys(navItems).forEach((key) => {
    if (navItems[key]) {
      navItems[key].classList.toggle('active', key === tab);
    }
  });

  // Switch View Panels
  const views = {
    shop: document.getElementById('viewShop'),
    orders: document.getElementById('viewOrders'),
    wallet: document.getElementById('viewWallet'),
    profile: document.getElementById('viewProfile')
  };
  Object.keys(views).forEach((key) => {
    if (views[key]) {
      views[key].classList.toggle('active', key === tab);
    }
  });

  // Load view content
  if (tab === 'orders') {
    loadOrdersView();
  } else if (tab === 'wallet') {
    loadWalletView();
  } else if (tab === 'profile') {
    loadProfileView();
  } else if (tab === 'shop') {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

// 1. Orders View Loader
async function loadOrdersView() {
  const container = document.getElementById('ordersViewContent');
  if (!container) return;

  if (!currentUser || !authToken) {
    container.innerHTML = `
      <div style="background: #1c1917; border: 1px solid var(--sbf-border); border-radius: var(--radius-md); padding: 20px; text-align: center; margin-bottom: 20px;">
        <div style="font-size: 2.2rem; margin-bottom: 8px;">💼</div>
        <h3 style="color: #fff; font-size: 1.1rem; margin-bottom: 6px;">অর্ডারের তালিকা দেখতে লগইন করুন</h3>
        <p style="font-size: 0.85rem; color: #a1a1aa; margin-bottom: 14px;">কাস্টমার অ্যাকাউন্টে নিজের অর্ডার, আর অনুমোদিত রিসেলার অ্যাকাউন্টে বিক্রির হিসাব দেখা যাবে।</p>
        <button type="button" class="btn-submit" style="max-width: 220px; margin: 0 auto;" onclick="switchMainTab('profile')">অ্যাকাউন্ট লগইন / তৈরি</button>
      </div>

      <div style="background: #292524; border: 1px solid var(--sbf-border); border-radius: var(--radius-md); padding: 18px;">
        <h4 style="color: #fbbf24; font-size: 1rem; margin-bottom: 10px;">🔍 যেকোনো অর্ডার ট্র্যাক করুন</h4>
        <div class="form-group">
          <label class="form-label" style="font-size: 0.8rem;">অর্ডার নম্বর (যেমন: SB-123456-789)</label>
          <input type="text" id="inlineTrackOrder" class="form-control" placeholder="SB-XXXXXX-XXX">
        </div>
        <div class="form-group">
          <label class="form-label" style="font-size: 0.8rem;">অর্ডারে দেওয়া মোবাইল নম্বর</label>
          <input type="tel" id="inlineTrackPhone" class="form-control" placeholder="01XXXXXXXXX">
        </div>
        <button type="button" class="btn-submit" onclick="inlineTrackOrderSubmit()">অর্ডার ট্র্যাক করুন</button>
        <div id="inlineTrackResult" style="margin-top: 14px;"></div>
      </div>
    `;
    return;
  }

  container.innerHTML = '<div style="text-align: center; padding: 40px; color: #a1a1aa;"><span class="spinner"></span> আপনার অর্ডারের তালিকা লোড হচ্ছে...</div>';

  try {
    const res = await fetch(api('/api/orders/my-orders'), {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const data = await res.json();

    if (!data.success) {
      container.innerHTML = `<div style="color: #ef4444; padding: 20px; text-align: center;">${escapeAppHtml(data.message)}</div>`;
      return;
    }

    const orders = data.orders || [];
    const orderCountLabel = hasResellerAccess() ? 'মোট অর্ডার ও বিক্রি' : 'মোট অর্ডার';
    const customerLabel = hasResellerAccess() ? 'ক্রেতা' : 'নাম';

    let ordersHtml = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px;">
        <span style="font-size: 0.9rem; color: #d4d4d8;">${orderCountLabel}: <strong>${orders.length}টি</strong></span>
        <button type="button" class="btn-nav" style="padding: 6px 12px; font-size: 0.78rem;" onclick="loadOrdersView()">🔄 রিফ্রেশ</button>
      </div>
    `;

    if (orders.length === 0) {
      ordersHtml += `
        <div style="background: #1c1917; border: 1px solid var(--sbf-border); border-radius: var(--radius-md); padding: 30px; text-align: center;">
          <div style="font-size: 2rem; margin-bottom: 10px;">🛒</div>
          <h4 style="color: #fff; margin-bottom: 6px;">এখনও কোনো অর্ডার আসেনি</h4>
          <p style="font-size: 0.85rem; color: #a1a1aa; margin-bottom: 14px;">আপনার করা অর্ডার এখানে দেখা যাবে। পণ্য দেখতে ক্যাটালগে যান।</p>
          <button type="button" class="btn-submit" style="max-width: 200px; margin: 0 auto;" onclick="switchMainTab('shop')">পণ্য দেখতে যান</button>
        </div>
      `;
    } else {
      ordersHtml += orders.map((o) => `
        <article class="reseller-order-card" style="background: #27272a; border: 1px solid #3f3f46; border-radius: 12px; padding: 14px; margin-bottom: 12px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <strong style="color: #fff; font-size: 0.95rem;">#${escapeAppHtml(o.order_number)}</strong>
            <span style="background: ${getStatusBadgeBg(o.status)}; color: #fff; padding: 3px 10px; border-radius: 20px; font-size: 0.74rem; font-weight: 700;">
              ${escapeAppHtml(getStatusInBangla(o.status))}
            </span>
          </div>
          <div style="font-size: 0.85rem; color: #d4d4d8; margin-bottom: 6px;">
            <span>${customerLabel}: <strong>${escapeAppHtml(o.customer_name)}</strong></span> • <span>${escapeAppHtml(o.customer_phone)}</span>
          </div>
          ${(o.items && o.items.length) ? `
            <div style="background: #18181b; padding: 8px 10px; border-radius: 6px; font-size: 0.8rem; color: #a1a1aa; margin-bottom: 8px;">
              ${o.items.map(it => `${escapeAppHtml(it.title)} × ${escapeAppHtml(it.quantity)}`).join('<br>')}
            </div>
          ` : ''}
          <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid #3f3f46; padding-top: 8px; font-size: 0.88rem;">
            <span>অর্ডার মোট: <strong>${escapeAppHtml(o.total_amount)}৳</strong></span>
            ${hasResellerAccess() ? `<span class="badge-profit-pill">কমিশন: ৳${escapeAppHtml(o.reseller_commission || 0)}</span>` : ''}
          </div>
        </article>
      `).join('');
    }

    container.innerHTML = ordersHtml;
  } catch (err) {
    console.error(err);
    container.innerHTML = '<div style="color: #ef4444; text-align: center; padding: 20px;">অর্ডার তালিকা লোড ব্যর্থ হয়েছে।</div>';
  }
}

// Inline tracking submit for orders view
async function inlineTrackOrderSubmit() {
  const orderNum = (document.getElementById('inlineTrackOrder') ? document.getElementById('inlineTrackOrder').value : '').trim().toUpperCase();
  const phone = (document.getElementById('inlineTrackPhone') ? document.getElementById('inlineTrackPhone').value : '').trim();
  const resContainer = document.getElementById('inlineTrackResult');
  if (!orderNum || !phone) return alert('অর্ডার নম্বর ও ফোন নম্বর প্রদান করুন');

  if (resContainer) resContainer.innerHTML = '<div style="text-align: center; color: #a1a1aa;"><span class="spinner"></span> খোঁজা হচ্ছে...</div>';
  try {
    const res = await fetch(api('/api/orders/track'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order_number: orderNum, phone })
    });
    const data = await res.json();
    if (data.success && data.order) {
      renderSingleOrderTracking(data.order, resContainer);
    } else {
      if (resContainer) resContainer.innerHTML = `<div style="color: #ef4444; text-align: center;">${escapeAppHtml(data.message || 'অর্ডার পাওয়া যায়নি')}</div>`;
    }
  } catch (err) {
    if (resContainer) resContainer.innerHTML = '<div style="color: #ef4444; text-align: center;">ট্র্যাকিং ব্যর্থ হয়েছে।</div>';
  }
}

// 2. Wallet View Loader
async function loadWalletView() {
  const container = document.getElementById('walletViewContent');
  if (!container) return;

  if (!currentUser || !authToken) {
    container.innerHTML = `
      <div style="background: #1c1917; border: 1px solid var(--sbf-border); border-radius: var(--radius-md); padding: 24px; text-align: center;">
        <div style="font-size: 2.2rem; margin-bottom: 8px;">💰</div>
        <h3 style="color: #fff; font-size: 1.15rem; margin-bottom: 6px;">রিসেলার ওয়ালেটে প্রবেশ করুন</h3>
        <p style="font-size: 0.85rem; color: #a1a1aa; margin-bottom: 14px;">বিকাশ ও নগদে সরাসরি কমিশন ক্যাশআউট করতে আপনার অ্যাকাউন্টে লগইন করুন।</p>
        <button type="button" class="btn-submit" style="max-width: 220px; margin: 0 auto;" onclick="switchMainTab('profile')">লগইন / রেজিস্ট্রেশন</button>
      </div>
    `;
    return;
  }

  if (!hasResellerAccess()) {
    container.innerHTML = `
      <div style="background:#1c1917; border:1px solid var(--sbf-border); border-radius:var(--radius-md); padding:24px; text-align:center;">
        <h3 style="color:#fff; font-size:1.1rem; margin-bottom:6px;">রিসেলার অনুমতি প্রয়োজন</h3>
        <p style="font-size:.85rem; color:#a1a1aa;">অ্যাডমিন রিসেলার অনুমতি দিলে কমিশন ও ক্যাশআউট এখানে দেখা যাবে।</p>
      </div>
    `;
    return;
  }

  container.innerHTML = '<div style="text-align: center; padding: 40px; color: #a1a1aa;"><span class="spinner"></span> ওয়ালেট হিসাব লোড হচ্ছে...</div>';

  try {
    const [summaryRes, txRes] = await Promise.all([
      fetch(api('/api/wallet/summary'), { headers: { Authorization: `Bearer ${authToken}` } }),
      fetch(api('/api/wallet/transactions'), { headers: { Authorization: `Bearer ${authToken}` } })
    ]);
    const summaryData = await summaryRes.json();
    const txData = await txRes.json();

    if (!summaryData.success) {
      container.innerHTML = `<div style="color: #ef4444; text-align: center; padding: 20px;">${escapeAppHtml(summaryData.message)}</div>`;
      return;
    }

    const s = summaryData.summary;
    const transactions = (txData.success && txData.transactions) ? txData.transactions : [];

    container.innerHTML = `
      <!-- Big 3 Wallet KPI Cards -->
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 16px;">
        <div style="background: linear-gradient(135deg, #064e3b, #047857); border-radius: 14px; padding: 14px; color: #fff;">
          <div style="font-size: 0.8rem; color: #a7f3d0; margin-bottom: 4px;">উত্তোলনযোগ্য ব্যালেন্স</div>
          <div style="font-size: 1.5rem; font-weight: 800;">${escapeAppHtml(s.available_balance)} ৳</div>
          <div style="font-size: 0.72rem; color: #d1fae5; margin-top: 2px;">✓ সরাসরি ক্যাশআউট করা যাবে</div>
        </div>
        <div style="background: linear-gradient(135deg, #78350f, #b45309); border-radius: 14px; padding: 14px; color: #fff;">
          <div style="font-size: 0.8rem; color: #fde68a; margin-bottom: 4px;">পেন্ডিং কমিশন</div>
          <div style="font-size: 1.5rem; font-weight: 800;">${escapeAppHtml(s.pending_commission)} ৳</div>
          <div style="font-size: 0.72rem; color: #fef3c7; margin-top: 2px;">⏳ ডেলিভারির পর যোগ হবে</div>
        </div>
        <div style="background: linear-gradient(135deg, #1e3a8a, #1d4ed8); border-radius: 14px; padding: 14px; color: #fff;">
          <div style="font-size: 0.8rem; color: #bfdbfe; margin-bottom: 4px;">মোট অর্জিত আয়</div>
          <div style="font-size: 1.5rem; font-weight: 800;">${escapeAppHtml(s.total_earned)} ৳</div>
          <div style="font-size: 0.72rem; color: #dbeafe; margin-top: 2px;">উত্তোলিত: ${escapeAppHtml(s.total_withdrawn)} ৳</div>
        </div>
      </div>

      <!-- Cashout Request Card -->
      <div style="background: #1c1917; border: 1px solid var(--sbf-border); border-radius: var(--radius-md); padding: 16px; margin-bottom: 16px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
          <h4 style="color: #fbbf24; font-size: 0.95rem; margin: 0;">💸 ক্যাশআউট রিকোয়েস্ট (বিকাশ / নগদ / রকেট)</h4>
          <span style="font-size: 0.75rem; color: #a1a1aa;">ন্যূনতম: ${escapeAppHtml(s.min_cashout)} ৳</span>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
          <div class="form-group">
            <label class="form-label" style="font-size: 0.8rem;">টাকার পরিমাণ (৳)</label>
            <input type="number" id="inlinePayoutAmount" class="form-control" min="${escapeAppHtml(s.min_cashout)}" placeholder="যেমন ৫০০">
          </div>
          <div class="form-group">
            <label class="form-label" style="font-size: 0.8rem;">পেমেন্ট মেথড</label>
            <select id="inlinePayoutMethod" class="form-control">
              <option value="bkash">বিকাশ (bKash)</option>
              <option value="nagad">নগদ (Nagad)</option>
              <option value="rocket">রকেট (Rocket)</option>
            </select>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label" style="font-size: 0.8rem;">টাকা গ্রহণের মোবাইল নম্বর</label>
          <input type="tel" id="inlinePayoutAccount" class="form-control" placeholder="01XXXXXXXXX" value="${escapeAppHtml(currentUser.payout_number || currentUser.phone || '')}">
        </div>
        <button type="button" class="btn-submit" onclick="submitInlinePayout(${s.available_balance})">টাকা তোলার রিকোয়েস্ট পাঠান</button>
      </div>

      <!-- Transaction History Table -->
      <div style="background: #27272a; border: 1px solid #3f3f46; border-radius: 12px; padding: 14px;">
        <h4 style="color: #fff; font-size: 0.95rem; margin-bottom: 10px;">📜 সাম্প্রতিক লেনদেন হিস্ট্রি</h4>
        ${transactions.length === 0 ? '<div style="color: #a1a1aa; font-size: 0.85rem; text-align: center; padding: 14px;">কোনো লেনদেন রেকর্ড নেই</div>' : `
          <div style="display: flex; flex-direction: column; gap: 8px;">
            ${transactions.map((tx) => {
              const isCredit = tx.type === 'commission' || tx.type === 'referral_commission' || tx.type === 'referral_bonus' || tx.type === 'team_bonus';
              const sign = isCredit ? '+' : '-';
              const color = isCredit ? '#34d399' : '#f87171';
              return `
                <div style="display: flex; justify-content: space-between; align-items: center; background: #18181b; padding: 10px 12px; border-radius: 8px; font-size: 0.82rem;">
                  <div>
                    <div style="font-weight: 600; color: #fff;">${escapeAppHtml(tx.notes || (isCredit ? 'কমিশন আয়' : 'ক্যাশআউট'))}</div>
                    <div style="font-size: 0.72rem; color: #a1a1aa;">${escapeAppHtml(new Date(tx.created_at).toLocaleDateString('bn-BD'))} • স্ট্যাটাস: ${escapeAppHtml(getStatusInBangla(tx.status))}</div>
                  </div>
                  <div style="font-weight: 700; font-size: 0.95rem; color: ${color};">
                    ${sign}${escapeAppHtml(tx.amount)} ৳
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        `}
      </div>
    `;
  } catch (err) {
    console.error(err);
    container.innerHTML = '<div style="color: #ef4444; text-align: center; padding: 20px;">ওয়ালেট লোড ব্যর্থ হয়েছে।</div>';
  }
}

// Inline payout submit
async function submitInlinePayout(availableBalance) {
  const amtInput = document.getElementById('inlinePayoutAmount');
  const methodSelect = document.getElementById('inlinePayoutMethod');
  const accInput = document.getElementById('inlinePayoutAccount');

  const amount = parseFloat(amtInput ? amtInput.value : 0);
  const payment_method = methodSelect ? methodSelect.value : 'bkash';
  const account_number = (accInput ? accInput.value : '').trim();

  if (isNaN(amount) || amount < 100) return alert('ন্যূনতম ক্যাশআউট ১০০ টাকা');
  if (amount > availableBalance) return alert(`পর্যাপ্ত ব্যালেন্স নেই। আপনার উত্তোলনযোগ্য ব্যালেন্স ${availableBalance} টাকা।`);
  if (!account_number || !/^01[3-9]\d{8}$/.test(account_number.replace(/\D/g, ''))) {
    return alert('সঠিক ১১ ডিজিটের মোবাইল নম্বর দিন');
  }

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
      alert(data.message);
      loadWalletView();
    } else {
      alert(`ত্রুটি: ${data.message}`);
    }
  } catch (err) {
    console.error(err);
    alert('ক্যাশআউট রিকোয়েস্ট পাঠাতে ব্যর্থ হয়েছে');
  }
}

// 3. Profile View Loader
function loadProfileView() {
  const container = document.getElementById('profileViewContent');
  if (!container) return;

  if (!currentUser || !authToken) {
    // Show Login & Register forms
    container.innerHTML = `
      <div style="background: #1c1917; border: 1px solid var(--sbf-border); border-radius: var(--radius-md); padding: 18px; max-width: 480px; margin: 0 auto;">
        <div style="display: flex; gap: 8px; margin-bottom: 16px;">
          <button type="button" id="tabLoginBtn" class="tab-btn active" style="flex: 1;" onclick="toggleAuthTab('login')">লগইন</button>
          <button type="button" id="tabRegBtn" class="tab-btn" style="flex: 1;" onclick="toggleAuthTab('register')">নতুন রেজিস্ট্রেশন</button>
        </div>

        <!-- Login Form -->
        <div id="inlineLoginForm">
          <div class="form-group">
            <label class="form-label" style="font-size: 0.8rem;">মোবাইল নম্বর (১১ ডিজিট)</label>
            <input type="tel" id="inLoginPhone" class="form-control" placeholder="01XXXXXXXXX">
          </div>
          <div class="form-group">
            <label class="form-label" style="font-size: 0.8rem;">পাসওয়ার্ড</label>
            <input type="password" id="inLoginPass" class="form-control" placeholder="আপনার পাসওয়ার্ড">
          </div>
          <button type="button" class="btn-submit" onclick="submitInlineLogin()">লগইন করুন</button>
        </div>

        <!-- Register Form -->
        <div id="inlineRegForm" style="display: none;">
          <div class="form-group">
            <label class="form-label" style="font-size: 0.8rem;">আপনার পূর্ণ নাম *</label>
            <input type="text" id="inRegName" class="form-control" placeholder="যেমন: মো: শাহীন">
          </div>
          <div class="form-group">
            <label class="form-label" style="font-size: 0.8rem;">মোবাইল নম্বর (১১ ডিজিট) *</label>
            <input type="tel" id="inRegPhone" class="form-control" placeholder="01XXXXXXXXX">
          </div>
          <div class="form-group">
            <label class="form-label" style="font-size: 0.8rem;">পাসওয়ার্ড (কমপক্ষে ৮ অক্ষর) *</label>
            <input type="password" id="inRegPass" class="form-control" placeholder="পাসওয়ার্ড দিন">
          </div>
          <div class="form-group">
            <label class="form-label" style="font-size: 0.8rem;">রেফারেল কোড (ঐচ্ছিক)</label>
            <input type="text" id="inRegRef" class="form-control" placeholder="কোড থাকলে লিখুন" value="${escapeAppHtml(localStorage.getItem('sb_ref_code') || '')}">
          </div>
          <button type="button" class="btn-submit" onclick="submitInlineRegister()">অ্যাকাউন্ট তৈরি করুন</button>
        </div>
      </div>
    `;
    return;
  }

  if (!hasResellerAccess()) {
    container.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:14px; max-width:600px; margin:0 auto;">
        <div style="background:#27272a; border:1px solid #3f3f46; border-radius:14px; padding:16px;">
          <h3 style="color:#fff; font-size:1.05rem; margin:0 0 8px;">${escapeAppHtml(currentUser.name)}</h3>
          <div style="font-size:.85rem; color:#a1a1aa;">📞 ${escapeAppHtml(currentUser.phone)}</div>
          <span class="badge" style="display:inline-block; margin-top:8px; background:#10b981; color:#fff; font-size:.72rem; padding:3px 8px;">কাস্টমার অ্যাকাউন্ট</span>
          <p style="font-size:.85rem; color:#d4d4d8; margin:12px 0 0;">আপনি পণ্য কিনতে পারবেন। রিসেলার হিসেবে কমিশন দেখতে ও পণ্য শেয়ার করতে অ্যাডমিনের অনুমতি প্রয়োজন।</p>
          <div style="display:flex; gap:8px; margin-top:12px;">
            <button type="button" class="btn-submit" onclick="switchMainTab('orders')">আমার অর্ডার</button>
            <button type="button" class="btn-nav" onclick="switchMainTab('shop')">পণ্য দেখুন</button>
          </div>
        </div>
        <div style="background:#27272a; border:1px solid #3f3f46; border-radius:14px; padding:16px;">
          <h4 style="color:#fff; font-size:.95rem; margin-bottom:10px;">🔒 পাসওয়ার্ড পরিবর্তন</h4>
          <div class="form-group"><label class="form-label" for="inlineOldPass">বর্তমান পাসওয়ার্ড</label><input type="password" id="inlineOldPass" class="form-control" autocomplete="current-password"></div>
          <div class="form-group"><label class="form-label" for="inlineNewPass">নতুন পাসওয়ার্ড (কমপক্ষে ৮ অক্ষর)</label><input type="password" id="inlineNewPass" class="form-control" autocomplete="new-password"></div>
          <button type="button" class="btn-submit" onclick="submitInlinePasswordChange()">পাসওয়ার্ড আপডেট করুন</button>
        </div>
        <button type="button" class="btn-submit" style="background:#7f1d1d; color:#fecaca;" onclick="resellerLogout()">অ্যাকাউন্ট থেকে লগআউট</button>
      </div>
    `;
    return;
  }

  // Profile Dashboard View
  const refLink = `${window.location.origin}/?ref=${currentUser.referral_code || ''}`;
  container.innerHTML = `
    <div style="display: flex; flex-direction: column; gap: 14px; max-width: 600px; margin: 0 auto;">
      <!-- Profile Card -->
      <div style="background: #27272a; border: 1px solid #3f3f46; border-radius: 14px; padding: 16px;">
        <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
          <div style="width: 52px; height: 52px; border-radius: 50%; background: #b45309; color: #fff; font-size: 1.5rem; display: flex; align-items: center; justify-content: center; font-weight: 700;">
            ${escapeAppHtml(currentUser.name.charAt(0))}
          </div>
          <div>
            <h3 style="color: #fff; font-size: 1.1rem; margin: 0;">${escapeAppHtml(currentUser.name)}</h3>
            <div style="font-size: 0.82rem; color: #a1a1aa;">📞 ${escapeAppHtml(currentUser.phone)}</div>
            <div style="display: flex; gap: 6px; margin-top: 4px;">
              <span class="badge" style="background: #059669; color: #fff; font-size: 0.68rem; padding: 2px 6px;">রিসেলার</span>
              <span class="badge" style="background: rgba(16, 185, 129, 0.2); color: #34d399; font-size: 0.68rem; padding: 2px 6px;">অ্যাকাউন্ট সক্রিয়</span>
            </div>
          </div>
        </div>

        <!-- Referral Link Card -->
        <div style="background: #18181b; border: 1px solid rgba(245, 158, 11, 0.25); border-radius: 10px; padding: 12px; margin-top: 10px;">
          <div style="font-size: 0.8rem; font-weight: 700; color: #fbbf24; margin-bottom: 4px;">🔗 আপনার পার্সোনাল রেফারেল লিংক</div>
          <div style="display: flex; gap: 8px;">
            <input type="text" readonly value="${escapeAppHtml(refLink)}" class="form-control" style="font-size: 0.78rem;" id="inlineRefLink">
            <button type="button" class="btn-nav" style="background: var(--sbf-amber); white-space: nowrap; padding: 6px 12px;" onclick="copyInlineRefLink()">কপি</button>
          </div>
          <div style="font-size: 0.76rem; color: #a1a1aa; margin-top: 6px;">রেফারেল কোড: <strong style="color: #fff;">${escapeAppHtml(currentUser.referral_code || '')}</strong></div>
        </div>
      </div>

      <!-- Payout Settings Card -->
      <div style="background: #27272a; border: 1px solid #3f3f46; border-radius: 14px; padding: 16px;">
        <h4 style="color: #fbbf24; font-size: 0.95rem; margin-bottom: 10px;">📱 স্থায়ী ক্যাশআউট অ্যাকাউন্ট সেটিংস</h4>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
          <div class="form-group">
            <label class="form-label" style="font-size: 0.8rem;">পেমেন্ট মেথড</label>
            <select id="setPayoutMethod" class="form-control">
              <option value="bkash" ${currentUser.payout_method === 'bkash' ? 'selected' : ''}>বিকাশ (bKash)</option>
              <option value="nagad" ${currentUser.payout_method === 'nagad' ? 'selected' : ''}>নগদ (Nagad)</option>
              <option value="rocket" ${currentUser.payout_method === 'rocket' ? 'selected' : ''}>রকেট (Rocket)</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label" style="font-size: 0.8rem;">মোবাইল নম্বর</label>
            <input type="tel" id="setPayoutNumber" class="form-control" placeholder="01XXXXXXXXX" value="${escapeAppHtml(currentUser.payout_number || '')}">
          </div>
        </div>
        <button type="button" class="btn-submit" style="padding: 10px;" onclick="savePayoutSettings()">ক্যাশআউট তথ্য সংরক্ষণ করুন</button>
      </div>

      <!-- Security & Password -->
      <div style="background: #27272a; border: 1px solid #3f3f46; border-radius: 14px; padding: 16px;">
        <h4 style="color: #fff; font-size: 0.95rem; margin-bottom: 10px;">🔒 পাসওয়ার্ড পরিবর্তন</h4>
        <div class="form-group">
          <label class="form-label" style="font-size: 0.8rem;">বর্তমান পাসওয়ার্ড</label>
          <input type="password" id="inlineOldPass" class="form-control" placeholder="পুরাতন পাসওয়ার্ড">
        </div>
        <div class="form-group">
          <label class="form-label" style="font-size: 0.8rem;">নতুন পাসওয়ার্ড (কমপক্ষে ৮ অক্ষর)</label>
          <input type="password" id="inlineNewPass" class="form-control" placeholder="নতুন পাসওয়ার্ড">
        </div>
        <button type="button" class="btn-submit" style="background: #3f3f46; padding: 10px;" onclick="submitInlinePasswordChange()">পাসওয়ার্ড আপডেট করুন</button>
      </div>

      <!-- Logout Button -->
      <button type="button" class="btn-submit" style="background: #7f1d1d; color: #fecaca; padding: 12px; margin-top: 6px;" onclick="resellerLogout()">
        🚪 অ্যাকাউন্ট থেকে লগআউট
      </button>
    </div>
  `;
}

function copyInlineRefLink() {
  const link = document.getElementById('inlineRefLink');
  if (link) {
    navigator.clipboard.writeText(link.value);
    showToast('✅ রেফারেল লিংক কপি হয়েছে!');
  }
}

async function savePayoutSettings() {
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
      alert(data.message);
    }
  } catch (e) {
    alert('সেটিংস সংরক্ষণ ব্যর্থ হয়েছে');
  }
}

async function submitInlinePasswordChange() {
  const old_password = (document.getElementById('inlineOldPass') ? document.getElementById('inlineOldPass').value : '').trim();
  const new_password = (document.getElementById('inlineNewPass') ? document.getElementById('inlineNewPass').value : '').trim();
  if (!old_password || !new_password) return alert('সকল ফিল্ড পূরণ করুন');
  if (new_password.length < 8) return alert('নতুন পাসওয়ার্ড কমপক্ষে ৮ অক্ষরের হতে হবে');

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
      alert('✅ পাসওয়ার্ড সফলভাবে আপডেট হয়েছে!');
      loadProfileView();
    } else {
      alert(data.message);
    }
  } catch (e) {
    alert('পাসওয়ার্ড আপডেট ব্যর্থ হয়েছে');
  }
}

function toggleAuthTab(type) {
  const isLogin = type === 'login';
  const loginForm = document.getElementById('inlineLoginForm');
  const regForm = document.getElementById('inlineRegForm');
  const loginBtn = document.getElementById('tabLoginBtn');
  const regBtn = document.getElementById('tabRegBtn');

  if (loginForm) loginForm.style.display = isLogin ? 'block' : 'none';
  if (regForm) regForm.style.display = isLogin ? 'none' : 'block';
  if (loginBtn) loginBtn.classList.toggle('active', isLogin);
  if (regBtn) regBtn.classList.toggle('active', !isLogin);
}

async function submitInlineLogin() {
  const phone = (document.getElementById('inLoginPhone') ? document.getElementById('inLoginPhone').value : '').trim();
  const password = (document.getElementById('inLoginPass') ? document.getElementById('inLoginPass').value : '').trim();
  if (!phone || !password) return alert('ফোন নম্বর ও পাসওয়ার্ড দিন');

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
      alert(data.message);
    }
  } catch (err) {
    alert('লগইন ব্যর্থ হয়েছে');
  }
}

async function submitInlineRegister() {
  const name = (document.getElementById('inRegName') ? document.getElementById('inRegName').value : '').trim();
  const phone = (document.getElementById('inRegPhone') ? document.getElementById('inRegPhone').value : '').trim();
  const password = (document.getElementById('inRegPass') ? document.getElementById('inRegPass').value : '').trim();
  const referral_code = (document.getElementById('inRegRef') ? document.getElementById('inRegRef').value : '').trim();

  if (!name || name.length < 2) return alert('সঠিক পূর্ণ নাম দিন');
  if (!/^01[3-9]\d{8}$/.test(phone.replace(/\D/g, ''))) return alert('সঠিক ১১ ডিজিটের মোবাইল নম্বর দিন');
  if (password.length < 8) return alert('পাসওয়ার্ড কমপক্ষে ৮ অক্ষরের হতে হবে');

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
      showToast('কাস্টমার অ্যাকাউন্ট তৈরি হয়েছে। রিসেল করতে অ্যাডমিনের অনুমতি লাগবে।');
      loadProfileView();
    } else {
      alert(data.message);
    }
  } catch (err) {
    alert('রেজিস্ট্রেশন ব্যর্থ হয়েছে');
  }
}
