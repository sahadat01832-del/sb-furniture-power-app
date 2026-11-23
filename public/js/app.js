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
  if (navText) {
    navText.textContent = currentUser ? currentUser.name.split(' ')[0] + ' (ওয়ালেট)' : 'রিসেলার জোন';
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

  const grandTotal = subtotal + deliveryFee;
  const advancePanel = document.getElementById('advanceProtection');
  if (advancePanel) advancePanel.style.display = 'block';

  document.getElementById('cartSubtotal').textContent = `${subtotal} ৳`;
  document.getElementById('cartDeliveryFee').textContent = `${deliveryFee} ৳`;
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
    referral_code: refCode
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
      closeModal('cartModal');

      alert(`🎉 ধন্যবাদ! আপনার অর্ডারটি সফলভাবে গ্রহণ করা হয়েছে।\nঅর্ডার নম্বর: ${data.order.order_number}\n\nআপনার সাথে দ্রুত যোগাযোগ করে ডেলিভারি কনফার্ম করা হবে।`);
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
  if (currentUser) {
    renderResellerDashboard();
  } else {
    renderResellerAuthForms();
  }
  openModal('resellerModal');
}

function renderResellerAuthForms() {
  document.getElementById('resellerModalTitle').textContent = '💼 রিসেলার লগইন ও রেজিস্ট্রেশন';
  const storedRef = localStorage.getItem('sb_ref_code') || '';
  document.getElementById('resellerModalBody').innerHTML = `
    <div style="display: flex; gap: 8px; margin-bottom: 16px;">
      <button class="tab-btn active" id="btnShowLogin" onclick="switchResellerTab('login')">লগইন</button>
      <button class="tab-btn" id="btnShowRegister" onclick="switchResellerTab('register')">নতুন রেজিস্ট্রেশন</button>
    </div>
    <div id="resellerLoginForm">
      <div class="form-group"><label class="form-label">মোবাইল নম্বর</label><input type="tel" id="resellerLoginPhone" class="form-control" placeholder="01XXXXXXXXX"></div>
      <div class="form-group"><label class="form-label">পাসওয়ার্ড</label><input type="password" id="resellerLoginPassword" class="form-control" placeholder="পাসওয়ার্ড দিন"></div>
      <button class="btn-submit" onclick="submitResellerLogin()">লগইন করুন</button>
    </div>
    <div id="resellerRegisterForm" style="display: none;">
      <div class="form-group"><label class="form-label">আপনার পূর্ণ নাম *</label><input type="text" id="regName" class="form-control" placeholder="যেমন: মো: রফিকুল ইসলাম"></div>
      <div class="form-group"><label class="form-label">মোবাইল নম্বর (১১ ডিজিট) *</label><input type="tel" id="regPhone" class="form-control" placeholder="01XXXXXXXXX"></div>
      <div class="form-group"><label class="form-label">পাসওয়ার্ড (৮ থেকে ৭২ বাইট) *</label><input type="password" id="regPassword" class="form-control" placeholder="পাসওয়ার্ড তৈরি করুন"></div>
      <div class="form-group"><label class="form-label">রেফারেল কোড (যদি থাকে)</label><input type="text" id="regRefCode" class="form-control" value="${escapeAppHtml(storedRef)}" placeholder="যেমন: SB1234ABC"></div>
      <button class="btn-submit" onclick="submitResellerRegister()">রেজিস্ট্রেশন সম্পন্ন করুন</button>
    </div>
  `;
}

