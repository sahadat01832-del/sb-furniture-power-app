// ============================================================
// SB Furniture & SB POWER — Admin Dashboard Controller
// ============================================================

let adminToken = localStorage.getItem('sb_admin_token') || null;
let currentAdminSection = 'orders';
let adminProductsList = [];

const api = (path) => (typeof window.apiUrl === 'function' ? window.apiUrl(path) : path);

document.addEventListener('DOMContentLoaded', () => {
  if (adminToken) {
    checkAdminSession();
  } else {
    showLoginView();
  }
});

function showToast(message) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3000);
}

function showLoginView() {
  document.getElementById('adminLoginSection').style.display = 'block';
  document.getElementById('adminDashboardSection').style.display = 'none';
}

function showDashboardView() {
  document.getElementById('adminLoginSection').style.display = 'none';
  document.getElementById('adminDashboardSection').style.display = 'block';
  loadAdminStats();
  switchAdminSection(currentAdminSection);
}

// Admin Login
async function submitAdminLogin() {
  const phone = document.getElementById('adminPhoneInput').value.trim();
  const password = document.getElementById('adminPassInput').value;

  if (!phone || !password) return alert('ফোন ও পাসওয়ার্ড দিন');

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
      showDashboardView();
      showToast('👑 এডমিন লগইন সফল হয়েছে!');
    } else {
      alert(data.user && data.user.role !== 'admin' ? 'আপনার এডমিন অ্যাক্সেস নেই' : data.message);
    }
  } catch (err) {
    console.error(err);
    alert('এডমিন লগইন ব্যর্থ হয়েছে');
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
  showLoginView();
  showToast('লগআউট করা হয়েছে');
}

