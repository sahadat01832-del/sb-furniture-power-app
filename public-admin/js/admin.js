// ============================================================
// SB Furniture & SB POWER — Admin Dashboard Controller
// ============================================================

let adminToken = localStorage.getItem('sb_admin_token') || null;
let currentAdminSection = 'orders';
let adminProductsList = [];
let adminProductsPage = 1;
let adminProductStatusFilter = 'all';
const unsavedUploadedImageUrls = new Set();

const api = (path) => (typeof window.apiUrl === 'function' ? window.apiUrl(path) : path);
const escapeAdminHtml = (value) => window.sbEscapeHtml(value);
const safeAdminImageUrl = (value) => window.sbSafeImageUrl(value);
const imageCorsAttrAdmin = (safeUrl) => (typeof window.sbImageCrossOriginAttr === 'function' ? window.sbImageCrossOriginAttr(safeUrl) : '');

function setAdminPreviewSrc(previewEl, rawUrl) {
  if (!previewEl) return;
  delete previewEl.dataset.sbFallbackApplied;
  if (!rawUrl) {
    previewEl.onerror = null;
    previewEl.removeAttribute('crossorigin');
    previewEl.src = '';
    return;
  }
  const isCors = typeof window.sbImageCrossOrigin === 'function' && window.sbImageCrossOrigin(rawUrl) === 'anonymous';
  if (isCors) previewEl.crossOrigin = 'anonymous';
  else previewEl.removeAttribute('crossorigin');
  previewEl.onerror = () => window.sbHandleImageError && window.sbHandleImageError(previewEl);
  previewEl.src = rawUrl;
}
const adminStatusLabels = {
  pending: 'অপেক্ষমাণ',
  confirmed: 'নিশ্চিত',
  shipped: 'পাঠানো হয়েছে',
  delivered: 'ডেলিভারি সম্পন্ন',
  cancelled: 'বাতিল'
};
const payoutStatusLabels = { pending: 'অপেক্ষমাণ', approved: 'পরিশোধ সম্পন্ন', rejected: 'বাতিল' };

document.addEventListener('DOMContentLoaded', () => {
  if (adminToken) {
    checkAdminSession();
  } else {
    showLoginView();
  }
});

let adminToastTimer = null;

function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.toggle('is-error', type === 'error');
  toast.classList.add('show');
  if (adminToastTimer) clearTimeout(adminToastTimer);
  adminToastTimer = setTimeout(() => {
    toast.classList.remove('show', 'is-error');
  }, 3400);
}

function toggleAdminPassVisibility() {
  const input = document.getElementById('adminPassInput');
  const btn = document.getElementById('btnToggleAdminPass');
  if (!input) return;
  const nextType = input.type === 'password' ? 'text' : 'password';
  input.type = nextType;
  if (btn) {
    btn.textContent = nextType === 'text' ? 'লুকান' : 'দেখুন';
    btn.setAttribute('aria-label', nextType === 'text' ? 'পাসওয়ার্ড লুকান' : 'পাসওয়ার্ড দেখুন');
  }
}

function showLoginView() {
  document.getElementById('adminLoginSection').style.display = 'block';
  document.getElementById('adminDashboardSection').style.display = 'none';
  const error = document.getElementById('adminLoginError');
  if (error) { error.textContent = ''; error.hidden = true; }
}

function showDashboardView() {
  document.getElementById('adminLoginSection').style.display = 'none';
  document.getElementById('adminDashboardSection').style.display = 'block';
  loadAdminStats();
  switchAdminSection(currentAdminSection);
  loadShopSettings();
}

// Admin Login
async function submitAdminLogin() {
  const phone = document.getElementById('adminPhoneInput').value.trim();
  const password = document.getElementById('adminPassInput').value;
  const error = document.getElementById('adminLoginError');
  const submitBtn = document.getElementById('btnAdminLoginSubmit');
  if (error) { error.textContent = ''; error.hidden = true; }

  if (!phone || !password) {
    if (error) { error.textContent = 'ফোন নম্বর ও পাসওয়ার্ড—দুটিই লিখুন।'; error.hidden = false; }
    return;
  }

  const prevLabel = submitBtn ? submitBtn.textContent : '';
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = '⏳ যাচাই হচ্ছে...';
  }

  try {
    const res = await fetch(api('/api/auth/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, password })
    });
    const data = await res.json();

    if (data.success && data.user.role === 'admin') {
      adminToken = data.token;
      localStorage.setItem('sb_admin_token', data.token);
      localStorage.setItem('sb_admin_user', JSON.stringify(data.user));
      showDashboardView();
      showToast('👑 এডমিন লগইন সফল হয়েছে!');
    } else {
      if (error) {
        error.textContent = data.user && data.user.role !== 'admin' ? 'এই অ্যাকাউন্টে অ্যাডমিন অনুমতি নেই।' : (data.message || 'ফোন নম্বর বা পাসওয়ার্ড মিলছে না।');
        error.hidden = false;
      }
    }
  } catch (err) {
    console.error(err);
    if (error) { error.textContent = 'সার্ভারে সংযোগ হচ্ছে না। ইন্টারনেট দেখে আবার চেষ্টা করুন।'; error.hidden = false; }
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = prevLabel || 'নিরাপদে লগইন করুন';
    }
  }
}