function switchResellerTab(tab) {
  const isLogin = tab === 'login';
  document.getElementById('resellerLoginForm').style.display = isLogin ? 'block' : 'none';
  document.getElementById('resellerRegisterForm').style.display = isLogin ? 'none' : 'block';
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
      renderResellerDashboard();
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
      renderResellerDashboard();
      showToast('🎉 সফলভাবে রিসেলার অ্যাকাউন্ট তৈরি হয়েছে!');
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
  document.getElementById('resellerModalTitle').textContent = `💼 ${currentUser.name} — ড্যাশবোর্ড`;
  const body = document.getElementById('resellerModalBody');
  body.innerHTML = '<div style="text-align: center; padding: 20px;">ওয়ালেট লোড হচ্ছে...</div>';

  try {
    const res = await fetch(api('/api/wallet/summary'), {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const data = await res.json();

    if (!data.success) {
      body.innerHTML = `<div style="color: var(--sbp-red);">${escapeAppHtml(data.message)}</div>`;
      return;
    }

    const s = data.summary;
    const refLink = `${window.location.origin}/?ref=${s.referral_code}`;

    body.innerHTML = `
      <div class="referral-share-box">
        <div style="font-size: 0.88rem; font-weight: 700; color: #fde68a;">🛍️ পণ্য শেয়ার লিংক — সফল বিক্রিতে পণ্যভিত্তিক কমিশন</div>
        <div class="ref-link-row">
          <input type="text" readonly value="${escapeAppHtml(refLink)}" class="ref-link-input" id="myRefLinkInput">
          <button class="btn-nav" style="background: var(--sbf-amber); padding: 4px 10px;" onclick="copyReferralLink()">কপি</button>
        </div>
        <div style="font-size: 0.75rem; color: #a8a29e; margin-top: 6px;">আপনার শেয়ার কোড: <strong style="color: #fff;">${escapeAppHtml(s.referral_code)}</strong></div>
      </div>
      <div class="wallet-cards-grid">
        <div class="wallet-stat-card"><div class="wallet-stat-title">উত্তোলনযোগ্য ব্যালেন্স</div><div class="wallet-stat-amount green">${escapeAppHtml(s.available_balance)} ৳</div></div>
        <div class="wallet-stat-card"><div class="wallet-stat-title">পেন্ডিং কমিশন</div><div class="wallet-stat-amount">${escapeAppHtml(s.pending_commission)} ৳</div></div>
        <div class="wallet-stat-card"><div class="wallet-stat-title">মোট অর্জিত আয়</div><div class="wallet-stat-amount">${escapeAppHtml(s.total_earned)} ৳</div></div>
        <div class="wallet-stat-card"><div class="wallet-stat-title">মোট ক্যাশআউট সম্পন্ন</div><div class="wallet-stat-amount">${escapeAppHtml(s.total_withdrawn)} ৳</div></div>
      </div>
      <div style="background: #292524; padding: 14px; border-radius: var(--radius-sm); margin-bottom: 14px;">
        <h4 style="font-size: 0.95rem; color: #fff; margin-bottom: 8px;">💸 বিকাশ / নগদ / রকেট ক্যাশআউট</h4>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px;">
          <div><label class="form-label" style="font-size: 0.75rem;">টাকার পরিমাণ (মিনিমাম ${escapeAppHtml(s.min_cashout)}৳)</label><input type="number" id="payoutAmount" class="form-control" placeholder="যেমন: 500"></div>
          <div><label class="form-label" style="font-size: 0.75rem;">পেমেন্ট মেথড</label><select id="payoutMethod" class="form-control"><option value="bkash">bKash (বিকাশ)</option><option value="nagad">Nagad (নগদ)</option><option value="rocket">Rocket (রকেট)</option></select></div>
        </div>
        <div class="form-group"><label class="form-label" style="font-size: 0.75rem;">অ্যাকাউন্ট মোবাইল নম্বর</label><input type="tel" id="payoutAccount" class="form-control" placeholder="01XXXXXXXXX"></div>
        <button class="btn-submit" style="margin-top: 4px; padding: 8px;" onclick="requestPayout()">ক্যাশআউট রিকোয়েস্ট পাঠান</button>
      </div>

      <div style="display: flex; gap: 6px; flex-wrap: wrap; justify-content: space-between; align-items: center; margin-top: 10px;">
        <button class="btn-nav" style="padding: 6px 10px; font-size: 0.8rem;" onclick="showMyOrders()">📦 সেলস ও অর্ডার</button>
        <button class="btn-nav" style="padding: 6px 10px; font-size: 0.8rem;" onclick="showResellerNotifications()">🔔 নোটিশ <span id="resellerNotifBadge" class="badge" style="display:none; position:static; margin-left:2px; font-size:0.7rem;">0</span></button>
        <button class="btn-nav" style="padding: 6px 10px; font-size: 0.8rem;" onclick="showChangePasswordForm()">🔑 পাসওয়ার্ড</button>
        <button class="btn-nav" style="padding: 6px 10px; font-size: 0.8rem; color: var(--sbp-red);" onclick="resellerLogout()">লগআউট</button>
      </div>
      <div id="resellerSubContent" style="margin-top: 14px;"></div>
    `;
    fetch(api('/api/auth/notifications'), { headers: { Authorization: `Bearer ${authToken}` } })
      .then(r => r.json())
      .then(d => { if (d.success && d.unread_count) updateNotificationBadge(d.unread_count); })
      .catch(() => {});
  } catch (err) {
    console.error(err);
    body.innerHTML = '<div style="color: var(--sbp-red);">ওয়ালেট লোড করতে ব্যর্থ হয়েছে।</div>';
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
  subContent.innerHTML = '<div style="text-align: center; font-size: 0.85rem;"><span class="spinner"></span> সেলস লোড হচ্ছে...</div>';

  try {
    const res = await fetch(api('/api/orders/reseller-sales'), {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const data = await res.json();

    if (!data.success || data.orders.length === 0) {
      subContent.innerHTML = '<div style="text-align: center; color: var(--sbf-text-muted); font-size: 0.85rem; padding: 12px;">এখনও কোনো অর্ডার সম্পন্ন হয়নি।</div>';
      return;
    }

    subContent.innerHTML = `
      <h4 style="font-size: 0.9rem; color: #fff; margin-bottom: 8px;">আপনার রেফার করা অর্ডারের তালিকা:</h4>
      ${data.orders.map((o) => `
        <div style="background: #1c1917; border: 1px solid var(--sbf-border); padding: 8px 10px; border-radius: var(--radius-sm); margin-bottom: 6px; font-size: 0.8rem;">
          <div style="display: flex; justify-content: space-between;">
            <strong>#${escapeAppHtml(o.order_number)}</strong>
            <span style="color: ${o.status === 'delivered' ? '#10b981' : '#f59e0b'}; font-weight: 700;">
              ${escapeAppHtml(getStatusInBangla(o.status))}
            </span>
          </div>
          <div style="color: var(--sbf-text-muted);">ক্রেতা: ${escapeAppHtml(o.customer_name)} (${escapeAppHtml(o.customer_phone)})</div>
          ${(o.items && o.items.length) ? `<div style="font-size: 0.74rem; color: #a8a29e; margin-top: 2px;">পণ্য: ${o.items.map(it => `${escapeAppHtml(it.title)} × ${escapeAppHtml(it.quantity)}`).join(', ')}</div>` : ''}
          <div style="display: flex; justify-content: space-between; margin-top: 4px;">
            <span>মোট: ${escapeAppHtml(o.total_amount)}৳</span>
            <span style="color: #10b981; font-weight: 700;">কমিশন: ${escapeAppHtml(o.reseller_commission || 0)}৳</span>
          </div>
        </div>
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
    <div style="background: #1c1917; border: 1px solid var(--sbf-border); padding: 12px; border-radius: var(--radius-sm);">
      <h4 style="font-size: 0.9rem; color: #fff; margin-bottom: 10px;">🔑 পাসওয়ার্ড পরিবর্তন</h4>
      <div class="form-group" style="margin-bottom: 8px;">
        <label class="form-label" style="font-size: 0.75rem;">বর্তমান পাসওয়ার্ড *</label>
        <input type="password" id="oldPassInput" class="form-control" placeholder="পুরাতন পাসওয়ার্ড দিন">
      </div>
      <div class="form-group" style="margin-bottom: 8px;">
        <label class="form-label" style="font-size: 0.75rem;">নতুন পাসওয়ার্ড (৮ থেকে ৭২ বাইট) *</label>
        <input type="password" id="newPassInput" class="form-control" placeholder="নতুন পাসওয়ার্ড দিন">
      </div>
      <button class="btn-submit" style="padding: 8px;" onclick="submitChangePassword()">পাসওয়ার্ড পরিবর্তন করুন</button>
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
  localStorage.removeItem('sb_user');
  localStorage.removeItem('sb_token');
  updateAuthUI();
  renderResellerAuthForms();
  showToast('লগআউট সম্পন্ন হয়েছে');
}

// ================= NOTIFICATIONS & CUSTOMER HISTORY =================
async function showResellerNotifications() {
  const subContent = document.getElementById('resellerSubContent');
  subContent.innerHTML = '<div style="text-align: center; font-size: 0.85rem;"><span class="spinner"></span> নোটিফিকেশন লোড হচ্ছে...</div>';
  try {
    const res = await fetch(api('/api/auth/notifications'), { headers: { Authorization: `Bearer ${authToken}` } });
    const data = await res.json();
    if (!data.success || !data.notifications || data.notifications.length === 0) {
      subContent.innerHTML = '<div style="text-align: center; color: var(--sbf-text-muted); font-size: 0.85rem; padding: 12px;">আপনার কোনো নোটিফিকেশন নেই।</div>';
      return;
    }
    const unread = data.unread_count || 0;
    subContent.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
        <h4 style="font-size: 0.9rem; color: #fff; margin: 0;">🔔 নোটিফিকেশন (${data.notifications.length}):</h4>
        ${unread > 0 ? `<button class="btn-nav" style="padding: 2px 8px; font-size: 0.72rem;" onclick="markAllNotificationsRead()">সব পঠিত করুন</button>` : ''}
      </div>
      ${data.notifications.map((n) => `
        <div style="background: ${n.is_read ? '#1c1917' : 'rgba(180, 83, 9, 0.15)'}; border: 1px solid ${n.is_read ? 'var(--sbf-border)' : 'var(--sbf-amber)'}; padding: 8px 10px; border-radius: var(--radius-sm); margin-bottom: 6px; font-size: 0.8rem; cursor: pointer;" onclick="markNotificationRead(${n.id}, this)">
          <div style="display: flex; justify-content: space-between;"><strong style="color: ${n.is_read ? '#d6d3d1' : '#fde68a'};">${escapeAppHtml(n.title)}</strong><span style="font-size: 0.7rem; color: #a8a29e;">${new Date(n.created_at).toLocaleDateString('bn-BD')}</span></div>
          <div style="color: ${n.is_read ? 'var(--sbf-text-muted)' : '#fff'}; margin-top: 3px; font-size: 0.76rem;">${escapeAppHtml(n.message)}</div>
        </div>
      `).join('')}
    `;
    updateNotificationBadge(unread);
  } catch (e) {
    subContent.innerHTML = '<div style="color: var(--sbp-red); font-size: 0.85rem;">নোটিফিকেশন লোড ব্যর্থ হয়েছে</div>';
  }
}

async function markNotificationRead(id, el) {
  try {
    await fetch(api(`/api/auth/notifications/${id}/read`), { method: 'PUT', headers: { Authorization: `Bearer ${authToken}` } });
    if (el) { el.style.background = '#1c1917'; el.style.borderColor = 'var(--sbf-border)'; }
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