// Switch Sections (Orders, Payouts, Products, Analytics, Announcements, Backups)
function switchAdminSection(section) {
  currentAdminSection = section;
  const sections = ['orders', 'payouts', 'products', 'analytics', 'announcements', 'backups'];
  sections.forEach((s) => {
    const capitalized = s.charAt(0).toUpperCase() + s.slice(1);
    const secEl = document.getElementById(`admin${capitalized}Section`);
    if (secEl) secEl.style.display = section === s ? 'block' : 'none';
    const tabEl = document.getElementById(`tabBtn${capitalized}`);
    if (tabEl) tabEl.classList.toggle('active', section === s);
  });
  const loaders = { orders: loadAdminOrders, payouts: loadAdminPayouts, products: loadAdminProducts, analytics: loadAdminAnalytics, announcements: loadAdminAnnouncements, backups: loadAdminBackupsList };
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
      tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; padding: 20px; color: var(--sbf-text-muted);">কোনো অর্ডার নেই।</td></tr>';
      return;
    }

    tbody.innerHTML = data.orders.map((o) => `
      <tr>
        <td><strong>#${o.order_number}</strong><br><span style="font-size: 0.72rem; color: #a8a29e;">${new Date(o.created_at).toLocaleDateString('bn-BD')}</span></td>
        <td><strong>${o.customer_name}</strong><br><a href="tel:${o.customer_phone}" style="color: var(--sbp-yellow);">${o.customer_phone}</a></td>
        <td>${o.delivery_address}<br><span style="color: #38bdf8;">(${o.delivery_city === 'inside_dhaka' ? 'ঢাকা ভেতরে' : 'ঢাকা বাইরে'})</span></td>
        <td><strong>${o.total_amount} ৳</strong><br><span style="font-size: 0.75rem; color: #a8a29e;">(অগ্রিম: ${o.advance_paid}৳)</span></td>
        <td>${o.advance_trx_id ? `<strong style="color: #34d399;">${o.advance_trx_id}</strong>` : '<span style="color: #ef4444;">নেই</span>'}</td>
        <td>${o.reseller_name ? `${o.reseller_name}<br><span style="font-size: 0.75rem; color: #a8a29e;">${o.reseller_phone}</span>` : '<span style="color: #a8a29e;">সরাসরি</span>'}</td>
        <td>
          <span style="background: ${getStatusBadgeBg(o.status)}; color: #fff; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: 700;">
            ${o.status}
          </span>
        </td>
        <td>
          <div style="display: flex; gap: 4px; flex-wrap: wrap;">
            ${o.status === 'pending' ? `<button class="action-btn-sm btn-confirm" onclick="updateOrderStatus(${o.id}, 'confirmed')">কনফার্ম</button>` : ''}
            ${['pending', 'confirmed'].includes(o.status) ? `<button class="action-btn-sm btn-ship" onclick="updateOrderStatus(${o.id}, 'shipped')">শিপড</button>` : ''}
            ${['pending', 'confirmed', 'shipped'].includes(o.status) ? `<button class="action-btn-sm btn-deliver" onclick="updateOrderStatus(${o.id}, 'delivered')">ডেলিভার্ড</button>` : ''}
            ${o.status !== 'delivered' && o.status !== 'cancelled' ? `<button class="action-btn-sm btn-cancel" onclick="updateOrderStatus(${o.id}, 'cancelled')">বাতিল</button>` : ''}
            <button class="action-btn-sm" style="background: #475569; color: #fff;" onclick="viewOrderAuditTrail(${o.id}, '${o.order_number}')">অডিট</button>
          </div>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    console.error(err);
    tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--sbp-red);">লোড ব্যর্থ হয়েছে।</td></tr>';
  }
}

async function updateOrderStatus(orderId, newStatus) {
  if (newStatus === 'delivered') {
    const ok = confirm('অর্ডার ডেলিভার্ড হিসেবে মার্ক করতে চান? এর ফলে রিসেলারের ওয়ালেটে কমিশন এবং প্রযোজ্য ক্ষেত্রে রেফারেল বোনাস যোগ হবে।');
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

    tbody.innerHTML = data.payouts.map((p) => `
      <tr>
        <td>#${p.id}</td>
        <td><strong>${p.user_name}</strong></td>
        <td>${p.user_phone}</td>
        <td><strong style="color: var(--sbp-yellow);">${p.amount} ৳</strong></td>
        <td><span style="text-transform: uppercase; font-weight: 700;">${p.payment_method}</span></td>
        <td><strong style="color: #38bdf8;">${p.account_number}</strong></td>
        <td>
          <span style="background: ${p.status === 'approved' ? '#10b981' : p.status === 'pending' ? '#f59e0b' : '#ef4444'}; color: #fff; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: 700;">
            ${p.status}
          </span>
        </td>
        <td>${p.admin_trx_id || '-'}<br><span style="font-size: 0.7rem; color: #a8a29e;">${new Date(p.created_at).toLocaleDateString('bn-BD')}</span></td>
        <td>
          ${p.status === 'pending' ? `
            <div style="display: flex; gap: 4px;">
              <button class="action-btn-sm btn-deliver" onclick="approvePayoutPrompt(${p.id}, ${p.amount}, '${p.payment_method}', '${p.account_number}')">অনুমোদন</button>
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

async function approvePayoutPrompt(payoutId, amount, method, account) {
  const trxId = prompt(`${method.toUpperCase()} নম্বর ${account}-এ ${amount} ৳ পাঠানোর পর ট্রানজেকশন আইডি (TrxID) দিন:`);
  if (!trxId) return;

  try {
    const res = await fetch(api(`/api/admin/payouts/${payoutId}`), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({ status: 'approved', admin_trx_id: trxId.trim() })
    });
    const data = await res.json();
    if (data.success) {
      showToast('✅ ক্যাশআউট অনুমোদন সম্পন্ন হয়েছে!');
      loadAdminPayouts();
      loadAdminStats();
    } else {
      alert(data.message);
    }
  } catch (err) {
    console.error(err);
    alert('ক্যাশআউট আপডেট ব্যর্থ হয়েছে');
  }
}

async function rejectPayoutPrompt(payoutId) {
  const notes = prompt('ক্যাশআউট বাতিল করার কারণ লিখুন:');
  if (notes === null) return;

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
    } else {
      alert(data.message);
    }
  } catch (err) {
    console.error(err);
    alert('ব্যর্থ হয়েছে');
  }
}

// ================= SECTION 3: PRODUCTS (CRUD) =================
async function loadAdminProducts() {
  const tbody = document.getElementById('adminProductsTableBody');
  tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; padding: 20px;">ক্যাটালগ লোড হচ্ছে...</td></tr>';

  try {
    const res = await fetch(api('/api/admin/products'), {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const data = await res.json();

    if (!data.success || data.products.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; padding: 20px;">কোনো প্রোডাক্ট নেই।</td></tr>';
      return;
    }

    adminProductsList = data.products;

    tbody.innerHTML = data.products.map((p) => {
      const isPartner = p.shop_name && !['SB Furniture', 'SB POWER'].includes(p.shop_name);
      return `
      <tr style="${p.is_active ? '' : 'opacity: 0.65; background: rgba(239, 68, 68, 0.05);'}">
        <td><img src="${p.image_url}" alt="${p.title}" style="width: 44px; height: 36px; object-fit: cover; border-radius: 4px;"></td>
        <td><strong>${p.sku}</strong>${p.is_active ? '' : '<br><span style="background: #ef4444; color: #fff; padding: 1px 4px; border-radius: 3px; font-size: 0.68rem;">নিষ্ক্রিয়</span>'}</td>
        <td><strong>${p.title}</strong></td>
        <td>
          <span style="color: ${p.brand === 'SB Furniture' ? '#f59e0b' : '#38bdf8'}; font-weight: 700;">${p.brand}</span>
          ${isPartner ? `<br><span style="font-size: 0.75rem; color: #34d399; font-weight: 600;">🏪 ${p.shop_name}</span>` : ''}
          ${p.vendor_phone ? `<br><span style="font-size: 0.72rem; color: #a8a29e;">📞 ${p.vendor_phone}</span>` : ''}
          <br><span style="font-size: 0.72rem; color: #a8a29e;">${p.category}</span>
        </td>
        <td><strong>${p.regular_price} ৳</strong></td>
        <td><span style="background: #059669; color: #fff; padding: 2px 6px; border-radius: 4px; font-size: 0.75rem;">+${p.reseller_commission}৳ (${p.commission_tab})</span></td>
        <td>${p.stock}</td>
        <td>
          <div style="display: flex; gap: 4px;">
            <button class="action-btn-sm btn-ship" onclick="editProductModal(${p.id})">এডিট</button>
            ${p.is_active ? `<button class="action-btn-sm btn-cancel" onclick="deleteProduct(${p.id})">ডিলিট</button>` : ''}
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

function openAddProductModal() {
  document.getElementById('editProductId').value = '';
  document.getElementById('productFormTitle').textContent = 'নতুন প্রোডাক্ট যোগ করুন';
  document.getElementById('prodTitle').value = '';
  document.getElementById('prodSku').value = '';
  document.getElementById('prodBrand').value = 'SB Furniture';
  document.getElementById('prodShopName').value = 'SB Furniture';
  document.getElementById('prodVendorPhone').value = '';
  document.getElementById('prodVendorBadge').value = '';
  document.getElementById('prodVendorAddress').value = '';
  document.getElementById('prodPrice').value = '';
  document.getElementById('prodCommission').value = '500';
  document.getElementById('prodStock').value = '50';
  document.getElementById('prodImageUrl').value = '';
  document.getElementById('prodMaterials').value = 'সুপার এস বোর্ড (Super S Board)';
  document.getElementById('prodFinish').value = 'White Carrara Marble';
  document.getElementById('prodDesc').value = '';
  openModal('addProductModal');
}

function editProductModal(id) {
  const p = adminProductsList.find((item) => item.id === id);
  if (!p) return;

  document.getElementById('editProductId').value = p.id;
  document.getElementById('productFormTitle').textContent = `প্রোডাক্ট এডিট: ${p.sku}`;
  document.getElementById('prodTitle').value = p.title;
  document.getElementById('prodSku').value = p.sku;
  document.getElementById('prodBrand').value = p.brand;
  document.getElementById('prodShopName').value = p.shop_name || p.brand || '';
  document.getElementById('prodVendorPhone').value = p.vendor_phone || '';
  document.getElementById('prodVendorBadge').value = p.vendor_badge || '';
  document.getElementById('prodVendorAddress').value = p.vendor_address || '';
  document.getElementById('prodCategory').value = p.category;
  document.getElementById('prodCommTab').value = p.commission_tab;
  document.getElementById('prodPrice').value = p.regular_price;
  document.getElementById('prodCommission').value = p.reseller_commission;
  document.getElementById('prodStock').value = p.stock;
  document.getElementById('prodImageUrl').value = p.image_url;
  document.getElementById('prodMaterials').value = p.materials || '';
  document.getElementById('prodFinish').value = p.finish || '';
  document.getElementById('prodDesc').value = p.description || '';
  openModal('addProductModal');
}

async function submitProductForm() {
  const id = document.getElementById('editProductId').value;
  const payload = {
    title: document.getElementById('prodTitle').value.trim(),
    sku: document.getElementById('prodSku').value.trim().toUpperCase(),
    brand: document.getElementById('prodBrand').value,
    shop_name: document.getElementById('prodShopName').value.trim(),
    vendor_phone: document.getElementById('prodVendorPhone').value.trim(),
    vendor_badge: document.getElementById('prodVendorBadge').value.trim(),
    vendor_address: document.getElementById('prodVendorAddress').value.trim(),
    category: document.getElementById('prodCategory').value,
    commission_tab: document.getElementById('prodCommTab').value,
    regular_price: parseFloat(document.getElementById('prodPrice').value),
    reseller_commission: parseFloat(document.getElementById('prodCommission').value),
    stock: parseInt(document.getElementById('prodStock').value, 10),
    image_url: document.getElementById('prodImageUrl').value.trim(),
    materials: document.getElementById('prodMaterials').value.trim(),
    finish: document.getElementById('prodFinish').value.trim(),
    description: document.getElementById('prodDesc').value.trim()
  };

  if (!payload.title || !payload.sku || isNaN(payload.regular_price)) {
    return alert('প্রয়োজনীয় ফিল্ডগুলো পূরণ করুন');
  }

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
      showToast(data.message);
      closeModal('addProductModal');
      loadAdminProducts();
    } else {
      alert(data.message);
    }
  } catch (err) {
    console.error(err);
    alert('প্রোডাক্ট সেভ ব্যর্থ হয়েছে');
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

function closeModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.classList.remove('active');
}

// Global escape key listener
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.active').forEach((m) => {
      m.classList.remove('active');
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
    if (!data.success) return;

    const { top_products, top_resellers } = data.analytics;

    if (prodTbody) {
      if (top_products.length === 0) {
        prodTbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--sbf-text-muted); padding: 16px;">এখনও কোনো বিক্রয় তথ্য নেই।</td></tr>';
      } else {
        prodTbody.innerHTML = top_products.map((p) => `
          <tr>
            <td><strong>${p.sku}</strong></td>
            <td>${p.title}</td>
            <td><strong style="color: var(--sbp-yellow);">${p.total_units_sold} টি</strong></td>
            <td><strong>${p.total_sales_volume} ৳</strong></td>
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
            <td><strong>${r.name}</strong></td>
            <td>${r.phone}</td>
            <td><strong style="color: #10b981;">${r.delivered_sales_count} টি</strong></td>
            <td><strong>${r.total_volume} ৳</strong></td>
            <td><strong style="color: var(--sbp-yellow);">${r.total_commission_earned} ৳</strong></td>
          </tr>
        `).join('');
      }
    }
  } catch (err) {
    console.error('Analytics Fetch Error:', err);
  }
}