async function checkAdminSession() {
  try {
    const res = await fetch(api('/api/admin/stats'), {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    if (res.ok) {
      showDashboardView();
    } else {
      adminLogout();
    }
  } catch (e) {
    adminLogout();
  }
}

function adminLogout() {
  adminToken = null;
  localStorage.removeItem('sb_admin_token');
  localStorage.removeItem('sb_admin_user');
  showLoginView();
  showToast('লগআউট করা হয়েছে');
}

// Switch Sections (Orders, Profit, Shops, Referrals, Payouts, Products, Analytics, Announcements, Backups, Users, Guide)
function switchAdminSection(section) {
  currentAdminSection = section;
  const select = document.getElementById('adminSectionSelect');
  if (select) select.value = section;
  const sections = ['orders', 'profit', 'shops', 'referrals', 'payouts', 'products', 'cutlists', 'analytics', 'announcements', 'backups', 'users', 'guide'];
  sections.forEach((s) => {
    const capitalized = s.charAt(0).toUpperCase() + s.slice(1);
    const secEl = document.getElementById(`admin${capitalized}Section`);
    if (secEl) {
      const isTarget = section === s;
      secEl.style.display = isTarget ? 'block' : 'none';
      if (isTarget) {
        secEl.classList.remove('admin-section-enter');
        void secEl.offsetWidth;
        secEl.classList.add('admin-section-enter');
      }
    }
    const tabEl = document.getElementById(`tabBtn${capitalized}`);
    if (tabEl) tabEl.classList.toggle('active', section === s);
  });
  const loaders = {
    orders: loadAdminOrders,
    profit: loadAdminProfitDashboard,
    shops: loadAdminShops,
    referrals: () => window.loadAdminReferrals && window.loadAdminReferrals(),
    payouts: loadAdminPayouts,
    products: loadAdminProducts,
    cutlists: loadAdminCutlistDatabase,
    analytics: loadAdminAnalytics,
    announcements: loadAdminAnnouncements,
    backups: loadAdminBackupsList,
    users: () => window.loadAdminUsers && window.loadAdminUsers(),
    guide: () => window.loadAdminContentGuide && window.loadAdminContentGuide()
  };
  if (loaders[section]) loaders[section]();
}

// Load Stats
async function loadAdminStats() {
  try {
    const res = await fetch(api('/api/admin/stats'), {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const data = await res.json();
    if (data.success) {
      const s = data.stats;
      document.getElementById('statTotalOrders').textContent = s.total_orders;
      document.getElementById('statTotalRevenue').textContent = `${s.total_revenue} ৳`;
      document.getElementById('statPendingOrders').textContent = s.pending_orders;
      document.getElementById('statDeliveredOrders').textContent = s.delivered_orders;
      document.getElementById('statTotalResellers').textContent = s.total_resellers;
      document.getElementById('statPendingPayouts').textContent = `${s.pending_payouts_count}টি (${s.pending_payouts_amount}৳)`;
    }
  } catch (err) {
    console.error('Stats Error:', err);
  }
}

let adminOrdersList = [];

// ================= SECTION 1: ORDERS =================
async function loadAdminOrders() {
  const tbody = document.getElementById('adminOrdersTableBody');
  tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; padding: 20px;">অর্ডার লোড হচ্ছে...</td></tr>';

  const status = document.getElementById('orderStatusFilter').value;

  try {
    const res = await fetch(api(`/api/admin/orders?status=${status}`), {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const data = await res.json();

    if (!data.success || data.orders.length === 0) {
      adminOrdersList = [];
      tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; padding: 20px; color: var(--sbf-text-muted);">কোনো অর্ডার নেই।</td></tr>';
      return;
    }

    adminOrdersList = data.orders;

    tbody.innerHTML = data.orders.map((o) => {
      const commissionAmount = o.total_reseller_commission !== undefined ? o.total_reseller_commission : (o.reseller_commission || 0);
      const isCommissionReleased = Boolean(o.commission_released);
      const referralCommission = Number(o.referral_commission_amount || 0);
      const referralCredit = Number(o.referral_credit_amount || 0);
      const referralDiscount = Number(o.discount_amount || 0);

      return `
      <tr>
        <td data-label="অর্ডার">
          <strong>#${escapeAdminHtml(o.order_number)}</strong>
          <br><span class="admin-cell-muted">${new Date(o.created_at).toLocaleDateString('bn-BD')}</span>
        </td>
        <td data-label="ক্রেতা">
          <strong>${escapeAdminHtml(o.customer_name)}</strong>
          <br><a href="tel:${escapeAdminHtml(String(o.customer_phone).replace(/\D/g, ''))}" style="color: #2563eb; font-weight: 600;">📞 ${escapeAdminHtml(o.customer_phone)}</a>
        </td>
        <td data-label="ডেলিভারি ঠিকানা">
          ${escapeAdminHtml(o.delivery_address)}
          <br><span class="admin-cell-muted">${o.delivery_city === 'inside_dhaka' ? 'ঢাকার ভেতরে (৮০৳)' : 'ঢাকার বাইরে (১৫০৳)'}</span>
        </td>
        <td data-label="সর্বমোট ও অগ্রিম">
          <strong style="color: #ea580c; font-size: 0.95rem;">${escapeAdminHtml(o.total_amount)} ৳</strong>
          ${referralDiscount > 0 ? `<br><span class="admin-cell-success">রেফারেল ছাড়: -${escapeAdminHtml(referralDiscount)}৳</span>` : ''}
          <br><span class="admin-cell-muted">অগ্রিম: ${escapeAdminHtml(o.advance_paid)}৳</span>
          ${o.advance_trx_id ? `<br><span class="admin-cell-success" style="font-size: 0.72rem;">Trx: ${escapeAdminHtml(o.advance_trx_id)}</span>` : ''}
        </td>
        <td data-label="লাভ ও পাইকারি">
          <span style="font-size: 0.75rem; color: #64748b;">পাইকারি: ${escapeAdminHtml(o.total_wholesale_amount || 0)}৳</span>
          <br><strong style="color: #16a34a; font-size: 0.88rem;">নিট লাভ: ${escapeAdminHtml(o.platform_net_profit || 0)} ৳</strong>
        </td>
        <td data-label="রিসেলার ও কমিশন">
          ${o.reseller_name ? `<strong>${escapeAdminHtml(o.reseller_name)}</strong><br><span class="admin-cell-muted">${escapeAdminHtml(o.reseller_phone)}</span>` : '<span class="admin-cell-muted">সরাসরি অর্ডার</span>'}
          <br><span class="admin-commission-badge" style="margin-top: 3px;">কমিশন: ${escapeAdminHtml(commissionAmount)}৳</span>
          ${referralCommission > 0 ? `<br><span class="admin-commission-badge">রেফারেল কমিশন: ${escapeAdminHtml(referralCommission)}৳</span>` : ''}
          ${referralCredit > 0 ? `<br><span class="admin-commission-badge">কাস্টমার ছাড়ের জমা: ${escapeAdminHtml(referralCredit)}৳</span>` : ''}
        </td>
        <td data-label="স্ট্যাটাস">
          <span style="background: ${getStatusBadgeBg(o.status)}; color: #fff; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: 700;">
            ${escapeAdminHtml(adminStatusLabels[o.status] || o.status)}
          </span>
          <div style="margin-top: 4px;">
            ${isCommissionReleased
              ? '<span style="background: #16a34a; color: #fff; padding: 1px 6px; border-radius: 4px; font-size: 0.68rem; font-weight: 700;">✅ কমিশন ছাড় সম্পন্ন</span>'
              : (o.status !== 'cancelled' ? '<span style="background: #d97706; color: #fff; padding: 1px 6px; border-radius: 4px; font-size: 0.68rem; font-weight: 700;">⏳ কমিশন পেন্ডিং</span>' : '')
            }
          </div>
        </td>
        <td data-label="করণীয়">
          <div style="display: flex; gap: 4px; flex-wrap: wrap; align-items: center;">
            <button class="action-btn-sm" style="background: #2563eb; color: #fff; font-weight: 600;" onclick="viewOrderDetail(${o.id})">👁️ বিস্তারিত</button>
            ${o.status === 'pending' ? `<button class="action-btn-sm btn-confirm" onclick="updateOrderStatus(${o.id}, 'confirmed')">✓ কনফার্ম</button>` : ''}
            ${['pending', 'confirmed'].includes(o.status) ? `<button class="action-btn-sm btn-ship" onclick="updateOrderStatus(${o.id}, 'shipped')">🚚 শিপড</button>` : ''}
            ${['pending', 'confirmed', 'shipped'].includes(o.status) ? `<button class="action-btn-sm btn-deliver" onclick="updateOrderStatus(${o.id}, 'delivered')">✅ ডেলিভার্ড</button>` : ''}
            ${!isCommissionReleased && o.status !== 'cancelled' && commissionAmount > 0 ? `<button class="action-btn-sm" style="background: #16a34a; color: #fff; font-weight: 700;" onclick="instantReleaseCommission(${o.id}, ${commissionAmount})">⚡ ছাড়</button>` : ''}
            ${o.status !== 'delivered' && o.status !== 'cancelled' ? `<button class="action-btn-sm btn-cancel" onclick="updateOrderStatus(${o.id}, 'cancelled')">✕ বাতিল</button>` : ''}
            <button class="action-btn-sm" style="background: #64748b; color: #fff;" onclick="viewOrderAuditTrail(${o.id})">📋 অডিট</button>
          </div>
        </td>
      </tr>
      `;
    }).join('');
  } catch (err) {
    console.error(err);
    tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--sbp-red);">লোড ব্যর্থ হয়েছে।</td></tr>';
  }
}

async function instantReleaseCommission(orderId, commissionAmount) {
  const ok = confirm(`আপনি কি এই অর্ডারের রিসেলার কমিশন (৳${commissionAmount}) তাৎক্ষণিকভাবে রিসেলারের ওয়ালেটে যুক্ত করতে চান?`);
  if (!ok) return;

  try {
    const res = await fetch(api(`/api/admin/orders/${orderId}/release-commission`), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      }
    });
    const data = await res.json();
    if (data.success) {
      showToast(data.message || '✅ কমিশন সফলভাবে ছাড় করা হয়েছে!');
      loadAdminOrders();
      loadAdminStats();
    } else {
      alert(data.message || 'কমিশন ছাড় ব্যর্থ হয়েছে');
    }
  } catch (err) {
    console.error('Release Commission Error:', err);
    alert('কমিশন ছাড় ব্যর্থ হয়েছে');
  }
}

async function updateOrderStatus(orderId, newStatus) {
  if (newStatus === 'delivered') {
    const ok = confirm('অর্ডার ডেলিভার্ড হিসেবে মার্ক করতে চান? এতে অর্ডারের সরাসরি রিসেলার কমিশন ছাড় হবে।');
    if (!ok) return;
  }

  try {
    const res = await fetch(api(`/api/admin/orders/${orderId}/status`), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({ status: newStatus })
    });
    const data = await res.json();
    if (data.success) {
      showToast(data.message);
      loadAdminOrders();
      loadAdminStats();
    } else {
      alert(data.message);
    }
  } catch (err) {
    console.error(err);
    alert('স্ট্যাটাস আপডেট ব্যর্থ হয়েছে');
  }
}

// 1-Click Customer & Order Details Modal View
function viewOrderDetail(orderId) {
  const o = adminOrdersList.find((item) => item.id === orderId);
  if (!o) {
    alert('অর্ডারের তথ্য পাওয়া যায়নি');
    return;
  }

  const titleEl = document.getElementById('orderDetailModalTitle');
  if (titleEl) titleEl.textContent = `📦 অর্ডার #${escapeAdminHtml(o.order_number)}`;

  const commissionAmount = o.total_reseller_commission !== undefined ? o.total_reseller_commission : (o.reseller_commission || 0);
  const isCommissionReleased = Boolean(o.commission_released);
  const referralCommission = Number(o.referral_commission_amount || 0);
  const referralCredit = Number(o.referral_credit_amount || 0);
  const referralDiscount = Number(o.discount_amount || 0);

  const bodyEl = document.getElementById('orderDetailModalBody');
  if (!bodyEl) return;

  const itemsList = Array.isArray(o.items) && o.items.length > 0 ? o.items : [];

  bodyEl.innerHTML = `
    <!-- Top Meta & Status Banner -->
    <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 12px 16px; margin-bottom: 16px;">
      <div>
        <div style="font-size: 0.82rem; color: #64748b;">অর্ডার তারিখ: <strong>${new Date(o.created_at).toLocaleString('bn-BD')}</strong></div>
        <div style="font-size: 0.82rem; color: #64748b; margin-top: 2px;">অর্ডার আইডি: <strong>#${escapeAdminHtml(o.id)}</strong> (${escapeAdminHtml(o.order_number)})</div>
      </div>
      <div style="text-align: right;">
        <span style="background: ${getStatusBadgeBg(o.status)}; color: #fff; padding: 4px 12px; border-radius: 6px; font-size: 0.85rem; font-weight: 700;">
          ${escapeAdminHtml(adminStatusLabels[o.status] || o.status)}
        </span>
        <div style="margin-top: 4px;">
          ${isCommissionReleased
            ? '<span style="background: #16a34a; color: #fff; padding: 2px 8px; border-radius: 4px; font-size: 0.72rem; font-weight: 700;">✅ কমিশন ছাড় সম্পন্ন</span>'
            : (o.status !== 'cancelled' ? '<span style="background: #d97706; color: #fff; padding: 2px 8px; border-radius: 4px; font-size: 0.72rem; font-weight: 700;">⏳ কমিশন পেন্ডিং</span>' : '')
          }
        </div>
      </div>
    </div>

    <!-- Customer & Delivery Card -->
    <div style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.04);">
      <h4 style="font-size: 0.95rem; color: #0f172a; margin-bottom: 12px; border-bottom: 1px solid #f1f5f9; padding-bottom: 8px;">
        👤 গ্রাহক ও ডেলিভারি বিবরণ (Customer & Delivery)
      </h4>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; font-size: 0.85rem;">
        <div>
          <span style="color: #64748b; display: block; font-size: 0.75rem;">গ্রাহকের নাম:</span>
          <strong style="color: #0f172a; font-size: 1rem;">${escapeAdminHtml(o.customer_name)}</strong>
        </div>
        <div>
          <span style="color: #64748b; display: block; font-size: 0.75rem;">ফোন নম্বর:</span>
          <div style="display: flex; gap: 8px; align-items: center; margin-top: 2px;">
            <a href="tel:${escapeAdminHtml(String(o.customer_phone).replace(/\D/g, ''))}" style="color: #2563eb; font-weight: 700; text-decoration: underline;">
              📞 ${escapeAdminHtml(o.customer_phone)}
            </a>
            <a href="https://wa.me/88${escapeAdminHtml(String(o.customer_phone).replace(/\D/g, ''))}" target="_blank" style="background: #16a34a; color: #fff; padding: 2px 8px; border-radius: 6px; font-size: 0.75rem; text-decoration: none; font-weight: 600;">
              💬 WhatsApp
            </a>
          </div>
        </div>
        <div>
          <span style="color: #64748b; display: block; font-size: 0.75rem;">ডেলিভারি এরিয়া:</span>
          <strong style="color: #334155;">${o.delivery_city === 'inside_dhaka' ? 'ঢাকার ভেতরে (ডেলিভারি ৮০৳)' : 'ঢাকার বাইরে (ডেলিভারি ১৫০৳)'}</strong>
        </div>
        <div>
          <span style="color: #64748b; display: block; font-size: 0.75rem;">সম্পূর্ণ ঠিকানা:</span>
          <strong style="color: #0f172a;">${escapeAdminHtml(o.delivery_address)}</strong>
        </div>
      </div>
      ${o.customer_notes ? `
        <div style="margin-top: 10px; padding: 8px 12px; background: #fffbeb; border: 1px solid #fef3c7; border-radius: 8px; font-size: 0.82rem; color: #92400e;">
          📝 <strong>গ্রাহকের বিশেষ নোট:</strong> ${escapeAdminHtml(o.customer_notes)}
        </div>
      ` : ''}
    </div>

    <!-- Ordered Items Table -->
    <div style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.04);">
      <h4 style="font-size: 0.95rem; color: #0f172a; margin-bottom: 12px; border-bottom: 1px solid #f1f5f9; padding-bottom: 8px;">
        🛍️ অর্ডারকৃত পণ্যের তালিকা (Ordered Products)
      </h4>
      <div class="table-responsive">
        <table>
          <thead>
            <tr>
              <th>SKU</th>
              <th>পণ্যের নাম</th>
              <th style="text-align: right;">একক মূল্য</th>
              <th style="text-align: center;">পরিমাণ</th>
              <th style="text-align: right;">মোট মূল্য</th>
            </tr>
          </thead>
          <tbody>
            ${itemsList.length > 0 ? itemsList.map((item) => `
              <tr>
                <td><strong>${escapeAdminHtml(item.product_sku || item.sku || '-')}</strong></td>
                <td>${escapeAdminHtml(item.product_title || item.title || 'পণ্য')}</td>
                <td style="text-align: right;">${escapeAdminHtml(item.unit_price || item.price || 0)} ৳</td>
                <td style="text-align: center;"><span style="background: #f1f5f9; padding: 2px 8px; border-radius: 4px; font-weight: 700;">${escapeAdminHtml(item.quantity)}টি</span></td>
                <td style="text-align: right;"><strong>${escapeAdminHtml(item.total_price || (item.unit_price * item.quantity) || 0)} ৳</strong></td>
              </tr>
            `).join('') : `
              <tr><td colspan="5" style="text-align: center; color: #64748b;">পণ্যের তথ্য পাওয়া যায়নি</td></tr>
            `}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Financial Breakdown & Reseller Commission -->
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px; margin-bottom: 18px;">
      <!-- Payment Ledger -->
      <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 14px;">
        <h5 style="font-size: 0.88rem; color: #0f172a; margin-bottom: 10px;">💳 পেমেন্ট ও ডেলিভারি হিসাব</h5>
        <div style="display: flex; justify-content: space-between; font-size: 0.82rem; margin-bottom: 6px;">
          <span style="color: #64748b;">পণ্য মূল্য (Subtotal):</span>
          <strong>${escapeAdminHtml(o.subtotal_amount || 0)} ৳</strong>
        </div>
        <div style="display: flex; justify-content: space-between; font-size: 0.82rem; margin-bottom: 6px;">
          <span style="color: #64748b;">ডেলিভারি ফি:</span>
          <strong>+${escapeAdminHtml(o.delivery_fee || 0)} ৳</strong>
        </div>
        ${referralDiscount > 0 ? `<div style="display: flex; justify-content: space-between; font-size: 0.82rem; margin-bottom: 6px; color: #15803d;"><span>ব্যবহৃত রেফারেল ছাড়:</span><strong>-${escapeAdminHtml(referralDiscount)} ৳</strong></div>` : ''}
        <div style="display: flex; justify-content: space-between; font-size: 0.88rem; margin-bottom: 6px; border-top: 1px solid #e2e8f0; padding-top: 6px;">
          <span style="font-weight: 700; color: #0f172a;">সর্বমোট অর্ডার মূল্য:</span>
          <strong style="color: #ea580c; font-size: 1rem;">${escapeAdminHtml(o.total_amount)} ৳</strong>
        </div>
        <div style="display: flex; justify-content: space-between; font-size: 0.82rem; margin-bottom: 6px;">
          <span style="color: #16a34a;">অগ্রিম পরিশোধিত:</span>
          <strong style="color: #16a34a;">-${escapeAdminHtml(o.advance_paid || 0)} ৳</strong>
        </div>
        ${o.advance_trx_id ? `
          <div style="font-size: 0.75rem; color: #059669; background: #ecfdf5; padding: 4px 8px; border-radius: 4px; margin-bottom: 6px;">
            TrxID: <strong>${escapeAdminHtml(o.advance_trx_id)}</strong>
          </div>
        ` : ''}
        <div style="display: flex; justify-content: space-between; font-size: 0.9rem; border-top: 1px dashed #cbd5e1; padding-top: 8px; margin-top: 6px;">
          <span style="font-weight: 700; color: #0f172a;">ক্যাশ অন ডেলিভারিতে প্রাপ্য:</span>
          <strong style="color: #2563eb; font-size: 1.05rem;">${escapeAdminHtml(Math.max(0, (o.total_amount || 0) - (o.advance_paid || 0)))} ৳</strong>
        </div>
      </div>

      <!-- Reseller & Profit Ledger -->
      <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 14px;">
        <h5 style="font-size: 0.88rem; color: #0f172a; margin-bottom: 10px;">📈 পাইকারি, রিসেলার ও প্ল্যাটফর্ম লাভ</h5>
        <div style="display: flex; justify-content: space-between; font-size: 0.82rem; margin-bottom: 6px;">
          <span style="color: #64748b;">মোট পাইকারি ক্রয়মূল্য:</span>
          <strong style="color: #6546a5;">${escapeAdminHtml(o.total_wholesale_amount || 0)} ৳</strong>
        </div>
        <div style="display: flex; justify-content: space-between; font-size: 0.82rem; margin-bottom: 6px;">
          <span style="color: #64748b;">অর্ডারকারী রিসেলার:</span>
          <strong>${o.reseller_name ? `${escapeAdminHtml(o.reseller_name)} (${escapeAdminHtml(o.reseller_phone)})` : 'সরাসরি বিক্রয়'}</strong>
        </div>
        <div style="display: flex; justify-content: space-between; font-size: 0.82rem; margin-bottom: 6px;">
          <span style="color: #64748b;">রিসেলার কমিশন:</span>
          <strong style="color: #d97706;">${escapeAdminHtml(commissionAmount)} ৳</strong>
        </div>
        ${referralCommission > 0 ? `<div style="display: flex; justify-content: space-between; font-size: 0.82rem; margin-bottom: 6px;"><span style="color: #64748b;">রিসেলার রেফারেল কমিশন:</span><strong style="color: #0f766e;">${escapeAdminHtml(referralCommission)} ৳</strong></div>` : ''}
        ${referralCredit > 0 ? `<div style="display: flex; justify-content: space-between; font-size: 0.82rem; margin-bottom: 6px;"><span style="color: #64748b;">কাস্টমার রেফারেল ছাড়:</span><strong style="color: #0f766e;">${escapeAdminHtml(referralCredit)} ৳</strong></div>` : ''}
        <div style="display: flex; justify-content: space-between; align-items: center; background: #ecfdf5; border: 1px solid #86efac; border-radius: 8px; padding: 10px; margin-top: 10px;">
          <span style="color: #166534; font-weight: 700; font-size: 0.85rem;">💎 প্ল্যাটফর্ম নিট লাভ:</span>
          <strong style="color: #15803d; font-size: 1.2rem;">${escapeAdminHtml(o.platform_net_profit || 0)} ৳</strong>
        </div>
      </div>
    </div>

    <!-- 1-Click Status Transition Action Bar -->
    <div style="background: #ffffff; border: 1px solid #cbd5e1; border-radius: 12px; padding: 14px; text-align: center;">
      <div style="font-size: 0.82rem; font-weight: 700; color: #334155; margin-bottom: 10px;">
        ⚡ ১-ক্লিকে স্ট্যাটাস পরিবর্তন করুন (1-Click Status Transition)
      </div>
      <div style="display: flex; gap: 8px; justify-content: center; flex-wrap: wrap;">
        ${o.status === 'pending' ? `<button class="action-btn-sm btn-confirm" style="padding: 8px 16px; font-size: 0.85rem;" onclick="updateOrderStatusAndRefreshModal(${o.id}, 'confirmed')">✓ নিশ্চিত করুন</button>` : ''}
        ${['pending', 'confirmed'].includes(o.status) ? `<button class="action-btn-sm btn-ship" style="padding: 8px 16px; font-size: 0.85rem;" onclick="updateOrderStatusAndRefreshModal(${o.id}, 'shipped')">🚚 কুরিয়ারে পাঠান (Shipped)</button>` : ''}
        ${['pending', 'confirmed', 'shipped'].includes(o.status) ? `<button class="action-btn-sm btn-deliver" style="padding: 8px 16px; font-size: 0.85rem;" onclick="updateOrderStatusAndRefreshModal(${o.id}, 'delivered')">✅ ডেলিভার্ড সম্পন্ন করুন</button>` : ''}
        ${!isCommissionReleased && o.status !== 'cancelled' && commissionAmount > 0 ? `<button class="action-btn-sm" style="background: #16a34a; color: #fff; font-weight: 700; padding: 8px 16px; font-size: 0.85rem;" onclick="instantReleaseCommissionAndRefreshModal(${o.id}, ${commissionAmount})">⚡ রিসেলার কমিশন ছাড়</button>` : ''}
        ${o.status !== 'delivered' && o.status !== 'cancelled' ? `<button class="action-btn-sm btn-cancel" style="padding: 8px 16px; font-size: 0.85rem;" onclick="updateOrderStatusAndRefreshModal(${o.id}, 'cancelled')">✕ বাতিল করুন</button>` : ''}
        <button class="action-btn-sm" style="background: #64748b; color: #fff; padding: 8px 16px; font-size: 0.85rem;" onclick="viewOrderAuditTrail(${o.id})">📋 অডিট হিস্ট্রি</button>
      </div>
    </div>
  `;

  openModal('orderDetailModal');
}

async function updateOrderStatusAndRefreshModal(orderId, newStatus) {
  await updateOrderStatus(orderId, newStatus);
  closeModal('orderDetailModal');
}

async function instantReleaseCommissionAndRefreshModal(orderId, commissionAmount) {
  await instantReleaseCommission(orderId, commissionAmount);
  closeModal('orderDetailModal');
}

// ================= SECTION: PROFIT DASHBOARD =================
async function loadAdminProfitDashboard() {
  try {
    const res = await fetch(api('/api/admin/analytics'), {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const data = await res.json();
    if (!res.ok || !data.success || !data.analytics || !data.analytics.profit_dashboard) {
      showToast(data.message || 'লাভ ও হিসাব লোড করা যায়নি', 'error');
      return;
    }
    const p = data.analytics.profit_dashboard;

    // Today
    const today = p.today || {};
    const elTOrders = document.getElementById('profitTodayOrders');
    if (elTOrders) elTOrders.textContent = `${today.order_count || 0}টি অর্ডার`;
    const elTRev = document.getElementById('profitTodayRevenue');
    if (elTRev) elTRev.textContent = `${today.total_revenue || 0} ৳`;
    const elTWhl = document.getElementById('profitTodayWholesale');
    if (elTWhl) elTWhl.textContent = `${today.total_wholesale || 0} ৳`;
    const elTCom = document.getElementById('profitTodayCommission');
    if (elTCom) elTCom.textContent = `${today.total_reseller_commission || 0} ৳`;
    const elTNet = document.getElementById('profitTodayNet');
    if (elTNet) elTNet.textContent = `${today.net_profit || 0} ৳`;

    // This Month
    const month = p.this_month || {};
    const elMOrders = document.getElementById('profitMonthOrders');
    if (elMOrders) elMOrders.textContent = `${month.order_count || 0}টি অর্ডার`;
    const elMRev = document.getElementById('profitMonthRevenue');
    if (elMRev) elMRev.textContent = `${month.total_revenue || 0} ৳`;
    const elMWhl = document.getElementById('profitMonthWholesale');
    if (elMWhl) elMWhl.textContent = `${month.total_wholesale || 0} ৳`;
    const elMCom = document.getElementById('profitMonthCommission');
    if (elMCom) elMCom.textContent = `${month.total_reseller_commission || 0} ৳`;
    const elMNet = document.getElementById('profitMonthNet');
    if (elMNet) elMNet.textContent = `${month.net_profit || 0} ৳`;

    // All Time
    const allTime = p.all_time || {};
    const elAOrders = document.getElementById('profitAllOrders');
    if (elAOrders) elAOrders.textContent = `${allTime.order_count || 0}টি অর্ডার`;
    const elARev = document.getElementById('profitAllRevenue');
    if (elARev) elARev.textContent = `${allTime.total_revenue || 0} ৳`;
    const elAWhl = document.getElementById('profitAllWholesale');
    if (elAWhl) elAWhl.textContent = `${allTime.total_wholesale || 0} ৳`;
    const elACom = document.getElementById('profitAllCommission');
    if (elACom) elACom.textContent = `${allTime.total_reseller_commission || 0} ৳`;
    const elANet = document.getElementById('profitAllNet');
    if (elANet) elANet.textContent = `${allTime.net_profit || 0} ৳`;

    // Partner Ledger
    const partner = p.partner_settlement || {};
    const elPWhl = document.getElementById('ledgerPartnerWholesale');
    if (elPWhl) elPWhl.textContent = `${partner.total_partner_wholesale || 0} ৳`;
    const elPSet = document.getElementById('ledgerPartnerSettled');
    if (elPSet) elPSet.textContent = `${partner.total_partner_settled || 0} ৳`;
    const elPPen = document.getElementById('ledgerPartnerPending');
    if (elPPen) elPPen.textContent = `${partner.pending_partner_payable || 0} ৳`;

    // Reseller Commission Ledger
    const comm = p.commission_ledger || {};
    const elCPen = document.getElementById('ledgerPendingCommission');
    if (elCPen) elCPen.textContent = `${comm.pending_commission || 0} ৳`;
    const elCRel = document.getElementById('ledgerReleasedCommission');
    if (elCRel) elCRel.textContent = `${comm.released_commission || 0} ৳`;
    const elCPayoutPen = document.getElementById('ledgerPendingPayouts');
    if (elCPayoutPen) elCPayoutPen.textContent = `${comm.pending_payouts || 0} ৳`;
    const elCPayoutApp = document.getElementById('ledgerApprovedPayouts');
    if (elCPayoutApp) elCPayoutApp.textContent = `${comm.approved_payouts || 0} ৳`;
  } catch (err) {
    console.error('Profit Dashboard Error:', err);
    showToast('লাভ ও হিসাব লোড ব্যর্থ হয়েছে', 'error');
  }
}

// ================= SECTION: SHOPS & PARTNER LEDGER =================
let adminShopsList = [];

async function loadAdminShops() {
  const tbody = document.getElementById('adminShopsTableBody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; padding: 20px;">দোকান ও লেজার তথ্য লোড হচ্ছে...</td></tr>';

  try {
    const res = await fetch(api('/api/admin/shops'), {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const data = await res.json();
    if (!data.success || !data.shops || data.shops.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; padding: 20px; color: var(--sbf-text-muted);">কোনো দোকান তালিকা পাওয়া যায়নি।</td></tr>';
      return;
    }

    adminShopsList = data.shops;
    tbody.innerHTML = data.shops.map((s) => {
      const isOwn = s.shop_type === 'own';
      const typeBadge = isOwn
        ? '<span style="background: #2563eb; color: #fff; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: 700;">নিজস্ব ব্র্যান্ড</span>'
        : '<span style="background: #059669; color: #fff; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: 700;">পার্টনার শপ</span>';

      return `
        <tr>
          <td data-label="দোকানের নাম">
            <strong>${escapeAdminHtml(s.name)}</strong>
            ${s.address ? `<br><span class="admin-cell-muted">📍 ${escapeAdminHtml(s.address)}</span>` : ''}
          </td>
          <td data-label="ধরন">${typeBadge}</td>
          <td data-label="যোগাযোগ">
            <strong>${escapeAdminHtml(s.contact_person || '-')}</strong>
            <br><a href="tel:${escapeAdminHtml(String(s.phone || '').replace(/\D/g, ''))}">${escapeAdminHtml(s.phone || '-')}</a>
          </td>
          <td data-label="মোট পণ্য"><strong>${escapeAdminHtml(s.products_count || 0)} টি</strong></td>
          <td data-label="ডেলিভার্ড ইউনিট"><strong style="color: #2563eb;">${escapeAdminHtml(s.delivered_units_count || 0)} টি</strong></td>
          <td data-label="মোট পাইকারি পাওনা"><strong class="admin-cell-money">${escapeAdminHtml(s.total_wholesale_amount || 0)} ৳</strong></td>
          <td data-label="পরিশোধিত"><strong style="color: #059669;">${escapeAdminHtml(s.total_settled_amount || 0)} ৳</strong></td>
          <td data-label="বর্তমান বকেয়া">
            <strong style="color: ${s.pending_payable > 0 ? '#b45309' : '#059669'}; font-size: 0.95rem;">
              ${escapeAdminHtml(s.pending_payable || 0)} ৳
            </strong>
          </td>
          <td data-label="করণীয়">
            <div style="display: flex; gap: 4px; flex-wrap: wrap;">
              ${!isOwn ? `
                <button class="action-btn-sm btn-deliver" onclick="openSettleShopModal(${Number(s.id)})">💸 পাওনা পরিশোধ</button>
              ` : ''}
              <button class="action-btn-sm btn-ship" onclick="viewShopSettlements(${Number(s.id)})">📜 হিস্ট্রি</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    console.error('Shops Load Error:', err);
    tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--sbp-red);">দোকান তালিকা লোড ব্যর্থ হয়েছে।</td></tr>';
  }
}

function openAddShopModal() {
  document.getElementById('shopNameInput').value = '';
  document.getElementById('shopTypeInput').value = 'partner';
  document.getElementById('shopContactInput').value = '';
  document.getElementById('shopPhoneInput').value = '';
  document.getElementById('shopCommissionRateInput').value = '0';
  document.getElementById('shopAddressInput').value = '';
  document.getElementById('shopNotesInput').value = '';
  openModal('addShopModal');
}

async function submitAddShopForm() {
  const name = document.getElementById('shopNameInput').value.trim();
  const shop_type = document.getElementById('shopTypeInput').value;
  const contact_person = document.getElementById('shopContactInput').value.trim();
  const phone = document.getElementById('shopPhoneInput').value.trim();
  const commission_rate = parseFloat(document.getElementById('shopCommissionRateInput').value) || 0;
  const address = document.getElementById('shopAddressInput').value.trim();
  const notes = document.getElementById('shopNotesInput').value.trim();

  if (!name) return alert('দোকানের নাম লিখুন');
  if (!phone || !/^01[3-9]\d{8}$/.test(phone)) return alert('সঠিক ১১ ডিজিটের মোবাইল নম্বর দিন (01XXXXXXXXX)');

  try {
    const res = await fetch(api('/api/admin/shops'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({ name, shop_type, contact_person, phone, commission_rate, address, notes })
    });
    const data = await res.json();
    if (data.success) {
      showToast(data.message || 'নতুন দোকান সফলভাবে যুক্ত হয়েছে!');
      closeModal('addShopModal');
      loadAdminShops();
    } else {
      alert(data.message || 'দোকান যোগ করতে সমস্যা হয়েছে');
    }
  } catch (err) {
    alert('সার্ভার যোগাযোগে ত্রুটি ঘটেছে');
  }
}

function openSettleShopModal(shopId, shopName, pendingPayable) {
  const shop = adminShopsList.find((item) => Number(item.id) === Number(shopId));
  const resolvedName = shopName !== undefined ? shopName : (shop ? shop.name : '-');
  const resolvedPending = pendingPayable !== undefined ? pendingPayable : (shop ? (shop.pending_payable || 0) : 0);
  document.getElementById('settleShopId').value = shopId;
  document.getElementById('settleShopName').textContent = resolvedName;
  document.getElementById('settlePendingAmount').textContent = `${resolvedPending} ৳`;
  document.getElementById('settleAmountInput').value = resolvedPending > 0 ? resolvedPending : '';
  document.getElementById('settleTrxIdInput').value = '';
  document.getElementById('settleNotesInput').value = '';
  openModal('settleShopModal');
}

async function submitShopSettlement() {
  const shopId = document.getElementById('settleShopId').value;
  const amount = parseFloat(document.getElementById('settleAmountInput').value);
  const trx_id = document.getElementById('settleTrxIdInput').value.trim();
  const notes = document.getElementById('settleNotesInput').value.trim();

  if (isNaN(amount) || amount <= 0) return alert('সঠিক পরিশোধের টাকার পরিমাণ লিখুন');

  try {
    const res = await fetch(api(`/api/admin/shops/${shopId}/settle`), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({ amount, trx_id, notes })
    });
    const data = await res.json();
    if (data.success) {
      showToast(data.message || 'পাওনা পরিশোধ সফলভাবে রেকর্ড হয়েছে!');
      closeModal('settleShopModal');
      loadAdminShops();
      if (currentAdminSection === 'profit') loadAdminProfitDashboard();
    } else {
      alert(data.message || 'পরিশোধ রেকর্ড ব্যর্থ হয়েছে');
    }
  } catch (err) {
    alert('সার্ভারে যোগাযোগ সমস্যা হয়েছে');
  }
}

async function viewShopSettlements(shopId, shopName) {
  const shop = adminShopsList.find((item) => Number(item.id) === Number(shopId));
  const resolvedName = shopName !== undefined ? shopName : (shop ? shop.name : 'শপ');
  document.getElementById('historyModalTitle').textContent = `📜 ${resolvedName} — পেমেন্ট হিস্ট্রি`;
  const body = document.getElementById('shopSettlementsBody');
  body.innerHTML = '<div style="text-align: center; padding: 20px;"><span class="spinner"></span> হিস্ট্রি লোড হচ্ছে...</div>';
  openModal('shopSettlementsModal');

  try {
    const res = await fetch(api(`/api/admin/shops/${shopId}/settlements`), {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const data = await res.json();
    if (!data.success || !data.settlements || data.settlements.length === 0) {
      body.innerHTML = '<div style="text-align: center; padding: 16px; color: var(--sbf-text-muted);">এই দোকানের পূর্বে কোনো পরিশোধের রেকর্ড নেই।</div>';
      return;
    }

    body.innerHTML = `
      <div class="table-responsive">
        <table>
          <thead>
            <tr>
              <th>তারিখ</th>
              <th>পরিশোধের পরিমাণ</th>
              <th>TrxID / রেফারেন্স</th>
              <th>পরিশোধকারী এডমিন</th>
              <th>নোট</th>
            </tr>
          </thead>
          <tbody>
            ${data.settlements.map((s) => `
              <tr>
                <td style="font-size: 0.8rem;">${new Date(s.created_at).toLocaleString('bn-BD')}</td>
                <td><strong style="color: #059669; font-size: 0.95rem;">${escapeAdminHtml(s.amount)} ৳</strong></td>
                <td>${s.trx_id ? `<strong class="admin-cell-success">${escapeAdminHtml(s.trx_id)}</strong>` : '<span class="admin-cell-muted">-</span>'}</td>
                <td>${escapeAdminHtml(s.admin_name || 'এডমিন')}</td>
                <td style="font-size: 0.8rem;">${escapeAdminHtml(s.notes || '-')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  } catch (err) {
    body.innerHTML = '<div style="color: var(--sbp-red); text-align: center; padding: 16px;">লোড ব্যর্থ হয়েছে।</div>';
  }
}

// ================= SECTION 2: PAYOUTS =================
async function loadAdminPayouts() {
  const tbody = document.getElementById('adminPayoutsTableBody');
  tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; padding: 20px;">ক্যাশআউট লোড হচ্ছে...</td></tr>';

  try {
    const res = await fetch(api('/api/admin/payouts'), {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const data = await res.json();

    if (!data.success || data.payouts.length === 0) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; padding: 20px; color: var(--sbf-text-muted);">কোনো ক্যাশআউট রিকোয়েস্ট নেই।</td></tr>';
      return;
    }

    window._adminPayoutsById = Object.fromEntries(data.payouts.map((payout) => [payout.id, payout]));

    tbody.innerHTML = data.payouts.map((p) => `
      <tr>
        <td data-label="রিকোয়েস্ট">#${p.id}</td>
        <td data-label="রিসেলার"><strong>${escapeAdminHtml(p.user_name)}</strong></td>
        <td data-label="রিসেলারের ফোন">${escapeAdminHtml(p.user_phone)}</td>
        <td data-label="পরিমাণ"><strong class="admin-cell-money">${escapeAdminHtml(p.amount)} ৳</strong></td>
        <td data-label="পেমেন্ট মাধ্যম"><span style="text-transform: uppercase; font-weight: 700;">${escapeAdminHtml(p.payment_method)}</span></td>
        <td data-label="যে নম্বরে পাঠাবেন"><strong>${escapeAdminHtml(p.account_number)}</strong></td>
        <td data-label="স্ট্যাটাস">
          <span style="background: ${p.status === 'approved' ? '#10b981' : p.status === 'pending' ? '#f59e0b' : '#ef4444'}; color: #fff; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: 700;">
            ${escapeAdminHtml(payoutStatusLabels[p.status] || p.status)}
          </span>
        </td>
        <td data-label="TrxID ও তারিখ">${escapeAdminHtml(p.admin_trx_id || 'এখনও দেওয়া হয়নি')}<br><span class="admin-cell-muted">${new Date(p.created_at).toLocaleDateString('bn-BD')}</span></td>
        <td data-label="করণীয়">
          ${p.status === 'pending' ? `
            <div style="display: flex; gap: 4px;">
              <button class="action-btn-sm btn-deliver" onclick="approvePayoutPrompt(${p.id})">অনুমোদন</button>
              <button class="action-btn-sm btn-cancel" onclick="rejectPayoutPrompt(${p.id})">বাতিল</button>
            </div>
          ` : '<span style="color: #a8a29e; font-size: 0.75rem;">সম্পন্ন</span>'}
        </td>
      </tr>
    `).join('');
  } catch (err) {
    console.error(err);
    tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--sbp-red);">লোড ব্যর্থ হয়েছে।</td></tr>';
  }
}

async function approvePayoutPrompt(payoutId) {
  const payout = window._adminPayoutsById && window._adminPayoutsById[payoutId];
  if (!payout) return showToast('ক্যাশআউট তথ্য পাওয়া যায়নি। তালিকাটি আবার লোড করুন।', 'error');
  const { amount, payment_method: method, account_number: account } = payout;

  openAdminPromptModal({
    title: '✅ ক্যাশআউট অনুমোদন (TrxID)',
    description: `${String(method || '').toUpperCase()} নম্বর ${account}-এ ${amount} ৳ পাঠানোর পর ট্রানজেকশন আইডি (TrxID) লিখুন:`,
    submitText: '✅ অনুমোদন নিশ্চিত করুন',
    fields: [
      {
        name: 'admin_trx_id',
        label: 'ট্রানজেকশন আইডি (TrxID) *',
        type: 'text',
        placeholder: 'যেমন: BGD7H8K9M2',
        required: true
      }
    ],
    onSubmit: async (values, showError) => {
      const trxId = String(values.admin_trx_id || '').trim();
      if (!trxId) {
        showError('অনুগ্রহ করে সঠিক ট্রানজেকশন আইডি (TrxID) লিখুন');
        return false;
      }
      try {
        const res = await fetch(api(`/api/admin/payouts/${payoutId}`), {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${adminToken}`
          },
          body: JSON.stringify({ status: 'approved', admin_trx_id: trxId })
        });
        const data = await res.json();
        if (data.success) {
          showToast('✅ ক্যাশআউট অনুমোদন সম্পন্ন হয়েছে!');
          loadAdminPayouts();
          loadAdminStats();
          return true;
        }
        showError(data.message || 'ক্যাশআউট আপডেট ব্যর্থ হয়েছে');
        return false;
      } catch (err) {
        console.error(err);
        showError('সার্ভারের সাথে সংযোগ ব্যর্থ হয়েছে');
        return false;
      }
    }
  });
}

async function rejectPayoutPrompt(payoutId) {
  const payout = window._adminPayoutsById && window._adminPayoutsById[payoutId];
  const desc = payout
    ? `${String(payout.payment_method || '').toUpperCase()} (${payout.account_number}) · ${payout.amount} ৳ রিকোয়েস্ট বাতিল করার কারণ লিখুন:`
    : 'ক্যাশআউট বাতিল করার কারণ লিখুন:';

  openAdminPromptModal({
    title: '❌ ক্যাশআউট বাতিল করুন',
    description: desc,
    submitText: '❌ বাতিল নিশ্চিত করুন',
    fields: [
      {
        name: 'notes',
        label: 'বাতিল করার কারণ *',
        type: 'textarea',
        placeholder: 'যেমন: নম্বরটি ভুল ছিল বা অ্যাকাউন্ট ভেরিফাইড নয়',
        rows: 3,
        required: true
      }
    ],
    onSubmit: async (values, showError) => {
      const notes = String(values.notes || '').trim();
      if (!notes) {
        showError('ক্যাশআউট বাতিলের কারণ লিখুন');
        return false;
      }
      try {
        const res = await fetch(api(`/api/admin/payouts/${payoutId}`), {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${adminToken}`
          },
          body: JSON.stringify({ status: 'rejected', notes })
        });
        const data = await res.json();
        if (data.success) {
          showToast('ক্যাশআউট বাতিল করা হয়েছে');
          loadAdminPayouts();
          loadAdminStats();
          return true;
        }
        showError(data.message || 'ব্যর্থ হয়েছে');
        return false;
      } catch (err) {
        console.error(err);
        showError('সার্ভারের সাথে সংযোগ ব্যর্থ হয়েছে');
        return false;
      }
    }
  });
}

// ================= SECTION 3: PRODUCTS (CRUD) =================
function formatAdminProductCount(value) {
  return Number(value || 0).toLocaleString('bn-BD');
}

function populateAdminProductFilters() {
  const categoryFilter = document.getElementById('adminProductCategoryFilter');
  const shopFilter = document.getElementById('adminProductShopFilter');
  if (!categoryFilter || !shopFilter) return;

  const selectedCategory = categoryFilter.value || 'all';
  const selectedShop = shopFilter.value || 'all';
  const categories = [...new Set(adminProductsList.map((product) => product.category).filter(Boolean))]
    .sort((a, b) => String(a).localeCompare(String(b), 'bn'));
  categoryFilter.innerHTML = '<option value="all">সব ক্যাটাগরি</option>' + categories.map((category) =>
    `<option value="${escapeAdminHtml(category)}">${escapeAdminHtml(category)}</option>`
  ).join('');
  categoryFilter.value = categories.includes(selectedCategory) ? selectedCategory : 'all';

  const shops = new Map([['partner', 'পার্টনার দোকান']]);
  adminProductsList.forEach((product) => {
    const shopName = product.shop_name || product.brand;
    if (shopName) shops.set(String(shopName), String(shopName));
  });
  shopFilter.innerHTML = '<option value="all">সব দোকান</option>' + [...shops.entries()].map(([value, label]) =>
    `<option value="${escapeAdminHtml(value)}">${escapeAdminHtml(label)}</option>`
  ).join('');
  shopFilter.value = shops.has(selectedShop) ? selectedShop : 'all';
}

function setAdminProductStatusFilter(status) {
  adminProductStatusFilter = ['all', 'active', 'inactive', 'low', 'out'].includes(status) ? status : 'all';
  adminProductsPage = 1;
  renderAdminProducts();
}

function filterAdminProducts() {
  adminProductsPage = 1;
  renderAdminProducts();
}

function resetAdminProductFilters() {
  const defaults = {
    adminProductSearch: '',
    adminProductCategoryFilter: 'all',
    adminProductShopFilter: 'all',
    adminProductSort: 'newest',
    adminProductPageSize: '25'
  };
  Object.entries(defaults).forEach(([id, value]) => {
    const control = document.getElementById(id);
    if (control) control.value = value;
  });
  adminProductStatusFilter = 'all';
  adminProductsPage = 1;
  renderAdminProducts();
}

function changeAdminProductsPage(offset) {
  adminProductsPage += Number(offset) || 0;
  renderAdminProducts();
}

function renderAdminProducts() {
  const tbody = document.getElementById('adminProductsTableBody');
  if (!tbody) return;

  const search = (document.getElementById('adminProductSearch')?.value || '').trim().toLocaleLowerCase();
  const category = document.getElementById('adminProductCategoryFilter')?.value || 'all';
  const shop = document.getElementById('adminProductShopFilter')?.value || 'all';
  const sort = document.getElementById('adminProductSort')?.value || 'newest';
  const pageSize = Math.max(1, parseInt(document.getElementById('adminProductPageSize')?.value, 10) || 25);
  const activeProducts = adminProductsList.filter((product) => Number(product.is_active) === 1);
  const quickCounts = {
    all: adminProductsList.length,
    active: activeProducts.length,
    inactive: adminProductsList.length - activeProducts.length,
    low: activeProducts.filter((product) => Number(product.stock) > 0 && Number(product.stock) <= 5).length,
    out: activeProducts.filter((product) => Number(product.stock) <= 0).length
  };
  const quickFilterLabels = {
    all: 'সব পণ্য', active: 'সক্রিয়', low: 'কম স্টক (১–৫)', out: 'স্টক শেষ', inactive: 'নিষ্ক্রিয়'
  };
  const quickFilters = document.getElementById('adminProductQuickFilters');
  if (quickFilters) {
    quickFilters.innerHTML = Object.entries(quickFilterLabels).map(([key, label]) => `
      <button type="button" class="product-filter-chip${adminProductStatusFilter === key ? ' is-selected' : ''}"
        aria-pressed="${adminProductStatusFilter === key}" onclick="setAdminProductStatusFilter('${key}')">
        ${label}<span>${formatAdminProductCount(quickCounts[key])}</span>
      </button>
    `).join('');
  }

  let filtered = adminProductsList.filter((product) => {
    const isActive = Number(product.is_active) === 1;
    const stock = Number(product.stock) || 0;
    if (adminProductStatusFilter === 'active' && !isActive) return false;
    if (adminProductStatusFilter === 'inactive' && isActive) return false;
    if (adminProductStatusFilter === 'low' && (!isActive || stock < 1 || stock > 5)) return false;
    if (adminProductStatusFilter === 'out' && (!isActive || stock > 0)) return false;
    if (category !== 'all' && product.category !== category) return false;
    const shopName = String(product.shop_name || product.brand || '');
    const isPartner = product.shop_type === 'partner' || (shopName && !['SB Furniture', 'SB POWER', 'SB Lifestyle & Tools'].includes(shopName));
    if (shop === 'partner' && !isPartner) return false;
    if (shop !== 'all' && shop !== 'partner' && shopName !== shop) return false;
    if (search) {
      const searchable = [product.title, product.sku, product.description, product.category, product.shop_name, product.brand, product.vendor_phone]
        .filter(Boolean).join(' ').toLocaleLowerCase();
      if (!searchable.includes(search)) return false;
    }
    return true;
  });

  const numericValue = (product, key) => Number(product[key]) || 0;
  filtered.sort((a, b) => {
    if (sort === 'title') return String(a.title || '').localeCompare(String(b.title || ''), 'bn', { sensitivity: 'base' });
    if (sort === 'stock-asc') return numericValue(a, 'stock') - numericValue(b, 'stock') || Number(b.id) - Number(a.id);
    if (sort === 'price-asc') return numericValue(a, 'regular_price') - numericValue(b, 'regular_price') || Number(b.id) - Number(a.id);
    if (sort === 'price-desc') return numericValue(b, 'regular_price') - numericValue(a, 'regular_price') || Number(b.id) - Number(a.id);
    if (sort === 'profit-desc') {
      const profitA = numericValue(a, 'regular_price') - numericValue(a, 'wholesale_price') - numericValue(a, 'reseller_commission');
      const profitB = numericValue(b, 'regular_price') - numericValue(b, 'wholesale_price') - numericValue(b, 'reseller_commission');
      return profitB - profitA || Number(b.id) - Number(a.id);
    }
    return sort === 'newest' ? Number(b.id) - Number(a.id) : Number(a.id) - Number(b.id);
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  adminProductsPage = Math.min(Math.max(1, adminProductsPage), totalPages);
  const start = (adminProductsPage - 1) * pageSize;
  const pageProducts = filtered.slice(start, start + pageSize);
  const countEl = document.getElementById('adminProductsCount');
  const pageInfo = document.getElementById('adminProductsPageInfo');
  const prevButton = document.getElementById('adminProductsPrev');
  const nextButton = document.getElementById('adminProductsNext');

  if (countEl) {
    countEl.textContent = filtered.length
      ? `${formatAdminProductCount(start + 1)}–${formatAdminProductCount(Math.min(start + pageSize, filtered.length))} দেখানো হচ্ছে · ${formatAdminProductCount(filtered.length)}টি মিলেছে · মোট ${formatAdminProductCount(adminProductsList.length)}টি পণ্য`
      : `কোনো পণ্য মেলেনি · মোট ${formatAdminProductCount(adminProductsList.length)}টি পণ্য`;
  }
  if (pageInfo) pageInfo.textContent = `${formatAdminProductCount(adminProductsPage)} / ${formatAdminProductCount(totalPages)}`;
  if (prevButton) prevButton.disabled = adminProductsPage <= 1 || filtered.length === 0;
  if (nextButton) nextButton.disabled = adminProductsPage >= totalPages || filtered.length === 0;

  if (!adminProductsList.length) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; padding: 20px;">কোনো পণ্য নেই। নতুন পণ্য যোগ করে শুরু করুন।</td></tr>';
    return;
  }
  if (!pageProducts.length) {
    tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; padding: 20px;">এই ফিল্টারে কোনো পণ্য পাওয়া যায়নি। খোঁজা বা ফিল্টার বদলে দেখুন।</td></tr>';
    return;
  }

  tbody.innerHTML = pageProducts.map((p) => {
    const isActive = Number(p.is_active) === 1;
    const isPartner = p.shop_type === 'partner' || (p.shop_name && !['SB Furniture', 'SB POWER', 'SB Lifestyle & Tools'].includes(p.shop_name));
    const wholesale = p.wholesale_price || 0;
    const commission = p.reseller_commission || 0;
    const netProfit = p.regular_price - wholesale - commission;
    const safeThumb = safeAdminImageUrl(p.image_url);
    const imgCors = imageCorsAttrAdmin(safeThumb);

    return `
      <tr style="${isActive ? '' : 'opacity: 0.65; background: rgba(239, 68, 68, 0.05);'}">
        <td data-label="ছবি"><img class="admin-product-thumb" src="${escapeAdminHtml(safeThumb)}" ${imgCors} alt="${escapeAdminHtml(p.title)}" onerror="window.sbHandleImageError && window.sbHandleImageError(this)"></td>
        <td data-label="SKU"><strong>${escapeAdminHtml(p.sku)}</strong>${isActive ? '' : '<br><span class="admin-inactive-badge">নিষ্ক্রিয়</span>'}</td>
        <td data-label="পণ্যের নাম"><strong>${escapeAdminHtml(p.title)}</strong></td>
        <td data-label="দোকান ও ক্যাটাগরি">
          <span style="color: ${p.brand === 'SB Furniture' ? '#ea580c' : (p.brand === 'SB Lifestyle & Tools' ? '#0f766e' : '#0284c7')}; font-weight: 700;">${escapeAdminHtml(p.shop_name || p.brand)}</span>
          ${isPartner ? '<br><span style="font-size: 0.72rem; color: #16a34a; font-weight: 600;">🏪 পার্টনার শপ</span>' : '<br><span style="font-size: 0.72rem; color: #2563eb; font-weight: 600;">🏢 নিজস্ব ব্র্যান্ড</span>'}
          ${p.vendor_phone ? `<br><span style="font-size: 0.72rem; color: #64748b;">📞 ${escapeAdminHtml(p.vendor_phone)}</span>` : ''}
          <br><span style="font-size: 0.72rem; color: #64748b;">${escapeAdminHtml(p.category)}</span>
        </td>
        <td data-label="মূল্য ও পাইকারি">
          <strong>${escapeAdminHtml(p.regular_price)} ৳</strong>
          <br><span style="font-size: 0.72rem; color: #6546a5;">পাইকারি: ${escapeAdminHtml(wholesale)}৳</span>
        </td>
        <td data-label="রিসেলার কমিশন"><span class="admin-commission-badge">${escapeAdminHtml(commission)}৳ (${escapeAdminHtml(p.commission_tab)})</span></td>
        <td data-label="নিট লাভ">
          <strong style="color: ${netProfit > 0 ? '#059669' : '#dc2626'}; font-size: 0.95rem;">
            ${netProfit > 0 ? '+' : ''}${escapeAdminHtml(netProfit)} ৳
          </strong>
        </td>
        <td data-label="স্টক">${escapeAdminHtml(p.stock)}</td>
        <td data-label="করণীয়">
          <div class="product-row-actions">
            <button class="action-btn-sm btn-edit-product" onclick="editProductModal(${p.id})">✏️ এডিট</button>
            <button class="action-btn-sm product-copy-action" onclick="openMarketingCopyModal(${p.id})">📢 কপি</button>
            <button class="action-btn-sm product-stock-action" onclick="promptQuickStockPrice(${p.id}, ${Number(p.stock) || 0}, ${Number(p.regular_price) || 0})">⚡ স্টক/দাম</button>
            ${isActive
              ? `<button class="action-btn-sm btn-cancel" onclick="deleteProduct(${p.id})">নিষ্ক্রিয়</button>`
              : `<button class="action-btn-sm adm-btn-soft-success" onclick="toggleProductActiveStatus(${p.id}, 1)">✅ সক্রিয়</button>
                 <button class="action-btn-sm btn-cancel" onclick="permanentDeleteProduct(${p.id})">🗑️ স্থায়ী মুছুন</button>`}
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

async function loadAdminProducts() {
  const tbody = document.getElementById('adminProductsTableBody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; padding: 20px;">ক্যাটালগ লোড হচ্ছে...</td></tr>';

  try {
    const res = await fetch(api('/api/admin/products'), {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const data = await res.json();

    if (!data.success || !Array.isArray(data.products)) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; padding: 20px;">পণ্যের তালিকা লোড করা যায়নি।</td></tr>';
      return;
    }

    adminProductsList = data.products;
    populateAdminProductFilters();
    renderAdminProducts();
  } catch (err) {
    console.error(err);
    tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--sbp-red);">লোড ব্যর্থ হয়েছে।</td></tr>';
  }
}

function updateLiveProfitCalculator() {
  const price = parseFloat(document.getElementById('prodPrice').value) || 0;
  const wholesale = parseFloat(document.getElementById('prodWholesalePrice').value) || 0;
  const commission = parseFloat(document.getElementById('prodCommission').value) || 0;

  const netProfit = price - wholesale - commission;
  const margin = price > 0 ? ((netProfit / price) * 100).toFixed(1) : '0';

  const elPrice = document.getElementById('calcPriceDisplay');
  if (elPrice) elPrice.textContent = `${price} ৳`;
  const elWholesale = document.getElementById('calcWholesaleDisplay');
  if (elWholesale) elWholesale.textContent = `-${wholesale} ৳`;
  const elCommission = document.getElementById('calcCommissionDisplay');
  if (elCommission) elCommission.textContent = `-${commission} ৳`;
  const elNet = document.getElementById('calcNetProfitDisplay');
  if (elNet) {
    elNet.textContent = `${netProfit} ৳`;
    elNet.style.color = netProfit > 0 ? '#15803d' : '#b91c1c';
  }
  const elBadge = document.getElementById('calcMarginBadge');
  if (elBadge) elBadge.textContent = `মার্জিন: ${margin}%`;

  const warning = document.getElementById('calcProfitWarning');
  if (warning) {
    warning.style.display = (price > 0 && netProfit <= 0) ? 'block' : 'none';
  }
}

async function loadAdminShopOptions(selectedShopId = null) {
  const select = document.getElementById('prodShopId');
  if (!select) return;

  try {
    const res = await fetch(api('/api/admin/shops'), {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const data = await res.json();
    if (data.success && Array.isArray(data.shops)) {
      adminShopsList = data.shops;
      select.innerHTML = data.shops.map((s) => `
        <option value="${s.id}" ${selectedShopId && String(selectedShopId) === String(s.id) ? 'selected' : ''}>
          ${escapeAdminHtml(s.name)} (${s.shop_type === 'own' ? 'নিজস্ব' : 'পার্টনার শপ'})
        </option>
      `).join('');
    }
  } catch (err) {
    console.error('Error loading shop options:', err);
  }
}

let prodSkuManuallyEdited = false;
let prodWholesaleManuallyEdited = false;
let prodCommissionManuallyEdited = false;

function getBrandPrefix(brand) {
  if (brand === 'SB Furniture') return 'SBF';
  if (brand === 'SB Lifestyle & Tools') return 'SBL';
  return 'SBP';
}

function generateNextAvailableSku(brand) {
  const prefix = getBrandPrefix(brand);
  const used = new Set(
    (adminProductsList || [])
      .map((p) => String(p.sku || '').toUpperCase())
      .filter((s) => s.startsWith(prefix + '-'))
  );
  let num = 101;
  while (used.has(`${prefix}-${num}`)) num += 1;
  return `${prefix}-${num}`;
}

function updateSkuSummaryBadge() {
  const badge = document.getElementById('prodSkuSummaryBadge');
  const sku = document.getElementById('prodSku')?.value?.trim();
  if (badge) badge.textContent = sku ? `SKU: ${sku}` : 'অটো SKU';
}

function markSkuManual() {
  prodSkuManuallyEdited = true;
  updateSkuSummaryBadge();
}

function markPricingManual(field) {
  if (field === 'wholesale') prodWholesaleManuallyEdited = true;
  if (field === 'commission') prodCommissionManuallyEdited = true;
}

function syncCommissionTabFromAmount() {
  const comm = parseFloat(document.getElementById('prodCommission')?.value) || 0;
  const commTab = document.getElementById('prodCommTab');
  if (!commTab) return;
  if (comm >= 1500) commTab.value = '1500tk';
  else if (comm >= 1000) commTab.value = '1000tk';
  else if (comm >= 500) commTab.value = '500tk';
  else if (comm >= 200) commTab.value = '200tk';
  else if (comm >= 100) commTab.value = '100tk';
  else commTab.value = '50tk';
}

function onProdRetailPriceInput() {
  const price = parseFloat(document.getElementById('prodPrice')?.value) || 0;
  const isNew = !document.getElementById('editProductId')?.value;
  if (isNew && price > 0) {
    let suggestedComm = 50;
    if (price >= 20000) suggestedComm = 1500;
    else if (price >= 10000) suggestedComm = 1000;
    else if (price >= 2000) suggestedComm = 500;
    else if (price >= 800) suggestedComm = 200;
    else if (price >= 500) suggestedComm = 100;
    if (suggestedComm >= price) suggestedComm = Math.max(0, Math.floor(price * 0.1));

    const commInput = document.getElementById('prodCommission');
    if (commInput && !prodCommissionManuallyEdited) {
      commInput.value = suggestedComm;
      syncCommissionTabFromAmount();
    }
    const usedComm = parseFloat(commInput?.value) || 0;
    const wholesaleInput = document.getElementById('prodWholesalePrice');
    if (wholesaleInput && !prodWholesaleManuallyEdited) {
      wholesaleInput.value = Math.max(0, Math.round(price - usedComm - price * 0.15));
    }
  }
  updateLiveProfitCalculator();
}

function onProdCategoryChange(cat) {
  checkFurnitureCutlistVisibility();
  const isNew = !document.getElementById('editProductId')?.value;
  if (!isNew) return;
  const inferred = inferBrandFromCategoryName(cat);
  const currentShop = adminShopsList.find((s) => String(s.id) === String(document.getElementById('prodShopId')?.value));
  if (!currentShop || currentShop.shop_type === 'own') {
    syncOwnShopByBrand(inferred);
  }
}

function inferBrandFromCategoryName(cat) {
  const s = String(cat || '');
  if (s.includes('ফার্নিচার') || s.includes('ডেকোরেশন')) return 'SB Furniture';
  if (s.includes('ওয়াচ') || s.includes('ফ্যাশন') || s.includes('টুলস') || s.includes('ইলেকট্রিক্যাল')) {
    return 'SB Lifestyle & Tools';
  }
  return 'SB POWER';
}

function onProdShopChange(shopId) {
  const shop = adminShopsList.find((s) => String(s.id) === String(shopId));
  if (!shop) return;
  document.getElementById('prodShopName').value = shop.name;
  if (shop.shop_type === 'own') {
    const ownBrands = ['SB Furniture', 'SB POWER', 'SB Lifestyle & Tools'];
    const targetBrand = ownBrands.includes(shop.name) ? shop.name : 'SB Furniture';
    document.getElementById('prodBrand').value = targetBrand;
    document.getElementById('prodVendorBadge').value = 'নিজস্ব ব্র্যান্ড';
    const isNew = !document.getElementById('editProductId')?.value;
    if (isNew && !prodSkuManuallyEdited) {
      document.getElementById('prodSku').value = generateNextAvailableSku(targetBrand);
      updateSkuSummaryBadge();
    }
  } else {
    document.getElementById('prodBrand').value = inferBrandFromCategoryName(document.getElementById('prodCategory')?.value);
    document.getElementById('prodVendorBadge').value = 'স্থানীয় পার্টনার শপ';
  }
  if (shop.phone) document.getElementById('prodVendorPhone').value = shop.phone;
  if (shop.address) document.getElementById('prodVendorAddress').value = shop.address;
}

// Client-Side Canvas Image Compression Helper (Fast, Low-RAM, Mobile-Friendly)
function compressImageFile(file, maxWidth = 1200, maxHeight = 1200, quality = 0.82) {
  return new Promise((resolve) => {
    if (file.type === 'image/gif') {
      const r = new FileReader();
      r.onload = () => resolve(r.target.result);
      r.onerror = () => resolve(null);
      r.readAsDataURL(file);
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        try {
          let width = img.width;
          let height = img.height;

          if (width > maxWidth || height > maxHeight) {
            const ratio = Math.min(maxWidth / width, maxHeight / height);
            width = Math.round(width * ratio);
            height = Math.round(height * ratio);
          }

          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, width, height);
          ctx.drawImage(img, 0, 0, width, height);

          const compressed = canvas.toDataURL('image/jpeg', quality);
          resolve(compressed);
        } catch (canvasErr) {
          console.warn('Canvas compression fallback:', canvasErr);
          resolve(e.target.result);
        }
      };
      img.onerror = () => resolve(e.target.result);
      img.src = e.target.result;
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

// Direct Product Image File Upload Handler with Instant Preview and Client Compression
async function processProductImageFile(file) {
  if (!file) return;

  if (!file.type.startsWith('image/')) {
    alert('অনুগ্রহ করে শুধুমাত্র ছবির ফাইল (JPG, PNG, WebP) নির্বাচন করুন');
    return;
  }

  const preview = document.getElementById('prodImagePreview');
  const previewWrap = document.getElementById('prodImagePreviewWrap');
  const placeholder = document.getElementById('prodImagePlaceholder');
  const statusEl = document.getElementById('prodUploadStatus');
  const aiBox = document.getElementById('aiImageInspectActionBox');

  // Instant local preview for zero-delay visual confirmation
  try {
    const objectUrl = URL.createObjectURL(file);
    setAdminPreviewSrc(preview, objectUrl);
    if (previewWrap) previewWrap.style.display = 'block';
    if (placeholder) placeholder.style.display = 'none';
    if (aiBox) aiBox.style.display = 'block';
  } catch {
    // fallback if createObjectURL not available
  }

  if (statusEl) {
    statusEl.textContent = '⏳ অপ্টিমাইজ ও আপলোড হচ্ছে...';
    statusEl.style.color = '#d97706';
  }

  try {
    const dataUrl = await compressImageFile(file);
    if (!dataUrl) throw new Error('ফাইল পড়তে ব্যর্থ হয়েছে');

    // Update preview with compressed data URL if needed
    setAdminPreviewSrc(preview, dataUrl);
    if (previewWrap) previewWrap.style.display = 'block';
    if (placeholder) placeholder.style.display = 'none';
    if (aiBox) aiBox.style.display = 'block';

    const res = await fetch(api('/api/admin/upload-image'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({ image: dataUrl })
    });
    const data = await res.json();
    if (data.success && data.url) {
      unsavedUploadedImageUrls.add(data.url);
      document.getElementById('prodImageUrl').value = data.url;
      const manualInput = document.getElementById('prodManualImageUrl');
      if (manualInput) manualInput.value = data.url;
      if (statusEl) {
        statusEl.textContent = '✅ ছবি আপলোড সম্পন্ন!';
        statusEl.style.color = '#16a34a';
      }
      if (aiBox) aiBox.style.display = 'block';

      const isNew = !document.getElementById('editProductId')?.value;
      const autoAiEnabled = Boolean(document.getElementById('prodAutoAiOnPhoto')?.checked);
      const titleEmpty = !document.getElementById('prodTitle')?.value?.trim();
      if (isNew && autoAiEnabled && titleEmpty) {
        runAiProductImageInspection();
      }
    } else {
      if (statusEl) {
        statusEl.textContent = '❌ আপলোড ব্যর্থ';
        statusEl.style.color = '#dc2626';
      }
      alert(data.message || 'ছবি আপলোড করতে ব্যর্থ হয়েছে');
    }
  } catch (err) {
    console.error('Image upload error:', err);
    if (statusEl) {
      statusEl.textContent = '❌ আপলোড ত্রুটি';
      statusEl.style.color = '#dc2626';
    }
    alert('ছবি আপলোড করতে ব্যর্থ হয়েছে। ইন্টারনেট সংযোগ চেক করুন।');
  }
}

async function handleProductImageSelect(event) {
  const file = event.target.files && event.target.files[0];
  if (file) await processProductImageFile(file);
}

function toggleManualUrlInput() {
  const wrap = document.getElementById('manualUrlWrapper');
  if (wrap) {
    const isHidden = wrap.style.display === 'none' || !wrap.style.display;
    wrap.style.display = isHidden ? 'block' : 'none';
    if (isHidden) {
      const input = document.getElementById('prodManualImageUrl');
      if (input) input.focus();
    }
  }
}

function handleManualUrlInput(val) {
  const trimmed = val ? val.trim() : '';
  const preview = document.getElementById('prodImagePreview');
  const previewWrap = document.getElementById('prodImagePreviewWrap');
  const placeholder = document.getElementById('prodImagePlaceholder');
  const statusEl = document.getElementById('prodUploadStatus');
  const aiBox = document.getElementById('aiImageInspectActionBox');

  document.getElementById('prodImageUrl').value = trimmed;

  if (trimmed) {
    setAdminPreviewSrc(preview, safeAdminImageUrl(trimmed));
    if (previewWrap) previewWrap.style.display = 'block';
    if (placeholder) placeholder.style.display = 'none';
    if (statusEl) {
      statusEl.textContent = 'সরাসরি লিঙ্ক সক্রিয়';
      statusEl.style.color = '#2563eb';
    }
    if (aiBox) aiBox.style.display = 'block';
  } else {
    setAdminPreviewSrc(preview, '');
    if (previewWrap) previewWrap.style.display = 'none';
    if (placeholder) placeholder.style.display = 'block';
    if (statusEl) {
      statusEl.textContent = 'ছবি নির্বাচন করুন';
      statusEl.style.color = '';
    }
    if (aiBox) aiBox.style.display = 'none';
  }
}

async function openAddProductModal(preferredShopId = null) {
  prodSkuManuallyEdited = false;
  prodWholesaleManuallyEdited = false;
  prodCommissionManuallyEdited = false;

  document.getElementById('editProductId').value = '';
  document.getElementById('productFormTitle').textContent = '➕ নতুন প্রোডাক্ট যোগ করুন';
  const submitBtn = document.getElementById('btnSubmitProduct');
  if (submitBtn) submitBtn.textContent = '✅ প্রোডাক্ট সংরক্ষণ করুন';
  const submitNextBtn = document.getElementById('btnSubmitAndNext');
  if (submitNextBtn) submitNextBtn.style.display = 'inline-flex';
  const advDetails = document.getElementById('prodAdvancedDetails');
  if (advDetails) advDetails.open = false;

  document.getElementById('prodTitle').value = '';
  document.getElementById('prodBrand').value = 'SB POWER';
  document.getElementById('prodCategory').value = 'ওয়্যারলেস অডিও ও গ্যাজেটস';
  document.getElementById('prodSku').value = generateNextAvailableSku('SB POWER');
  updateSkuSummaryBadge();
  document.getElementById('prodShopName').value = 'SB POWER';
  document.getElementById('prodVendorPhone').value = '01634664224';
  document.getElementById('prodVendorBadge').value = 'নিজস্ব ব্র্যান্ড';
  document.getElementById('prodVendorAddress').value = 'কালীগঞ্জ, গাজীপুর';
  document.getElementById('prodPrice').value = '';
  document.getElementById('prodWholesalePrice').value = '';
  document.getElementById('prodCommission').value = '';
  document.getElementById('prodCommTab').value = '100tk';
  document.getElementById('prodStock').value = '50';

  // Clear photo inputs & reset preview
  const fileInput = document.getElementById('prodImageFile');
  if (fileInput) fileInput.value = '';
  document.getElementById('prodImageUrl').value = '';
  const manualInput = document.getElementById('prodManualImageUrl');
  if (manualInput) manualInput.value = '';
  const preview = document.getElementById('prodImagePreview');
  setAdminPreviewSrc(preview, '');
  const previewWrap = document.getElementById('prodImagePreviewWrap');
  if (previewWrap) previewWrap.style.display = 'none';
  const placeholder = document.getElementById('prodImagePlaceholder');
  if (placeholder) placeholder.style.display = 'block';
  const statusEl = document.getElementById('prodUploadStatus');
  if (statusEl) {
    statusEl.textContent = 'ছবি নির্বাচন করুন';
    statusEl.style.color = '';
  }
  const manualWrap = document.getElementById('manualUrlWrapper');
  if (manualWrap) manualWrap.style.display = 'none';

  document.getElementById('prodMaterials').value = '';
  document.getElementById('prodFinish').value = '';
  document.getElementById('prodDesc').value = '';
  const capInput = document.getElementById('prodCaption');
  if (capInput) capInput.value = '';
  await loadAdminShopOptions(preferredShopId || 2);
  if (preferredShopId) onProdShopChange(preferredShopId);
  updateLiveProfitCalculator();

  const aiBox = document.getElementById('aiImageInspectActionBox');
  if (aiBox) aiBox.style.display = 'none';
  initImageDragAndDropAndPaste();

  const furnHeightEl = document.getElementById('furnDimHeight');
  if (furnHeightEl) furnHeightEl.value = '72';
  const furnWidthEl = document.getElementById('furnDimWidth');
  if (furnWidthEl) furnWidthEl.value = '36';
  const furnDepthEl = document.getElementById('furnDimDepth');
  if (furnDepthEl) furnDepthEl.value = '18';
  const furnBoardEl = document.getElementById('furnBoardPrice');
  if (furnBoardEl) furnBoardEl.value = shopBoardPrice;
  const furnProviderBadge = document.getElementById('furnAiProviderBadge');
  if (furnProviderBadge) {
    furnProviderBadge.style.display = 'none';
    furnProviderBadge.textContent = '';
  }

  checkFurnitureCutlistVisibility();
  const tbody = document.getElementById('furniturePartsTableBody');
  if (tbody) tbody.replaceChildren();
  recalculateFurnitureCutlist();

  openModal('addProductModal');
}

function editProductModal(id) {
  const p = adminProductsList.find((item) => item.id === id);
  if (!p) return;

  prodSkuManuallyEdited = true;
  prodWholesaleManuallyEdited = true;
  prodCommissionManuallyEdited = true;

  document.getElementById('editProductId').value = p.id;
  document.getElementById('productFormTitle').textContent = `✏️ প্রোডাক্ট এডিট: ${p.sku}`;
  const submitBtn = document.getElementById('btnSubmitProduct');
  if (submitBtn) submitBtn.textContent = '✅ পরিবর্তন সংরক্ষণ করুন';
  const submitNextBtn = document.getElementById('btnSubmitAndNext');
  if (submitNextBtn) submitNextBtn.style.display = 'none';
  const advDetails = document.getElementById('prodAdvancedDetails');
  if (advDetails) advDetails.open = true;

  document.getElementById('prodTitle').value = p.title;
  document.getElementById('prodSku').value = p.sku;
  updateSkuSummaryBadge();
  document.getElementById('prodBrand').value = p.brand;
  document.getElementById('prodShopName').value = p.shop_name || p.brand || '';
  document.getElementById('prodVendorPhone').value = p.vendor_phone || '';
  document.getElementById('prodVendorBadge').value = p.vendor_badge || '';
  document.getElementById('prodVendorAddress').value = p.vendor_address || '';
  const catEl = document.getElementById('prodCategory');
  if (catEl && p.category && ![...catEl.options].some((o) => o.value === p.category)) {
    const opt = document.createElement('option');
    opt.value = p.category;
    opt.textContent = p.category;
    catEl.appendChild(opt);
  }
  if (catEl) catEl.value = p.category;
  document.getElementById('prodCommTab').value = p.commission_tab;
  document.getElementById('prodPrice').value = p.regular_price;
  document.getElementById('prodWholesalePrice').value = p.wholesale_price !== undefined ? p.wholesale_price : 0;
  document.getElementById('prodCommission').value = p.reseller_commission;
  document.getElementById('prodStock').value = p.stock;

  // Pre-fill image preview with existing product photo
  const fileInput = document.getElementById('prodImageFile');
  if (fileInput) fileInput.value = '';
  document.getElementById('prodImageUrl').value = p.image_url || '';
  const manualInput = document.getElementById('prodManualImageUrl');
  if (manualInput) manualInput.value = p.image_url || '';
  const preview = document.getElementById('prodImagePreview');
  const previewWrap = document.getElementById('prodImagePreviewWrap');
  const placeholder = document.getElementById('prodImagePlaceholder');
  const statusEl = document.getElementById('prodUploadStatus');

  if (p.image_url) {
    setAdminPreviewSrc(preview, safeAdminImageUrl(p.image_url));
    if (previewWrap) previewWrap.style.display = 'block';
    if (placeholder) placeholder.style.display = 'none';
    if (statusEl) {
      statusEl.textContent = 'বর্তমান ছবি সক্রিয়';
      statusEl.style.color = '#16a34a';
    }
  } else {
    setAdminPreviewSrc(preview, '');
    if (previewWrap) previewWrap.style.display = 'none';
    if (placeholder) placeholder.style.display = 'block';
    if (statusEl) {
      statusEl.textContent = 'ছবি নির্বাচন করুন';
      statusEl.style.color = '';
    }
  }
  const manualWrap = document.getElementById('manualUrlWrapper');
  if (manualWrap) manualWrap.style.display = 'none';

  document.getElementById('prodMaterials').value = p.materials || '';
  document.getElementById('prodFinish').value = p.finish || '';
  document.getElementById('prodDesc').value = p.description || '';
  const capEl = document.getElementById('prodCaption');
  if (capEl) capEl.value = p.caption || '';
  loadAdminShopOptions(p.shop_id);
  updateLiveProfitCalculator();

  const aiBox = document.getElementById('aiImageInspectActionBox');
  if (aiBox) aiBox.style.display = p.image_url ? 'block' : 'none';
  initImageDragAndDropAndPaste();

  checkFurnitureCutlistVisibility();
  const cut = p.furniture_cutlist && typeof p.furniture_cutlist === 'object' ? p.furniture_cutlist : null;
  const furnBoardEl = document.getElementById('furnBoardPrice');
  if (furnBoardEl) furnBoardEl.value = (cut && Number(cut.board_price) > 0) ? cut.board_price : shopBoardPrice;
  const dims = cut && cut.dimensions && typeof cut.dimensions === 'object' ? cut.dimensions : {};
  const furnHeightEl = document.getElementById('furnDimHeight');
  if (furnHeightEl) furnHeightEl.value = Number(dims.height) > 0 ? dims.height : 72;
  const furnWidthEl = document.getElementById('furnDimWidth');
  if (furnWidthEl) furnWidthEl.value = Number(dims.width) > 0 ? dims.width : 36;
  const furnDepthEl = document.getElementById('furnDimDepth');
  if (furnDepthEl) furnDepthEl.value = Number(dims.depth) > 0 ? dims.depth : 18;
  const furnProviderBadge = document.getElementById('furnAiProviderBadge');
  if (furnProviderBadge) {
    furnProviderBadge.style.display = 'none';
    furnProviderBadge.textContent = '';
  }

  const tbody = document.getElementById('furniturePartsTableBody');
  if (tbody) tbody.replaceChildren();
  if (cut && Array.isArray(cut.parts)) {
    cut.parts.forEach(part => addManualFurniturePartRow(part));
  }
  recalculateFurnitureCutlist();

  openModal('addProductModal');
}

async function submitProductForm(addAnother = false) {
  const id = document.getElementById('editProductId').value;
  const imageUrlVal = document.getElementById('prodImageUrl').value.trim();
  const brandVal = document.getElementById('prodBrand').value;
  const currentShopId = parseInt(document.getElementById('prodShopId').value, 10) || null;
  let skuVal = document.getElementById('prodSku').value.trim().toUpperCase();
  if (!skuVal) {
    skuVal = generateNextAvailableSku(brandVal);
    document.getElementById('prodSku').value = skuVal;
    updateSkuSummaryBadge();
  }

  const priceVal = parseFloat(document.getElementById('prodPrice').value);
  let commVal = parseFloat(document.getElementById('prodCommission').value);
  if (isNaN(commVal) && !isNaN(priceVal)) {
    commVal = priceVal >= 10000 ? 1000 : priceVal >= 2000 ? 500 : priceVal >= 500 ? 100 : 50;
    document.getElementById('prodCommission').value = commVal;
    syncCommissionTabFromAmount();
  }
  let wholesaleVal = parseFloat(document.getElementById('prodWholesalePrice').value);
  if (isNaN(wholesaleVal) && !isNaN(priceVal)) {
    wholesaleVal = Math.max(0, Math.round(priceVal - (commVal || 0) - priceVal * 0.15));
    document.getElementById('prodWholesalePrice').value = wholesaleVal;
  }

  const payload = {
    title: document.getElementById('prodTitle').value.trim(),
    sku: skuVal,
    brand: brandVal,
    shop_id: currentShopId,
    shop_name: document.getElementById('prodShopName').value.trim(),
    vendor_phone: document.getElementById('prodVendorPhone').value.trim(),
    vendor_badge: document.getElementById('prodVendorBadge').value.trim(),
    vendor_address: document.getElementById('prodVendorAddress').value.trim(),
    category: document.getElementById('prodCategory').value,
    commission_tab: document.getElementById('prodCommTab').value,
    regular_price: priceVal,
    wholesale_price: wholesaleVal || 0,
    reseller_commission: commVal || 0,
    stock: Number.isFinite(parseInt(document.getElementById('prodStock').value, 10)) ? parseInt(document.getElementById('prodStock').value, 10) : 50,
    image_url: imageUrlVal,
    materials: document.getElementById('prodMaterials').value.trim(),
    finish: document.getElementById('prodFinish').value.trim(),
    caption: document.getElementById('prodCaption')?.value.trim() || '',
    description: document.getElementById('prodDesc').value.trim()
  };

  const cutlistData = recalculateFurnitureCutlist();
  if (cutlistData.parts && cutlistData.parts.length > 0) {
    const dimH = parseFloat(document.getElementById('furnDimHeight')?.value);
    const dimW = parseFloat(document.getElementById('furnDimWidth')?.value);
    const dimD = parseFloat(document.getElementById('furnDimDepth')?.value);
    if (dimH > 0 || dimW > 0 || dimD > 0) {
      cutlistData.dimensions = {
        height: dimH > 0 ? dimH : 72,
        width: dimW > 0 ? dimW : 36,
        depth: dimD > 0 ? dimD : 18
      };
    }
    payload.furniture_cutlist = cutlistData;
  } else {
    payload.furniture_cutlist = null;
  }

  if (!payload.image_url) {
    return alert('অনুগ্রহ করে প্রথমে পণ্যের একটি ছবি আপলোড করুন বা লিংক দিন');
  }
  if (!payload.title || isNaN(payload.regular_price) || payload.regular_price <= 0) {
    return alert('অনুগ্রহ করে পণ্যের নাম এবং সঠিক বিক্রয় মূল্য লিখুন');
  }

  if (payload.wholesale_price + payload.reseller_commission > payload.regular_price) {
    return alert('সতর্কতা: পাইকারি ক্রয়মূল্য (' + payload.wholesale_price + '৳) ও রিসেলার কমিশনের (' + payload.reseller_commission + '৳) যোগফল বিক্রয় মূল্যের (' + payload.regular_price + '৳) চেয়ে বেশি হতে পারে না!');
  }

  const btnSave = document.getElementById('btnSubmitProduct');
  const btnNext = document.getElementById('btnSubmitAndNext');
  const prevText = btnSave ? btnSave.textContent : '';
  if (btnSave) { btnSave.disabled = true; btnSave.textContent = '⏳ সেভ হচ্ছে...'; }
  if (btnNext) btnNext.disabled = true;

  try {
    const url = id ? `/api/admin/products/${id}` : '/api/admin/products';
    const method = id ? 'PUT' : 'POST';

    const res = await fetch(api(url), {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (data.success) {
      unsavedUploadedImageUrls.delete(payload.image_url);
      cleanupAbandonedTempUploads();
      showToast(data.message);
      await loadAdminProducts();
      if (addAnother && !id) {
        await openAddProductModal(currentShopId);
      } else {
        closeModal('addProductModal');
      }
    } else {
      alert(data.message);
    }
  } catch (err) {
    console.error(err);
    alert('প্রোডাক্ট সেভ ব্যর্থ হয়েছে');
  } finally {
    if (btnSave) { btnSave.disabled = false; btnSave.textContent = prevText || '✅ প্রোডাক্ট সংরক্ষণ করুন'; }
    if (btnNext) btnNext.disabled = false;
  }
}

async function cleanupAbandonedTempUploads() {
  if (!adminToken || unsavedUploadedImageUrls.size === 0) return;
  const targets = [...unsavedUploadedImageUrls];
  unsavedUploadedImageUrls.clear();
  for (const url of targets) {
    fetch(api('/api/admin/upload-image'), {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({ url })
    }).catch(() => {});
  }
}

async function toggleProductActiveStatus(id, isActive) {
  try {
    const res = await fetch(api(`/api/admin/products/${id}/status`), {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({ is_active: isActive ? 1 : 0 })
    });
    const data = await res.json();
    if (data.success) {
      showToast(data.message);
      loadAdminProducts();
    } else {
      alert(data.message || 'স্ট্যাটাস পরিবর্তন ব্যর্থ হয়েছে');
    }
  } catch (err) {
    console.error(err);
    alert('স্ট্যাটাস পরিবর্তন ব্যর্থ হয়েছে');
  }
}

async function permanentDeleteProduct(id) {
  if (!confirm('সতর্কতা: এই প্রোডাক্টটি স্থায়ীভাবে মুছে ফেলতে চান? (পূর্বের অর্ডার না থাকলে ডাটা ও ছবি সম্পূর্ণ মুছে যাবে)')) return;
  try {
    const res = await fetch(api(`/api/admin/products/${id}?permanent=true`), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const data = await res.json();
    if (data.success) {
      showToast(data.message);
      loadAdminProducts();
    } else {
      alert(data.message);
    }
  } catch (err) {
    console.error(err);
    alert('স্থায়ী ডিলিট ব্যর্থ হয়েছে');
  }
}

async function deleteProduct(id) {
  if (!confirm('এই প্রোডাক্টটি ক্যাটালগ থেকে নিষ্ক্রিয় করতে চান?')) return;

  try {
    const res = await fetch(api(`/api/admin/products/${id}`), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const data = await res.json();
    if (data.success) {
      showToast(data.message);
      loadAdminProducts();
    } else {
      alert(data.message);
    }
  } catch (err) {
    console.error(err);
    alert('ডিলিট ব্যর্থ হয়েছে');
  }
}

function getStatusBadgeBg(status) {
  switch (status) {
    case 'pending': return '#d97706';
    case 'confirmed': return '#2563eb';
    case 'shipped': return '#8b5cf6';
    case 'delivered': return '#10b981';
    case 'cancelled': return '#ef4444';
    default: return '#44403c';
  }
}

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

let adminPromptSubmitHandler = null;

function openAdminPromptModal({
  title = 'তথ্য দিন',
  description = '',
  fields = [],
  submitText = 'নিশ্চিত করুন',
  onSubmit = null
}) {
  const modal = document.getElementById('adminActionPromptModal');
  const titleEl = document.getElementById('adminActionPromptTitle');
  const descEl = document.getElementById('adminActionPromptDesc');
  const fieldsEl = document.getElementById('adminActionPromptFields');
  const errorEl = document.getElementById('adminActionPromptError');
  const submitBtn = document.getElementById('adminActionPromptSubmit');
  if (!modal || !fieldsEl || !submitBtn) return false;

  if (titleEl) titleEl.textContent = title;
  if (descEl) {
    descEl.textContent = description;
    descEl.style.display = description ? 'block' : 'none';
  }
  if (errorEl) {
    errorEl.textContent = '';
    errorEl.style.display = 'none';
  }
  submitBtn.disabled = false;
  submitBtn.textContent = submitText;

  fieldsEl.replaceChildren();
  fields.forEach((f, idx) => {
    const group = document.createElement('div');
    group.className = 'form-group';
    group.style.marginBottom = idx === fields.length - 1 ? '4px' : '12px';

    if (f.label) {
      const label = document.createElement('label');
      label.className = 'form-label';
      label.htmlFor = `adminPromptField_${f.name}`;
      label.textContent = f.label;
      group.appendChild(label);
    }

    const input = document.createElement(f.type === 'textarea' ? 'textarea' : 'input');
    input.id = `adminPromptField_${f.name}`;
    input.name = f.name;
    input.className = 'form-control';
    if (f.type !== 'textarea') input.type = f.type || 'text';
    else input.rows = f.rows || 3;
    if (f.placeholder) input.placeholder = f.placeholder;
    if (f.value !== undefined && f.value !== null) input.value = String(f.value);
    if (f.min !== undefined) input.min = String(f.min);
    if (f.step !== undefined) input.step = String(f.step);
    if (f.required) input.required = true;
    group.appendChild(input);
    fieldsEl.appendChild(group);
  });

  adminPromptSubmitHandler = onSubmit;
  openModal('adminActionPromptModal');
  setTimeout(() => {
    const firstInput = fieldsEl.querySelector('input, textarea');
    if (firstInput) firstInput.focus();
  }, 40);
  return true;
}

async function submitAdminPromptModal() {
  if (typeof adminPromptSubmitHandler !== 'function') {
    closeModal('adminActionPromptModal');
    return;
  }
  const fieldsEl = document.getElementById('adminActionPromptFields');
  const errorEl = document.getElementById('adminActionPromptError');
  const submitBtn = document.getElementById('adminActionPromptSubmit');
  const values = {};
  if (fieldsEl) {
    fieldsEl.querySelectorAll('input, textarea').forEach((el) => {
      values[el.name] = el.value;
    });
  }
  if (errorEl) {
    errorEl.textContent = '';
    errorEl.style.display = 'none';
  }

  const showPromptError = (msg) => {
    if (errorEl) {
      errorEl.textContent = msg;
      errorEl.style.display = 'block';
    } else {
      showToast(msg, 'error');
    }
  };

  const prevText = submitBtn ? submitBtn.textContent : '';
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = '⏳ প্রক্রিয়াকরণ...';
  }
  try {
    const shouldClose = await adminPromptSubmitHandler(values, showPromptError);
    if (shouldClose !== false) {
      adminPromptSubmitHandler = null;
      closeModal('adminActionPromptModal');
    }
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = prevText;
    }
  }
}

function closeModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.classList.remove('active');
  if (id === 'addProductModal') {
    cleanupAbandonedTempUploads();
  }
  if (id === 'adminActionPromptModal') {
    adminPromptSubmitHandler = null;
  }
}

// Global escape key listener
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.active').forEach((m) => {
      if (m.id) closeModal(m.id);
      else m.classList.remove('active');
    });
  }
});

// ================= SECTION 4: ANALYTICS =================
async function loadAdminAnalytics() {
  const prodTbody = document.getElementById('analyticsTopProductsBody');
  const resTbody = document.getElementById('analyticsTopResellersBody');
  if (prodTbody) prodTbody.innerHTML = '<tr><td colspan="4" style="text-align: center; padding: 16px;"><span class="spinner"></span> এনালিটিক্স লোড হচ্ছে...</td></tr>';
  if (resTbody) resTbody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 16px;"><span class="spinner"></span> এনালিটিক্স লোড হচ্ছে...</td></tr>';

  try {
    const res = await fetch(api('/api/admin/analytics'), {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      const msg = escapeAdminHtml(data?.message || 'এনালিটিক্স লোড করা যায়নি');
      if (prodTbody) prodTbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: #dc2626; padding: 16px;">${msg}</td></tr>`;
      if (resTbody) resTbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: #dc2626; padding: 16px;">${msg}</td></tr>`;
      showToast(data?.message || 'এনালিটিক্স লোড করা যায়নি', 'error');
      return;
    }

    const { top_products, top_resellers } = data.analytics;

    if (prodTbody) {
      if (top_products.length === 0) {
        prodTbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--sbf-text-muted); padding: 16px;">এখনও কোনো বিক্রয় তথ্য নেই।</td></tr>';
      } else {
        prodTbody.innerHTML = top_products.map((p) => `
          <tr>
            <td data-label="SKU"><strong>${escapeAdminHtml(p.sku)}</strong></td>
            <td data-label="পণ্যের নাম">${escapeAdminHtml(p.title)}</td>
            <td data-label="বিক্রিত পরিমাণ"><strong style="color: var(--sbp-yellow);">${escapeAdminHtml(p.total_units_sold)} টি</strong></td>
            <td data-label="মোট বিক্রয়"><strong>${escapeAdminHtml(p.total_sales_volume)} ৳</strong></td>
          </tr>
        `).join('');
      }
    }

    if (resTbody) {
      if (top_resellers.length === 0) {
        resTbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--sbf-text-muted); padding: 16px;">এখনও কোনো সফল রিসেলার সেল নেই।</td></tr>';
      } else {
        resTbody.innerHTML = top_resellers.map((r) => `
          <tr>
            <td data-label="রিসেলার"><strong>${escapeAdminHtml(r.name)}</strong></td>
            <td data-label="মোবাইল নম্বর">${escapeAdminHtml(r.phone)}</td>
            <td data-label="সফল সেলস"><strong style="color: #10b981;">${escapeAdminHtml(r.delivered_sales_count)} টি</strong></td>
            <td data-label="মোট সেলস"><strong>${escapeAdminHtml(r.total_volume)} ৳</strong></td>
            <td data-label="মোট কমিশন"><strong style="color: var(--sbp-yellow);">${escapeAdminHtml(r.total_commission_earned)} ৳</strong></td>
          </tr>
        `).join('');
      }
    }
  } catch (err) {
    console.error('Analytics Fetch Error:', err);
    if (prodTbody) prodTbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: #dc2626; padding: 16px;">এনালিটিক্স ডাটা লোড করতে সমস্যা হয়েছে।</td></tr>';
    if (resTbody) resTbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: #dc2626; padding: 16px;">এনালিটিক্স ডাটা লোড করতে সমস্যা হয়েছে।</td></tr>';
    showToast('এনালিটিক্স লোড করতে সমস্যা হয়েছে', 'error');
  }
}

// ================= AUDIT TRAIL MODAL =================
async function viewOrderAuditTrail(orderId) {
  document.getElementById('auditModalTitle').textContent = `অর্ডার #${orderId} — স্ট্যাটাস অডিট ট্রেইল`;
  const body = document.getElementById('auditModalBody');
  body.innerHTML = '<div style="text-align: center; padding: 20px;"><span class="spinner"></span> অডিট হিস্ট্রি লোড হচ্ছে...</div>';
  openModal('orderAuditModal');

  try {
    const res = await fetch(api(`/api/admin/orders/${orderId}/audit-trail`), {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const data = await res.json();

    if (!data.success || !data.audit_trail || data.audit_trail.length === 0) {
      body.innerHTML = '<div style="text-align: center; padding: 16px; color: var(--sbf-text-muted);">এই অর্ডারের কোনো পূর্ববর্তী অডিট রেকর্ড নেই।</div>';
      return;
    }

    body.innerHTML = `
      <div class="table-responsive">
        <table>
          <thead>
            <tr>
              <th>তারিখ ও সময়</th>
              <th>পূর্বের স্ট্যাটাস</th>
              <th>নতুন স্ট্যাটাস</th>
              <th>পরিবর্তনকারী</th>
              <th>নোট / মন্তব্য</th>
            </tr>
          </thead>
          <tbody>
            ${data.audit_trail.map((log) => `
              <tr>
                <td style="font-size: 0.75rem; color: #a8a29e;">${new Date(log.created_at).toLocaleString('bn-BD')}</td>
                <td><span style="font-size: 0.75rem; color: #a8a29e;">${escapeAdminHtml(log.previous_status || 'শুরু')}</span></td>
                <td><span style="background: ${getStatusBadgeBg(log.new_status)}; color: #fff; padding: 2px 6px; border-radius: 4px; font-size: 0.72rem; font-weight: 700;">${escapeAdminHtml(log.new_status)}</span></td>
                <td>${escapeAdminHtml(log.admin_name || 'সিস্টেম')}</td>
                <td style="font-size: 0.78rem;">${escapeAdminHtml(log.notes || '-')}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  } catch (err) {
    body.innerHTML = '<div style="color: var(--sbp-red); text-align: center; padding: 16px;">লোড ব্যর্থ হয়েছে।</div>';
  }
}

// ================= SECTION 5: ANNOUNCEMENTS =================
let adminAnnouncementsList = [];

async function loadAdminAnnouncements() {
  const tbody = document.getElementById('adminAnnouncementsTableBody');
  tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 16px;"><span class="spinner"></span> ঘোষণা লোড হচ্ছে...</td></tr>';

  try {
    const res = await fetch(api('/api/admin/announcements'), {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const data = await res.json();

    if (!data.success || data.announcements.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--sbf-text-muted); padding: 16px;">কোনো সক্রিয় ঘোষণা নেই।</td></tr>';
      return;
    }

    adminAnnouncementsList = data.announcements;

    tbody.innerHTML = data.announcements.map((a) => `
      <tr>
        <td data-label="আইডি">#${a.id}</td>
        <td data-label="শিরোনাম"><strong>${escapeAdminHtml(a.title)}</strong></td>
        <td data-label="বার্তা" style="max-width: 260px;">${escapeAdminHtml(a.message)}</td>
        <td data-label="ধরন"><span class="adm-pill-neutral">${escapeAdminHtml(a.type)}</span></td>
        <td data-label="স্ট্যাটাস"><span style="color: ${a.is_active ? '#047857' : '#dc2626'}; font-weight: 700;">${a.is_active ? 'সক্রিয়' : 'নিষ্ক্রিয়'}</span></td>
        <td data-label="অ্যাকশন">
          <div style="display: flex; gap: 6px;">
            <button class="action-btn-sm btn-ship" onclick="editAnnouncementModal(${a.id})">এডিট</button>
            <button class="action-btn-sm btn-cancel" onclick="deleteAnnouncement(${a.id})">মুছুন</button>
          </div>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="6" style="color: var(--sbp-red); text-align: center;">লোড ব্যর্থ হয়েছে</td></tr>';
  }
}

function openAddAnnouncementModal() {
  document.getElementById('editAnnouncementId').value = '';
  document.getElementById('announcementModalTitle').textContent = 'নতুন অফার / নোটিশ';
  document.getElementById('annTitle').value = '';
  document.getElementById('annMessage').value = '';
  document.getElementById('annType').value = 'flash_deal';
  document.getElementById('annActive').value = '1';
  openModal('announcementModal');
}

function editAnnouncementModal(id) {
  const a = adminAnnouncementsList.find((x) => x.id === id);
  if (!a) return;
  document.getElementById('editAnnouncementId').value = a.id;
  document.getElementById('announcementModalTitle').textContent = `ঘোষণা এডিট #${a.id}`;
  document.getElementById('annTitle').value = a.title;
  document.getElementById('annMessage').value = a.message;
  document.getElementById('annType').value = a.type || 'flash_deal';
  document.getElementById('annActive').value = String(a.is_active !== undefined ? a.is_active : 1);
  openModal('announcementModal');
}

async function submitAnnouncementForm() {
  const id = document.getElementById('editAnnouncementId').value;
  const title = document.getElementById('annTitle').value.trim();
  const message = document.getElementById('annMessage').value.trim();
  const type = document.getElementById('annType').value;
  const is_active = parseInt(document.getElementById('annActive').value, 10);

  if (!title || !message) return alert('শিরোনাম ও বার্তা পূরণ করুন');

  try {
    const url = id ? `/api/admin/announcements/${id}` : '/api/admin/announcements';
    const method = id ? 'PUT' : 'POST';

    const res = await fetch(api(url), {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({ title, message, type, is_active })
    });
    const data = await res.json();
    if (data.success) {
      showToast(data.message);
      closeModal('announcementModal');
      loadAdminAnnouncements();
    } else {
      alert(data.message);
    }
  } catch (err) {
    alert('ঘোষণা সংরক্ষণ ব্যর্থ হয়েছে');
  }
}

async function deleteAnnouncement(id) {
  if (!confirm('ঘোষণাটি মুছে ফেলতে চান?')) return;
  try {
    const res = await fetch(api(`/api/admin/announcements/${id}`), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const data = await res.json();
    if (data.success) {
      showToast(data.message);
      loadAdminAnnouncements();
    } else {
      alert(data.message);
    }
  } catch (err) {
    alert('মুছতে ব্যর্থ হয়েছে');
  }
}

// ================= DATABASE BACKUP & DATA SAFETY =================
async function triggerInstantBackup() {
  if (!confirm('ডাটাবেজের একটি নতুন স্ন্যাপশট ব্যাকআপ তৈরি করতে চান?')) return;
  try {
    showToast('⏳ ডাটাবেজ ব্যাকআপ তৈরি হচ্ছে...');
    const res = await fetch(api('/api/admin/backup'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const data = await res.json();
    if (data.success) {
      const cloud = data.backup && data.backup.cloudBackup;
      if (cloud && cloud.success) {
        showToast(`🎉 ফোনে ও Firebase-এ ব্যাকআপ হয়েছে: ${escapeAdminHtml(data.backup.filename)}`);
      } else if (cloud && cloud.configured) {
        showToast('ফোনে ব্যাকআপ হয়েছে; Firebase upload ব্যর্থ। পরে আবার চেষ্টা করুন।');
      } else {
        showToast(`ফোনে ব্যাকআপ হয়েছে: ${escapeAdminHtml(data.backup.filename)}; Firebase এখনো সেটআপ হয়নি।`);
      }
      loadAdminBackupsList();
    } else {
      alert(`ব্যাকআপ ব্যর্থ: ${data.message}`);
    }
  } catch (err) {
    console.error(err);
    alert('ব্যাকআপ নিতে ব্যর্থ হয়েছে');
  }
}

async function loadAdminBackupsList() {
  const container = document.getElementById('adminBackupsList');
  if (!container) return;
  container.innerHTML = '<div style="color: var(--sbf-text-muted); padding: 8px;">ব্যাকআপ তালিকা লোড হচ্ছে...</div>';

  try {
    const res = await fetch(api('/api/admin/backups'), {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const data = await res.json();
    const firebaseStatus = data.firebaseBackup;
    let firebaseNotice = '';
    if (firebaseStatus && firebaseStatus.configured && firebaseStatus.lastSuccessAt) {
      firebaseNotice = `<div class="admin-backup-cloud-status" role="status">Firebase encrypted backup চালু · শেষ সফল কপি: ${new Date(firebaseStatus.lastSuccessAt).toLocaleString('bn-BD')}${firebaseStatus.lastErrorCode === 'retention_cleanup_failed' ? ' · পুরোনো কপি পরিষ্কার হয়নি' : ''}</div>`;
    } else if (firebaseStatus && firebaseStatus.configured) {
      firebaseNotice = '<div class="admin-backup-cloud-status is-pending" role="status">Firebase backup সেটআপ হয়েছে; প্রথম cloud backup-এর অপেক্ষায়।</div>';
    } else {
      firebaseNotice = '<div class="admin-backup-cloud-status is-pending" role="status">এখন শুধু ফোনে backup আছে। Firebase cloud backup চালু হয়নি।</div>';
    }
    if (!data.success || !data.backups || data.backups.length === 0) {
      container.innerHTML = `${firebaseNotice}<div style="color: var(--sbf-text-muted); padding: 8px;">কোনো local backup পাওয়া যায়নি।</div>`;
      return;
    }

    window._adminBackups = data.backups;

    container.innerHTML = firebaseNotice + data.backups.map((b) => `
      <div class="adm-backup-item">
        <div>
          <strong class="adm-backup-filename">${escapeAdminHtml(b.filename)}</strong>
          <div class="adm-cell-meta">সাইজ: ${b.sizeFormatted} • সময়: ${new Date(b.createdAt).toLocaleString('bn-BD')}</div>
        </div>
        <button onclick="downloadBackupFile(${data.backups.indexOf(b)})" class="action-btn-sm btn-ship" style="padding: 7px 14px;">⬇️ ডাউনলোড</button>
      </div>
    `).join('');
  } catch (err) {
    container.innerHTML = '<div style="color: var(--sbp-red); padding: 8px;">ব্যাকআপ লোড ব্যর্থ হয়েছে।</div>';
  }
}

async function downloadBackupFile(index) {
  try {
    const backup = window._adminBackups && window._adminBackups[index];
    if (!backup || typeof backup.filename !== 'string') return showToast('ব্যাকআপ তথ্য পাওয়া যায়নি।');
    const filename = backup.filename;
    showToast('⏳ ব্যাকআপ ফাইল ডাউনলোড হচ্ছে...');
    const url = api(`/api/admin/backups/download/${encodeURIComponent(filename)}`);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${adminToken}` } });
    if (!res.ok) throw new Error('ডাউনলোড ব্যর্থ');
    const blob = await res.blob();
    const downloadUrl = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(downloadUrl);
    showToast('✅ ব্যাকআপ ফাইল সফলভাবে ডাউনলোড হয়েছে!');
  } catch (err) {
    showToast('ব্যাকআপ ফাইল ডাউনলোড ব্যর্থ হয়েছে। আবার চেষ্টা করুন।');
  }
}

// ================= FURNITURE AI CUTLIST & BOARD CALCULATOR =================
function isFurnitureCategory(cat) {
  if (!cat) return false;
  const s = String(cat).toLowerCase();
  return s.includes('ফার্নিচার') || s.includes('ডেকোরেশন') || s.includes('furniture') || s.includes('decoration');
}

function checkFurnitureCutlistVisibility() {
  const catEl = document.getElementById('prodCategory');
  const box = document.getElementById('furnitureAiCutlistBox');
  if (!box || !catEl) return;
  box.style.display = isFurnitureCategory(catEl.value) ? 'block' : 'none';
}

function addManualFurniturePartRow(part = null) {
  const tbody = document.getElementById('furniturePartsTableBody');
  if (!tbody) return;

  const row = document.createElement('tr');
  row.style.borderBottom = '1px solid #fef3c7';
  row.innerHTML = `
    <td style="padding: 4px;">
      <input type="text" class="form-control part-name" style="padding: 4px 6px; font-size: 0.78rem;" placeholder="পার্টসের নাম" value="${part ? escapeAdminHtml(part.name) : ''}">
    </td>
    <td style="padding: 4px;">
      <input type="number" class="form-control part-length" style="padding: 4px 6px; font-size: 0.78rem;" placeholder="দৈর্ঘ্য" value="${part ? part.length : ''}" step="0.1" min="1" oninput="recalculateFurnitureCutlist()">
    </td>
    <td style="padding: 4px;">
      <input type="number" class="form-control part-width" style="padding: 4px 6px; font-size: 0.78rem;" placeholder="প্রস্থ" value="${part ? part.width : ''}" step="0.1" min="1" oninput="recalculateFurnitureCutlist()">
    </td>
    <td style="padding: 4px;">
      <input type="number" class="form-control part-qty" style="padding: 4px 6px; font-size: 0.78rem;" placeholder="পিস" value="${part ? part.qty : 1}" min="1" oninput="recalculateFurnitureCutlist()">
    </td>
    <td style="padding: 4px; text-align: center;">
      <button type="button" class="btn-text-link" style="color: #ef4444; font-size: 0.9rem; font-weight: bold;" onclick="removeManualFurniturePartRow(this)">&times;</button>
    </td>
  `;
  tbody.appendChild(row);
  recalculateFurnitureCutlist();
}

function removeManualFurniturePartRow(btn) {
  const tr = btn.closest('tr');
  if (tr) {
    tr.remove();
    recalculateFurnitureCutlist();
  }
}

function getCollectedFurnitureParts() {
  const rows = document.querySelectorAll('#furniturePartsTableBody tr');
  const parts = [];
  rows.forEach((r, idx) => {
    const name = r.querySelector('.part-name')?.value.trim() || `পার্ট #${idx + 1}`;
    const length = parseFloat(r.querySelector('.part-length')?.value) || 0;
    const width = parseFloat(r.querySelector('.part-width')?.value) || 0;
    const qty = parseInt(r.querySelector('.part-qty')?.value, 10) || 1;
    if (length > 0 && width > 0) {
      parts.push({ name, length, width, qty });
    }
  });
  return parts;
}

let shopBoardPrice = window.SBCutlistCalculator.DEFAULT_BOARD_PRICE;
const BOARD_PRICE_INPUTS = ['furnBoardPrice', 'cutDbBoardPrice'];

// One place that turns the shop rate into both panels' board-price inputs.
function applyShopBoardPrice(price, overwriteInputs) {
  shopBoardPrice = price;
  BOARD_PRICE_INPUTS.forEach((id) => {
    const input = document.getElementById(id);
    if (input && (overwriteInputs || !input.value)) input.value = shopBoardPrice;
  });
  recalculateFurnitureCutlist();
}

async function loadShopSettings() {
  try {
    const res = await fetch(api('/api/admin/shop-settings'), {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const data = await res.json();
    if (!data.success) return;
    applyShopBoardPrice(data.settings.board_price, false);
  } catch (err) {
    console.error('Shop settings load error:', err);
  }
}

async function saveShopBoardPrice(value) {
  const price = parseFloat(value);
  if (!(price > 0)) return;
  try {
    const res = await fetch(api('/api/admin/shop-settings'), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({ board_price: price })
    });
    const data = await res.json();
    if (!data.success) {
      showToast(data.message || 'বোর্ডের দর সেভ করা যায়নি', 'error');
      return;
    }
    applyShopBoardPrice(data.settings.board_price, true);
    recalcCutlistDbEditor();
    showToast(`✅ শপ বোর্ড দর ${shopBoardPrice}৳ সেভ হয়েছে`);
  } catch (err) {
    console.error('Shop settings save error:', err);
    showToast('বোর্ডের দর সেভ করা যায়নি', 'error');
  }
}

function recalculateFurnitureCutlist() {
  const parts = getCollectedFurnitureParts();
  const boardPrice = parseFloat(document.getElementById('furnBoardPrice')?.value) || shopBoardPrice;
  const calc = window.SBCutlistCalculator.calculateCutlist(parts, { boardPrice });

  const boardsBadge = document.getElementById('furnTotalBoardsBadge');
  const wastageBadge = document.getElementById('furnWastageBadge');
  const costText = document.getElementById('furnBoardCostText');
  const warningsEl = document.getElementById('furnCutlistWarnings');

  if (boardsBadge) boardsBadge.textContent = `${calc.total_boards} টি`;
  if (wastageBadge) wastageBadge.textContent = `(মোট: ${calc.total_area_sqft} sq.ft, অপচয়: ${calc.wastage_pct}%)`;
  if (costText) costText.textContent = `${calc.estimated_board_cost} ৳`;
  if (warningsEl) {
    warningsEl.textContent = calc.warnings.join(' ');
    warningsEl.style.display = calc.warnings.length > 0 ? 'block' : 'none';
  }

  return calc;
}

function applyFurnitureBoardCostToWholesale() {
  const calc = recalculateFurnitureCutlist();
  if (calc.estimated_board_cost > 0) {
    const wholesaleInput = document.getElementById('prodWholesalePrice');
    if (wholesaleInput) {
      wholesaleInput.value = calc.estimated_board_cost;
      markPricingManual('wholesale');
      updateLiveProfitCalculator();
      showToast(`✅ বোর্ডের খরচ ${calc.estimated_board_cost}৳ পাইকারি মূল্যে যুক্ত হয়েছে!`);
    }
  } else {
    showToast('প্রথমে পার্টস যুক্ত করে বোর্ডের খরচ হিসাব করুন', 'error');
  }
}

async function runFurnitureAiEstimate() {
  const btn = document.getElementById('btnRunFurnitureAi');
  const title = document.getElementById('prodTitle')?.value.trim() || 'ফার্নিচার';
  const height = parseFloat(document.getElementById('furnDimHeight')?.value) || 72;
  const width = parseFloat(document.getElementById('furnDimWidth')?.value) || 36;
  const depth = parseFloat(document.getElementById('furnDimDepth')?.value) || 18;
  const boardPrice = parseFloat(document.getElementById('furnBoardPrice')?.value) || shopBoardPrice;

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '⏳ হিসাব হচ্ছে...';
  }

  try {
    const res = await fetch(api('/api/admin/furniture/estimate'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        furniture_type: window.SBCutlistCalculator.detectFurnitureType(title),
        height,
        width,
        depth,
        board_price: boardPrice
      })
    });

    const data = await res.json();
    if (data.success && Array.isArray(data.parts)) {
      const tbody = document.getElementById('furniturePartsTableBody');
      if (tbody) tbody.replaceChildren();
      data.parts.forEach(part => addManualFurniturePartRow(part));
      recalculateFurnitureCutlist();

      const providerBadge = document.getElementById('furnAiProviderBadge');
      if (providerBadge) {
        providerBadge.style.display = 'block';
        providerBadge.textContent = `মডেল: ${data.provider_used || 'AI'}`;
      }
      showToast(`🤖 AI সফলভাবে ${data.parts.length}টি পার্টস ও ${data.total_boards}টি বোর্ডের হিসাব প্রস্তুত করেছে!`);
    } else {
      alert(data.message || 'হিসাব করতে সমস্যা হয়েছে');
    }
  } catch (err) {
    console.error('AI estimate error:', err);
    alert('এআই সার্ভারে সংযোগ পাওয়া যায়নি।');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '⚡ AI দিয়ে কাট-লিস্ট হিসাব করুন';
    }
  }
}

// ================= AI VISION PRODUCT AUTOLISTING & DRAG-AND-DROP =================
let dragDropInitialized = false;

function initImageDragAndDropAndPaste() {
  if (dragDropInitialized) return;
  dragDropInitialized = true;

  const dropzone = document.getElementById('prodUploadDropzone');
  if (dropzone) {
    ['dragenter', 'dragover'].forEach(eventName => {
      dropzone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzone.style.borderColor = '#7c3aed';
        dropzone.style.background = '#f5f3ff';
      }, false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
      dropzone.addEventListener(eventName, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropzone.style.borderColor = '';
        dropzone.style.background = '';
      }, false);
    });

    dropzone.addEventListener('drop', (e) => {
      const dt = e.dataTransfer;
      const file = dt && dt.files && dt.files[0];
      if (file && file.type.startsWith('image/')) {
        processProductImageFile(file);
      }
    });
  }

  // Global paste handler when modal is active
  window.addEventListener('paste', (e) => {
    const modal = document.getElementById('addProductModal');
    if (!modal || !modal.classList.contains('active')) return;
    const items = (e.clipboardData || e.originalEvent?.clipboardData)?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type && items[i].type.indexOf('image') !== -1) {
        const file = items[i].getAsFile();
        if (file) {
          e.preventDefault();
          processProductImageFile(file);
          showToast('📋 ক্লিপবোর্ড থেকে ছবি পেস্ট করা হয়েছে!');
          break;
        }
      }
    }
  });
}

function syncOwnShopByBrand(brandOrIsFurniture) {
  const shopSelect = document.getElementById('prodShopId');
  const brandSelect = document.getElementById('prodBrand');
  const targetBrand = typeof brandOrIsFurniture === 'string'
    ? brandOrIsFurniture
    : (brandOrIsFurniture ? 'SB Furniture' : 'SB POWER');
  if (brandSelect) brandSelect.value = targetBrand;

  if (!shopSelect) return;
  const currentShop = adminShopsList.find((s) => String(s.id) === String(shopSelect.value));
  // Preserve explicitly chosen partner shop; only switch automatically among own-brand shops.
  if (currentShop && currentShop.shop_type !== 'own') return;

  const targetShop = adminShopsList.find((s) => s.shop_type === 'own' && s.name === targetBrand);
  if (targetShop) {
    shopSelect.value = String(targetShop.id);
    onProdShopChange(targetShop.id);
  } else {
    const shopNameEl = document.getElementById('prodShopName');
    if (shopNameEl) shopNameEl.value = targetBrand;
    const isNew = !document.getElementById('editProductId')?.value;
    if (isNew && !prodSkuManuallyEdited) {
      document.getElementById('prodSku').value = generateNextAvailableSku(targetBrand);
      updateSkuSummaryBadge();
    }
  }
}

function applyAiProductAnalysisToForm(analysis, providerFallbackLabel) {
  const a = analysis || {};
  const isCreatingNew = !document.getElementById('editProductId')?.value;

  if (a.title) document.getElementById('prodTitle').value = a.title;
  if (a.materials) document.getElementById('prodMaterials').value = a.materials;
  if (a.finish) document.getElementById('prodFinish').value = a.finish;
  if (a.description) document.getElementById('prodDesc').value = a.description;
  const capEl = document.getElementById('prodCaption');
  if (capEl && a.caption) capEl.value = a.caption;

  const isFurn = (typeof a.is_furniture === 'boolean')
    ? a.is_furniture
    : isFurnitureCategory(a.category || document.getElementById('prodCategory')?.value);

  const catSelect = document.getElementById('prodCategory');
  if (catSelect && a.category) {
    let matched = false;
    for (let i = 0; i < catSelect.options.length; i++) {
      if (catSelect.options[i].value === a.category || catSelect.options[i].text.includes(a.category)) {
        catSelect.selectedIndex = i;
        matched = true;
        break;
      }
    }
    if (!matched) {
      catSelect.value = isFurn ? 'হোম ও অফিস ফার্নিচার' : 'ওয়্যারলেস অডিও ও গ্যাজেটস';
    }
  }

  const targetBrand = a.brand || inferBrandFromCategoryName(catSelect?.value || a.category);
  syncOwnShopByBrand(targetBrand);

  const shouldFillPrice = (input) => input && (isCreatingNew || !input.value || input.value === '0');
  if (a.suggested_retail_price) {
    const pInput = document.getElementById('prodPrice');
    if (shouldFillPrice(pInput)) pInput.value = a.suggested_retail_price;
  }
  if (a.suggested_wholesale_price !== undefined) {
    const wpInput = document.getElementById('prodWholesalePrice');
    if (shouldFillPrice(wpInput)) wpInput.value = a.suggested_wholesale_price;
  }
  if (a.suggested_commission !== undefined) {
    const cInput = document.getElementById('prodCommission');
    if (shouldFillPrice(cInput)) cInput.value = a.suggested_commission;
    syncCommissionTabFromAmount();
  }
  updateLiveProfitCalculator();

  const cutlistBox = document.getElementById('furnitureAiCutlistBox');
  if (isFurn) {
    if (cutlistBox) cutlistBox.style.display = 'block';
    if (a.estimated_dimensions) {
      if (a.estimated_dimensions.height) document.getElementById('furnDimHeight').value = a.estimated_dimensions.height;
      if (a.estimated_dimensions.width) document.getElementById('furnDimWidth').value = a.estimated_dimensions.width;
      if (a.estimated_dimensions.depth) document.getElementById('furnDimDepth').value = a.estimated_dimensions.depth;
    }

    const tbody = document.getElementById('furniturePartsTableBody');
    if (tbody) tbody.replaceChildren();
    if (a.cutlist && Array.isArray(a.cutlist.parts) && a.cutlist.parts.length > 0) {
      a.cutlist.parts.forEach((p) => addManualFurniturePartRow(p));
    }
    recalculateFurnitureCutlist();

    const providerBadge = document.getElementById('furnAiProviderBadge');
    if (providerBadge && providerFallbackLabel) {
      providerBadge.style.display = 'block';
      providerBadge.textContent = `${providerFallbackLabel}: ${a.provider_used || 'AI'}`;
    }
  } else if (cutlistBox) {
    cutlistBox.style.display = 'none';
  }

  const skuEl = document.getElementById('prodSku');
  if (skuEl && (!skuEl.value.trim() || !prodSkuManuallyEdited)) {
    skuEl.value = generateNextAvailableSku(targetBrand);
    updateSkuSummaryBadge();
  }
}

async function runAiProductImageInspection() {
  const btn = document.getElementById('btnAiInspectImage');
  const statusText = document.getElementById('aiVisionStatusText');
  const imageUrl = document.getElementById('prodImageUrl')?.value?.trim();
  const preview = document.getElementById('prodImagePreview');
  const boardPrice = parseFloat(document.getElementById('furnBoardPrice')?.value) || shopBoardPrice;

  let imagePayload = null;
  if (preview && preview.src && preview.src.startsWith('data:image')) {
    imagePayload = { image: preview.src, board_price: boardPrice };
  } else if (imageUrl) {
    imagePayload = { image_url: imageUrl, board_price: boardPrice };
  } else {
    return alert('অনুগ্রহ করে প্রথমে একটি ছবি আপলোড করুন');
  }

  if (btn) btn.disabled = true;
  if (statusText) {
    statusText.style.display = 'block';
    statusText.innerHTML = '🔍 AI যেকোনো পণ্যের ছবি (গ্যাজেট বা ফার্নিচার) বিশ্লেষণ করছে...';
  }

  try {
    const res = await fetch(api('/api/admin/ai/inspect-image'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify(imagePayload)
    });

    const data = await res.json();
    if (!data.success || !data.analysis) {
      throw new Error(data.message || 'বিশ্লেষণ ব্যর্থ হয়েছে');
    }

    applyAiProductAnalysisToForm(data.analysis, 'ভিশন মডেল');
    showToast('✨ AI সফলভাবে পণ্যের বিবরণ, ক্যাপশন, ক্যাটাগরি ও মূল্য নির্ধারণ করেছে!');
  } catch (err) {
    console.error('Vision inspection error:', err);
    alert('ছবি বিশ্লেষণে সমস্যা হয়েছে: ' + (err.message || 'ইন্টারনেট বা সার্ভার চেক করুন'));
  } finally {
    if (btn) btn.disabled = false;
    if (statusText) statusText.style.display = 'none';
  }
}

// ================= AI TEXT / KEYWORD COPY GENERATOR =================
async function runAiCopyFromTitleOrKeywords() {
  const titleInput = document.getElementById('prodTitle');
  const keywords = titleInput ? titleInput.value.trim() : '';
  if (!keywords) {
    return alert('অনুগ্রহ করে পণ্যের নাম বা কিছু কীওয়ার্ড টাইপ করুন (যেমন: T900 Ultra 2 Smartwatch অথবা ৩ দরজার মেলামাইন আলমারি)');
  }

  const btn = document.getElementById('btnAiGenCopy');
  const statusText = document.getElementById('aiTextGenStatus');
  const catVal = document.getElementById('prodCategory')?.value || '';
  const boardPrice = parseFloat(document.getElementById('furnBoardPrice')?.value) || shopBoardPrice;

  if (btn) btn.disabled = true;
  if (statusText) {
    statusText.style.display = 'block';
    statusText.innerHTML = '⏳ AI টাইটেল বিশ্লেষণ করে বাংলা বিবরণ, ক্যাপশন ও মূল্য প্রস্তুত করছে...';
  }

  try {
    const res = await fetch(api('/api/admin/ai/generate-copy'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({ keywords, category: catVal, board_price: boardPrice })
    });

    const data = await res.json();
    if (!data.success || !data.analysis) {
      throw new Error(data.message || 'বিবরণ তৈরিতে ব্যর্থ হয়েছে');
    }

    applyAiProductAnalysisToForm(data.analysis);
    showToast('✨ AI বিবরণ, সোশ্যাল ক্যাপশন ও মূল্য সফলভাবে পূরণ করেছে!');
  } catch (err) {
    alert('AI কপি জেনারেশনে ত্রুটি: ' + (err.message || 'ইন্টারনেট বা সার্ভার চেক করুন'));
  } finally {
    if (btn) btn.disabled = false;
    if (statusText) statusText.style.display = 'none';
  }
}

function copyFieldValue(fieldId, successMsg = 'কপি হয়েছে!') {
  const el = document.getElementById(fieldId);
  if (!el || !el.value) return;

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(el.value).then(() => showToast(`📋 ${successMsg}`));
  } else {
    el.select();
    document.execCommand('copy');
    showToast(`📋 ${successMsg}`);
  }
}

// ================= BUSINESS GROWTH ACCELERATORS =================
let currentMarketingData = null;
let currentMarketingTab = 'fb';

function fallbackMarketingCopy(p) {
  const isFurniture = p.brand === 'SB Furniture' || (p.category && p.category.includes('ফার্নিচার'));
  const contactPhone = isFurniture ? '01929621855' : '01634664224';
  const siteUrl = window.location.origin;
  const link = `${siteUrl}/?sku=${encodeURIComponent(p.sku)}`;

  let fb = `🔥 ${p.title}\n`;
  fb += `━━━━━━━━━━━━━━━━━━━━━\n`;
  fb += `💵 বিক্রয় মূল্য: ${p.regular_price} ৳\n`;
  if (p.reseller_commission > 0) fb += `💰 রিসেলার কমিশন: ${p.reseller_commission} ৳\n`;
  if (p.materials) fb += `🪵 উপাদান: ${p.materials}\n`;
  if (p.finish) fb += `🎨 কালার/ফিনিশ: ${p.finish}\n`;
  fb += `📦 বর্তমান স্টক: ${p.stock} টি এভেইলেবল\n`;
  fb += `━━━━━━━━━━━━━━━━━━━━━\n`;
  if (p.caption) fb += `✨ ${p.caption}\n\n`;
  if (p.description) fb += `📌 বিস্তারিত বিবরণ:\n${p.description}\n\n`;
  fb += `✅ ১০০% কোয়ালিটি ও নিরাপদ ক্যাশ অন ডেলিভারি নিশ্চয়তা\n`;
  fb += `🌐 সরাসরি অর্ডার করুন: ${link}\n`;
  fb += `📞 ইনবক্স বা WhatsApp: ${contactPhone}`;

  let tiktok = `🎬 [শর্ট ভিডিও স্ক্রিপ্ট — ১৫ থেকে ৩০ সেকেন্ড]\n\n[ভিজ্যুয়াল হুক]: ${p.title} এর সেরা লুক দেখান!\n[ভয়েসওভার]: "খুঁজছেন সেরা কোয়ালিটির প্রোডাক্ট? মাত্র ${p.regular_price} টাকায় পেয়ে যাচ্ছেন ক্যাশ অন ডেলিভারিতে!"\n[কল-টু-অ্যাকশন]: এখনই বায়ো লিংকে যান বা ইনবক্স করুন।`;

  let reseller = `💼 [রিসেলার প্রমোশন টিপস]\n\nপণ্য: ${p.title}\nকমিশন: প্রতি পিসে ${p.reseller_commission || 100} ৳ লাভ!\nআপনার ফেসবুক গ্রুপ ও মার্কেটপ্লেসে এখনই শেয়ার করুন এবং অর্ডার আসলে সরাসরি বুক করুন।`;

  return {
    facebook_whatsapp: fb,
    tiktok_reels: tiktok,
    reseller_pitch: reseller
  };
}

async function openMarketingCopyModal(productId) {
  const p = adminProductsList.find(item => item.id === productId);
  if (!p) return;

  openModal('marketingCopyModal');
  const textarea = document.getElementById('marketingCopyTextarea');
  if (textarea) textarea.value = '⏳ AI থেকে মাল্টি-চ্যানেল মার্কেটিং কপি প্রস্তুত করা হচ্ছে...';

  try {
    const res = await fetch(api('/api/admin/ai/marketing-copy'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({ productId: p.id, product: p })
    });
    const data = await res.json();
    if (data.success && data.copy) {
      currentMarketingData = data.copy;
    } else {
      currentMarketingData = fallbackMarketingCopy(p);
    }
  } catch (e) {
    currentMarketingData = fallbackMarketingCopy(p);
  }

  setMarketingTab(currentMarketingTab || 'fb');
}

function setMarketingTab(tab) {
  currentMarketingTab = tab;
  const textarea = document.getElementById('marketingCopyTextarea');
  if (!textarea || !currentMarketingData) return;

  document.querySelectorAll('.mkt-tab-btn').forEach(btn => {
    const active = btn.dataset.tab === tab;
    btn.style.background = active ? '#7c3aed' : '#f1f5f9';
    btn.style.color = active ? '#fff' : '#475569';
  });

  if (tab === 'fb') {
    textarea.value = currentMarketingData.facebook_whatsapp || '';
  } else if (tab === 'tiktok') {
    textarea.value = currentMarketingData.tiktok_reels || '';
  } else if (tab === 'reseller') {
    textarea.value = currentMarketingData.reseller_pitch || '';
  }
}

async function copyMarketingText() {
  const textarea = document.getElementById('marketingCopyTextarea');
  if (!textarea || !textarea.value) return;

  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(textarea.value);
    } else {
      textarea.select();
      document.execCommand('copy');
    }
    showToast('📋 বিজ্ঞাপন কপি সফলভাবে ক্লিপবোর্ডে কপি হয়েছে!');
  } catch (e) {
    textarea.select();
    document.execCommand('copy');
    showToast('📋 টেক্সট কপি হয়েছে!');
  }
}

async function promptQuickStockPrice(productId, currentStock, currentPrice) {
  openAdminPromptModal({
    title: '⚡ দ্রুত স্টক ও মূল্য আপডেট',
    description: `পণ্য #${productId}-এর নতুন স্টক ও বিক্রয় মূল্য নির্ধারণ করুন:`,
    submitText: '💾 আপডেট সংরক্ষণ করুন',
    fields: [
      {
        name: 'stock',
        label: `নতুন স্টক সংখ্যা (বর্তমান: ${currentStock} টি) *`,
        type: 'number',
        value: currentStock,
        min: 0,
        step: 1,
        required: true
      },
      {
        name: 'regular_price',
        label: `নতুন বিক্রয় মূল্য (বর্তমান: ${currentPrice} ৳) *`,
        type: 'number',
        value: currentPrice,
        min: 1,
        step: 'any',
        required: true
      }
    ],
    onSubmit: async (values, showError) => {
      const newStock = parseInt(values.stock, 10);
      if (!Number.isSafeInteger(newStock) || newStock < 0) {
        showError('অনুগ্রহ করে সঠিক পূর্ণসংখ্যা স্টক দিন (০ বা বেশি)');
        return false;
      }
      const newPrice = parseFloat(values.regular_price);
      if (!Number.isFinite(newPrice) || newPrice < 1) {
        showError('অনুগ্রহ করে সঠিক বিক্রয় মূল্য দিন (কমপক্ষে ১ ৳)');
        return false;
      }
      try {
        const res = await fetch(api(`/api/admin/products/${productId}/quick-update`), {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${adminToken}`
          },
          body: JSON.stringify({ stock: newStock, regular_price: newPrice })
        });
        const data = await res.json();
        if (data.success) {
          showToast('✅ স্টক ও মূল্য সফলভাবে আপডেট হয়েছে!');
          loadAdminProducts();
          return true;
        }
        showError(data.message || 'আপডেট ব্যর্থ হয়েছে');
        return false;
      } catch (err) {
        console.error(err);
        showError('সার্ভারে যোগাযোগ করতে ব্যর্থ হয়েছে');
        return false;
      }
    }
  });
}

// Expose globals for window inline events
window.switchAdminSection = switchAdminSection;
window.toggleAdminPassVisibility = toggleAdminPassVisibility;
window.openAdminPromptModal = openAdminPromptModal;
window.submitAdminPromptModal = submitAdminPromptModal;
window.submitAdminLogin = submitAdminLogin;
window.adminLogout = adminLogout;
window.loadAdminOrders = loadAdminOrders;
window.updateOrderStatus = updateOrderStatus;
window.instantReleaseCommission = instantReleaseCommission;
window.loadAdminProfitDashboard = loadAdminProfitDashboard;
window.loadAdminShops = loadAdminShops;
window.openAddShopModal = openAddShopModal;
window.submitAddShopForm = submitAddShopForm;
window.openSettleShopModal = openSettleShopModal;
window.submitShopSettlement = submitShopSettlement;
window.viewShopSettlements = viewShopSettlements;
window.loadAdminPayouts = loadAdminPayouts;
window.approvePayoutPrompt = approvePayoutPrompt;
window.rejectPayoutPrompt = rejectPayoutPrompt;
window.loadAdminProducts = loadAdminProducts;
window.openAddProductModal = openAddProductModal;
window.editProductModal = editProductModal;
window.submitProductForm = submitProductForm;
window.deleteProduct = deleteProduct;
window.toggleProductActiveStatus = toggleProductActiveStatus;
window.permanentDeleteProduct = permanentDeleteProduct;
window.updateLiveProfitCalculator = updateLiveProfitCalculator;
window.onProdShopChange = onProdShopChange;
window.viewOrderAuditTrail = viewOrderAuditTrail;
window.viewOrderDetail = viewOrderDetail;
window.updateOrderStatusAndRefreshModal = updateOrderStatusAndRefreshModal;
window.instantReleaseCommissionAndRefreshModal = instantReleaseCommissionAndRefreshModal;
window.openModal = openModal;
window.closeModal = closeModal;
window.handleProductImageSelect = handleProductImageSelect;
window.processProductImageFile = processProductImageFile;
window.toggleManualUrlInput = toggleManualUrlInput;
window.handleManualUrlInput = handleManualUrlInput;
window.isFurnitureCategory = isFurnitureCategory;
window.checkFurnitureCutlistVisibility = checkFurnitureCutlistVisibility;
window.addManualFurniturePartRow = addManualFurniturePartRow;
window.removeManualFurniturePartRow = removeManualFurniturePartRow;
window.recalculateFurnitureCutlist = recalculateFurnitureCutlist;
window.applyFurnitureBoardCostToWholesale = applyFurnitureBoardCostToWholesale;
window.runFurnitureAiEstimate = runFurnitureAiEstimate;
window.runAiProductImageInspection = runAiProductImageInspection;
window.runAiCopyFromTitleOrKeywords = runAiCopyFromTitleOrKeywords;
window.copyFieldValue = copyFieldValue;
window.setMarketingTab = setMarketingTab;
window.openMarketingCopyModal = openMarketingCopyModal;
window.copyMarketingText = copyMarketingText;
window.promptQuickStockPrice = promptQuickStockPrice;
window.initImageDragAndDropAndPaste = initImageDragAndDropAndPaste;

// ================= FURNITURE CUTLIST & BOARD DATABASE =================
async function loadAdminCutlistDatabase() {
  const tbody = document.getElementById('cutlistDbTableBody');
  if (tbody) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; padding: 20px;">ফার্নিচার বোর্ড ডাটাবেস লোড হচ্ছে...</td></tr>';
  }
  if (!adminProductsList || adminProductsList.length === 0) {
    await loadAdminProducts();
  }
  renderCutlistDbTable();
}

function renderCutlistDbTable() {
  const tbody = document.getElementById('cutlistDbTableBody');
  if (!tbody) return;
  const search = (document.getElementById('cutlistDbSearch')?.value || '').trim().toLowerCase();
  const filter = document.getElementById('cutlistDbFilter')?.value || 'furniture';

  const filtered = (adminProductsList || []).filter((p) => {
    const hasCutlist = p.furniture_cutlist && Array.isArray(p.furniture_cutlist.parts) && p.furniture_cutlist.parts.length > 0;
    const isFurn = isFurnitureCategory(p.category) || p.brand === 'SB Furniture' || hasCutlist;
    if (filter === 'furniture' && !isFurn) return false;
    if (filter === 'saved' && !hasCutlist) return false;
    if (filter === 'missing' && (!isFurn || hasCutlist)) return false;
    if (search) {
      const hay = `${p.title || ''} ${p.sku || ''} ${p.category || ''}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; padding: 20px; color: #64748b;">কোনো ফার্নিচার পণ্য পাওয়া যায়নি।</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map((p) => {
    const cut = p.furniture_cutlist;
    const partsCount = cut && Array.isArray(cut.parts) ? cut.parts.length : 0;
    const boards = cut && cut.total_boards ? cut.total_boards : 0;
    const cost = cut && cut.estimated_board_cost ? cut.estimated_board_cost : 0;
    const safeThumb = safeAdminImageUrl(p.image_url);
    const imgCors = imageCorsAttrAdmin(safeThumb);
    const statusBadge = partsCount > 0
      ? '<span class="status-badge status-delivered">সেভ করা আছে</span>'
      : '<span class="status-badge status-pending">তৈরি হয়নি</span>';
    return `
      <tr>
        <td data-label="ছবি"><img class="admin-product-thumb" src="${escapeAdminHtml(safeThumb)}" ${imgCors} alt="" onerror="window.sbHandleImageError && window.sbHandleImageError(this)" style="width: 44px; height: 44px; object-fit: cover; border-radius: 6px;"></td>
        <td data-label="SKU"><strong>${escapeAdminHtml(p.sku || '')}</strong></td>
        <td data-label="পণ্যের নাম">${escapeAdminHtml(p.title || '')}</td>
        <td data-label="পার্টস সংখ্যা">${partsCount} টি</td>
        <td data-label="মোট ৪×৮ বোর্ড"><strong>${boards} টি</strong></td>
        <td data-label="বোর্ড খরচ">${cost} ৳</td>
        <td data-label="স্ট্যাটাস">${statusBadge}</td>
        <td data-label="অ্যাকশন">
          <button type="button" class="action-btn-sm btn-confirm" onclick="openCutlistDbEditor(${p.id})">✏️ দেখুন / এডিট</button>
        </td>
      </tr>
    `;
  }).join('');
}

function openCutlistDbEditor(productId) {
  const p = (adminProductsList || []).find((item) => String(item.id) === String(productId));
  if (!p) return;
  const card = document.getElementById('cutlistDbEditorCard');
  if (!card) return;
  card.style.display = 'block';
  document.getElementById('cutDbProductId').value = p.id;
  document.getElementById('cutlistDbEditorTitle').textContent = `📐 ${p.title}`;
  document.getElementById('cutlistDbEditorMeta').textContent = `SKU: ${p.sku} · ক্যাটাগরি: ${p.category} · বর্তমান পাইকারি: ${p.wholesale_price || 0} ৳`;

  const cut = p.furniture_cutlist || {};
  document.getElementById('cutDbBoardPrice').value = cut.board_price || shopBoardPrice;
  const dims = cut.dimensions && typeof cut.dimensions === 'object' ? cut.dimensions : {};
  const hEl = document.getElementById('cutDbHeight');
  const wEl = document.getElementById('cutDbWidth');
  const dEl = document.getElementById('cutDbDepth');
  if (hEl) hEl.value = Number(dims.height) > 0 ? dims.height : 72;
  if (wEl) wEl.value = Number(dims.width) > 0 ? dims.width : 36;
  if (dEl) dEl.value = Number(dims.depth) > 0 ? dims.depth : 18;

  const tbody = document.getElementById('cutDbPartsBody');
  if (tbody) tbody.replaceChildren();
  if (Array.isArray(cut.parts) && cut.parts.length > 0) {
    cut.parts.forEach((part) => addCutlistDbPartRow(part));
  }
  recalcCutlistDbEditor();
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function closeCutlistDbEditor() {
  const card = document.getElementById('cutlistDbEditorCard');
  if (card) card.style.display = 'none';
}

function addCutlistDbPartRow(part = null) {
  const tbody = document.getElementById('cutDbPartsBody');
  if (!tbody) return;
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td style="padding: 4px;">
      <input type="text" class="form-control cutdb-part-name" style="padding: 4px 6px; font-size: 0.8rem;" placeholder="পার্টসের নাম (যেমন: সাইড প্যানেল)" value="${part ? escapeAdminHtml(part.name || '') : ''}">
    </td>
    <td style="padding: 4px;">
      <input type="number" class="form-control cutdb-part-length" style="padding: 4px 6px; font-size: 0.8rem;" placeholder="দৈর্ঘ্য" value="${part ? (part.length || '') : ''}" step="0.1" min="1" oninput="recalcCutlistDbEditor()">
    </td>
    <td style="padding: 4px;">
      <input type="number" class="form-control cutdb-part-width" style="padding: 4px 6px; font-size: 0.8rem;" placeholder="প্রস্থ" value="${part ? (part.width || '') : ''}" step="0.1" min="1" oninput="recalcCutlistDbEditor()">
    </td>
    <td style="padding: 4px;">
      <input type="number" class="form-control cutdb-part-qty" style="padding: 4px 6px; font-size: 0.8rem;" placeholder="১" value="${part ? (part.qty || 1) : 1}" min="1" oninput="recalcCutlistDbEditor()">
    </td>
    <td style="padding: 4px; font-size: 0.78rem; color: #78350f;" class="cutdb-part-sqft">0.0</td>
    <td style="padding: 4px; text-align: center;">
      <button type="button" class="action-btn-sm btn-reject" style="padding: 2px 7px;" onclick="removeCutlistDbPartRow(this)">✕</button>
    </td>
  `;
  tbody.appendChild(tr);
  recalcCutlistDbEditor();
}

function removeCutlistDbPartRow(btn) {
  const tr = btn.closest('tr');
  if (tr) {
    tr.remove();
    recalcCutlistDbEditor();
  }
}

function getCutlistDbEditorData() {
  const rows = document.querySelectorAll('#cutDbPartsBody tr');
  const parts = [];
  rows.forEach((r, idx) => {
    const name = r.querySelector('.cutdb-part-name')?.value.trim() || `পার্ট #${idx + 1}`;
    const length = parseFloat(r.querySelector('.cutdb-part-length')?.value) || 0;
    const width = parseFloat(r.querySelector('.cutdb-part-width')?.value) || 0;
    const qty = parseInt(r.querySelector('.cutdb-part-qty')?.value, 10) || 1;
    const area = length * width * qty;
    const sqftCell = r.querySelector('.cutdb-part-sqft');
    if (sqftCell) sqftCell.textContent = (area / 144).toFixed(2);
    if (length > 0 && width > 0) {
      parts.push({ name, length, width, qty });
    }
  });
  const boardPrice = parseFloat(document.getElementById('cutDbBoardPrice')?.value) || shopBoardPrice;
  const calc = window.SBCutlistCalculator.calculateCutlist(parts, { boardPrice });
  return calc;
}

function recalcCutlistDbEditor() {
  const data = getCutlistDbEditorData();
  const countEl = document.getElementById('cutDbTotalPartsCount');
  const boardsEl = document.getElementById('cutDbTotalBoards');
  const wasteEl = document.getElementById('cutDbWastage');
  const costEl = document.getElementById('cutDbTotalCost');
  const warningsEl = document.getElementById('cutDbWarnings');
  if (countEl) countEl.textContent = data.parts.length;
  if (boardsEl) boardsEl.textContent = `${data.total_boards} টি`;
  if (wasteEl) wasteEl.textContent = `(মোট: ${data.total_area_sqft} sq.ft, অপচয়: ${data.wastage_pct}%)`;
  if (costEl) costEl.textContent = `${data.estimated_board_cost} ৳`;
  if (warningsEl) {
    warningsEl.textContent = data.warnings.join(' ');
    warningsEl.style.display = data.warnings.length > 0 ? 'block' : 'none';
  }
  return data;
}

async function runCutlistDbAiEstimate() {
  const productId = document.getElementById('cutDbProductId')?.value;
  const p = (adminProductsList || []).find((item) => String(item.id) === String(productId));
  const btn = document.getElementById('btnCutDbAi');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ হিসাব হচ্ছে...';
  }
  try {
    const res = await fetch(api('/api/admin/furniture/estimate'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({
        furniture_type: window.SBCutlistCalculator.detectFurnitureType(p ? p.title : ''),
        height: parseFloat(document.getElementById('cutDbHeight')?.value) || 72,
        width: parseFloat(document.getElementById('cutDbWidth')?.value) || 36,
        depth: parseFloat(document.getElementById('cutDbDepth')?.value) || 18,
        board_price: parseFloat(document.getElementById('cutDbBoardPrice')?.value) || shopBoardPrice
      })
    });
    const data = await res.json();
    if (data.success && Array.isArray(data.parts)) {
      const tbody = document.getElementById('cutDbPartsBody');
      if (tbody) tbody.replaceChildren();
      data.parts.forEach((part) => addCutlistDbPartRow(part));
      recalcCutlistDbEditor();
      showToast('✅ AI দিয়ে পার্টস ও বোর্ডের হিসাব তৈরি হয়েছে!');
    } else {
      showToast(data.message || 'হিসাব করা যায়নি', 'error');
    }
  } catch (err) {
    console.error('Cutlist DB AI Error:', err);
    showToast('AI হিসাব করতে সমস্যা হয়েছে', 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '⚡ AI দিয়ে পার্টস হিসাব ও টেস্ট করুন';
    }
  }
}

async function saveCutlistDbEditor() {
  const productId = document.getElementById('cutDbProductId')?.value;
  const p = (adminProductsList || []).find((item) => String(item.id) === String(productId));
  if (!p) return;

  const cutlistData = recalcCutlistDbEditor();
  if (cutlistData.parts.length > 0) {
    const dimH = parseFloat(document.getElementById('cutDbHeight')?.value);
    const dimW = parseFloat(document.getElementById('cutDbWidth')?.value);
    const dimD = parseFloat(document.getElementById('cutDbDepth')?.value);
    if (dimH > 0 || dimW > 0 || dimD > 0) {
      cutlistData.dimensions = {
        height: dimH > 0 ? dimH : 72,
        width: dimW > 0 ? dimW : 36,
        depth: dimD > 0 ? dimD : 18
      };
    }
  }
  const btn = document.getElementById('btnCutDbSave');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ সেভ হচ্ছে...';
  }

  try {
    const payload = {
      title: p.title,
      sku: p.sku,
      brand: p.brand,
      category: p.category,
      regular_price: p.regular_price,
      wholesale_price: p.wholesale_price || 0,
      reseller_commission: p.reseller_commission,
      commission_tab: p.commission_tab || '50tk',
      stock: p.stock ?? 50,
      materials: p.materials || '',
      finish: p.finish || '',
      shop_id: p.shop_id || null,
      shop_name: p.shop_name || p.brand,
      vendor_phone: p.vendor_phone || '',
      vendor_badge: p.vendor_badge || '',
      vendor_address: p.vendor_address || '',
      image_url: p.image_url || '',
      caption: p.caption || '',
      description: p.description || '',
      is_active: p.is_active !== undefined ? Boolean(p.is_active) : true,
      furniture_cutlist: cutlistData.parts.length > 0 ? cutlistData : null
    };

    const res = await fetch(api(`/api/admin/products/${p.id}`), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      p.furniture_cutlist = data.furniture_cutlist !== undefined ? data.furniture_cutlist : payload.furniture_cutlist;
      renderCutlistDbTable();
      recalcCutlistDbEditor();
      showToast('✅ ফার্নিচার বোর্ড ও পার্টস ডাটাবেজে সেভ হয়েছে!');
    } else {
      showToast(data.message || 'সেভ করা যায়নি', 'error');
    }
  } catch (err) {
    console.error('Save Cutlist DB Error:', err);
    showToast('ডাটাবেজে সেভ করতে সমস্যা হয়েছে', 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '💾 ডাটাবেজে সেভ করুন';
    }
  }
}

window.loadAdminCutlistDatabase = loadAdminCutlistDatabase;
window.renderCutlistDbTable = renderCutlistDbTable;
window.openCutlistDbEditor = openCutlistDbEditor;
window.closeCutlistDbEditor = closeCutlistDbEditor;
window.addCutlistDbPartRow = addCutlistDbPartRow;
window.removeCutlistDbPartRow = removeCutlistDbPartRow;
window.recalcCutlistDbEditor = recalcCutlistDbEditor;
window.runCutlistDbAiEstimate = runCutlistDbAiEstimate;
window.saveCutlistDbEditor = saveCutlistDbEditor;