// ================= AUDIT TRAIL MODAL =================
async function viewOrderAuditTrail(orderId, orderNumber) {
  document.getElementById('auditModalTitle').textContent = `অর্ডার #${orderNumber} — স্ট্যাটাস অডিট ট্রেইল`;
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
                <td><span style="font-size: 0.75rem; color: #a8a29e;">${log.previous_status || 'শুরু'}</span></td>
                <td><span style="background: ${getStatusBadgeBg(log.new_status)}; color: #fff; padding: 2px 6px; border-radius: 4px; font-size: 0.72rem; font-weight: 700;">${log.new_status}</span></td>
                <td>${log.admin_name || 'সিস্টেম'}</td>
                <td style="font-size: 0.78rem;">${log.notes || '-'}</td>
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
        <td>#${a.id}</td>
        <td><strong>${a.title}</strong></td>
        <td style="max-width: 250px;">${a.message}</td>
        <td><span style="background: #38332f; padding: 2px 6px; border-radius: 4px; font-size: 0.75rem;">${a.type}</span></td>
        <td><span style="color: ${a.is_active ? '#10b981' : '#ef4444'}; font-weight: 700;">${a.is_active ? 'সক্রিয়' : 'নিষ্ক্রিয়'}</span></td>
        <td>
          <div style="display: flex; gap: 4px;">
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
      showToast(`🎉 ব্যাকআপ সফল! ফাইল: ${data.backup.filename}`);
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
    if (!data.success || !data.backups || data.backups.length === 0) {
      container.innerHTML = '<div style="color: var(--sbf-text-muted); padding: 8px;">কোনো ব্যাকআপ পাওয়া যায়নি।</div>';
      return;
    }

    container.innerHTML = data.backups.map((b) => `
      <div style="background: #1c1917; border: 1px solid var(--sbf-border); padding: 8px 12px; border-radius: var(--radius-sm); margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center;">
        <div>
          <strong style="color: #fde68a; font-size: 0.85rem;">${b.filename}</strong>
          <div style="font-size: 0.75rem; color: var(--sbf-text-muted); margin-top: 2px;">সাইজ: ${b.sizeFormatted} • সময়: ${new Date(b.createdAt).toLocaleString('bn-BD')}</div>
        </div>
        <button onclick="downloadBackupFile('${b.filename}')" class="action-btn-sm btn-ship" style="cursor: pointer; padding: 4px 10px;">⬇️ ডাউনলোড</button>
      </div>
    `).join('');
  } catch (err) {
    container.innerHTML = '<div style="color: var(--sbp-red); padding: 8px;">ব্যাকআপ লোড ব্যর্থ হয়েছে।</div>';
  }
}

async function downloadBackupFile(filename) {
  try {
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
    window.open(api(`/api/admin/backups/download/${encodeURIComponent(filename)}?token=${encodeURIComponent(adminToken)}`), '_blank');
  }
}
