// ============================================================
// SB Furniture & SB POWER — Admin User & Content Management Controller
// ============================================================

let adminUsersPage = 1;
let adminUsersTotalPages = 1;
let userSearchTimeout = null;

// Load Admin Users List with search, role filter, and pagination
async function loadAdminUsers(page = 1) {
  adminUsersPage = page;
  const tbody = document.getElementById('adminUsersTableBody');
  if (!tbody) return;

  tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 24px; color: var(--sbf-text-muted);">⏳ ইউজার তালিকা লোড হচ্ছে...</td></tr>';

  const searchInput = document.getElementById('userSearchInput');
  const roleSelect = document.getElementById('userRoleFilter');
  const q = searchInput ? searchInput.value.trim() : '';
  const role = roleSelect ? roleSelect.value : 'all';

  try {
    const queryParams = new URLSearchParams({
      page: adminUsersPage,
      limit: 15,
      q,
      role
    });

    const res = await fetch(api(`/api/admin/users?${queryParams.toString()}`), {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const data = await res.json();

    if (!data.success || !data.users || data.users.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 24px; color: var(--sbf-text-muted);">কোনো ইউজার পাওয়া যায়নি।</td></tr>';
      renderUserPagination(1, 1, 0);
      return;
    }

    adminUsersTotalPages = data.pagination.totalPages || 1;
    renderAdminUsersTable(data.users);
    renderUserPagination(data.pagination.page, data.pagination.totalPages, data.pagination.total);
  } catch (err) {
    console.error('Load Users Error:', err);
    tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; padding: 24px; color: var(--sbp-red);">ইউজার তালিকা লোড করতে সমস্যা হয়েছে।</td></tr>';
  }
}

// Render Users Table
function renderAdminUsersTable(users) {
  const tbody = document.getElementById('adminUsersTableBody');
  if (!tbody) return;

  let currentAdminId = null;
  try {
    const storedAdmin = JSON.parse(localStorage.getItem('sb_admin_user') || 'null');
    if (storedAdmin && storedAdmin.id) currentAdminId = Number(storedAdmin.id);
  } catch { /* ignore parse errors */ }

  const roleConfig = {
    admin: { cls: 'is-admin', label: '👑 এডমিন' },
    customer: { cls: 'is-customer', label: '🛍️ কাস্টমার' },
    reseller: { cls: 'is-reseller', label: '💼 রিসেলার' }
  };

  tbody.innerHTML = users.map((u) => {
    const currentRole = Object.prototype.hasOwnProperty.call(roleConfig, u.role) ? u.role : 'customer';
    const roleMeta = roleConfig[currentRole];
    const roleBadge = `<span class="adm-role-pill ${roleMeta.cls}">${roleMeta.label}</span>`;

    const roleActionBtn = `
      <div class="admin-role-editor">
        <label for="adminUserRole${Number(u.id)}">অ্যাকাউন্টের পদবি</label>
        <div class="admin-role-editor-row">
          <select id="adminUserRole${Number(u.id)}" class="form-control" data-current-role="${currentRole}">
            <option value="customer" ${currentRole === 'customer' ? 'selected' : ''}>🛍️ কাস্টমার</option>
            <option value="reseller" ${currentRole === 'reseller' ? 'selected' : ''}>💼 রিসেলার</option>
            <option value="admin" ${currentRole === 'admin' ? 'selected' : ''}>👑 অ্যাডমিন</option>
          </select>
          <button class="action-btn-sm admin-role-save" type="button" onclick="saveSelectedUserRole(${Number(u.id)})">সংরক্ষণ</button>
        </div>
      </div>
    `;

    const joinedDate = u.created_at ? new Date(u.created_at).toLocaleDateString('bn-BD', { year: 'numeric', month: 'short', day: 'numeric' }) : '-';
    const totalOrdersText = `${u.total_orders || 0}টি (${Number(u.total_sales || 0).toLocaleString()}৳)`;
    const balanceText = `${Number(u.balance || 0).toLocaleString()}৳`;

    const isSuspended = u.status === 'suspended';
    const isSelf = currentAdminId !== null && Number(u.id) === currentAdminId;
    const statusBadge = isSuspended
      ? '<span class="adm-status-pill is-suspended">🚫 স্থগিত</span>'
      : '<span class="adm-status-pill is-active">✅ সক্রিয়</span>';

    const statusToggleBtn = isSelf
      ? '<span class="adm-self-tag">✓ বর্তমান অ্যাডমিন</span>'
      : (isSuspended
          ? `<button type="button" class="action-btn-sm adm-btn-soft-success" onclick="toggleUserStatus(${Number(u.id)}, 'active')">✅ সক্রিয় করুন</button>`
          : `<button type="button" class="action-btn-sm adm-btn-soft-danger" onclick="toggleUserStatus(${Number(u.id)}, 'suspended')">🚫 স্থগিত করুন</button>`);

    return `
      <tr style="${isSuspended ? 'opacity: 0.78; background: rgba(220, 38, 38, 0.04);' : ''}">
        <td data-label="ইউজার ও মোবাইল">
          <div style="font-weight: 700; color: var(--adm-text); font-size: 0.92rem;">${escapeHtml(u.name)}</div>
          <div class="adm-phone-row">
            <span>📞 ${escapeHtml(u.phone)}</span>
            <button type="button" onclick="copyToClipboard('${String(u.phone || '').replace(/\D/g, '')}', 'ফোন নম্বর কপি হয়েছে')" style="background: none; border: none; cursor: pointer; color: var(--adm-amber); font-size: 0.78rem; padding: 2px;" title="ফোন নম্বর কপি করুন" aria-label="ফোন নম্বর কপি করুন">📋</button>
          </div>
          ${u.payout_method ? `<div style="font-size: 0.72rem; color: var(--adm-amber); margin-top: 2px;">💸 ক্যাশআউট: ${escapeHtml(u.payout_method.toUpperCase())} (${escapeHtml(u.payout_number || '')})</div>` : ''}
          ${u.referred_by_name ? `<div style="font-size: 0.72rem; color: var(--adm-text-muted); margin-top: 2px;">রেফার করেছেন: ${escapeHtml(u.referred_by_name)}</div>` : ''}
        </td>
        <td data-label="পদবি">
          <div class="adm-user-badges">
            ${roleBadge}
            ${statusBadge}
          </div>
        </td>
        <td data-label="রেফারেল কোড">
          <code class="adm-code-pill">${escapeHtml(u.referral_code || '-')}</code>
        </td>
        <td data-label="অর্ডার ও সেলস">
          <div class="admin-cell-money" style="font-weight: 600; color: var(--adm-blue); white-space: nowrap;">${totalOrdersText}</div>
        </td>
        <td data-label="ওয়ালেট ব্যালেন্স">
          <div class="admin-cell-money" style="font-weight: 700; color: var(--adm-emerald); white-space: nowrap;">${balanceText}</div>
        </td>
        <td data-label="যুক্ত হওয়ার তারিখ" style="color: var(--adm-text-muted); font-size: 0.8rem; white-space: nowrap;">${joinedDate}</td>
        <td data-label="পদবি পরিবর্তন / অ্যাকশন">
          <div class="admin-role-actions">
            ${roleActionBtn}
            ${statusToggleBtn}
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

// Render User Pagination
function renderUserPagination(currentPage, totalPages, totalCount) {
  const container = document.getElementById('adminUsersPagination');
  if (!container) return;

  if (totalPages <= 1) {
    container.innerHTML = `<div style="font-size: 0.8rem; color: var(--sbf-text-muted);">সর্বমোট ইউজার: ${totalCount} জন</div>`;
    return;
  }

  container.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; width: 100%; flex-wrap: wrap; gap: 8px;">
      <div style="font-size: 0.82rem; color: var(--adm-text-muted, #64748b);">
        সর্বমোট: <strong style="color: var(--adm-text, #0f172a);">${totalCount}</strong> জন (পৃষ্ঠা ${currentPage} / ${totalPages})
      </div>
      <div style="display: flex; gap: 6px;">
        <button class="action-btn-sm adm-btn-neutral" ${currentPage <= 1 ? 'disabled style="opacity: 0.45; cursor: not-allowed;"' : ''} onclick="loadAdminUsers(${currentPage - 1})">◀ পূর্ববর্তী</button>
        <button class="action-btn-sm adm-btn-neutral" ${currentPage >= totalPages ? 'disabled style="opacity: 0.45; cursor: not-allowed;"' : ''} onclick="loadAdminUsers(${currentPage + 1})">পরবর্তী ▶</button>
      </div>
    </div>
  `;
}

// Quick Role Toggle / Change
async function quickChangeRole(userId, newRole) {
  const roleNameBn = newRole === 'admin' ? '👑 এডমিন' : (newRole === 'reseller' ? '💼 রিসেলার' : '🛍️ কাস্টমার');
  const roleSelect = document.getElementById(`adminUserRole${Number(userId)}`);
  const currentRole = roleSelect ? roleSelect.dataset.currentRole : '';
  const confirmMsg = newRole === 'reseller'
    ? 'এই অ্যাকাউন্টে রিসেলার অনুমতি দিয়ে কমিশন দেখাতে চান?'
    : (newRole === 'customer'
      ? `এই অ্যাকাউন্টের ${currentRole === 'admin' ? 'অ্যাডমিন ও ' : ''}রিসেলার অনুমতি বন্ধ করে সাধারণ কাস্টমার করতে চান?`
      : `এই ইউজারকে ${roleNameBn} করতে চান?`);
  if (!confirm(confirmMsg)) return;

  try {
    const res = await fetch(api(`/api/admin/users/${userId}/role`), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({ role: newRole })
    });
    const data = await res.json();

    if (data.success) {
      showToast(data.message || 'ইউজার রোল সফলভাবে পরিবর্তন করা হয়েছে!');
      loadAdminUsers(adminUsersPage);
      if (typeof loadAdminStats === 'function') loadAdminStats();
    } else {
      alert(data.message || 'রোল পরিবর্তন করতে ব্যর্থ হয়েছে');
    }
  } catch (err) {
    console.error('Role update error:', err);
    alert('সার্ভার যোগাযোগে ত্রুটি ঘটেছে');
  }
}

async function saveSelectedUserRole(userId) {
  const roleSelect = document.getElementById(`adminUserRole${Number(userId)}`);
  if (!roleSelect) return;
  if (roleSelect.value === roleSelect.dataset.currentRole) {
    showToast('এই পদবি ইতিমধ্যেই চালু আছে।');
    return;
  }
  await quickChangeRole(Number(userId), roleSelect.value);
}

// Toggle Account Status (active vs suspended)
async function toggleUserStatus(userId, newStatus) {
  const actionText = newStatus === 'suspended' ? 'স্থগিত' : 'সক্রিয়';
  if (!confirm(`আপনি কি এই অ্যাকাউন্টটিকে ${actionText} করতে চান?`)) return;

  try {
    const res = await fetch(api(`/api/admin/users/${userId}/status`), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({ status: newStatus })
    });
    const data = await res.json();
    if (data.success) {
      showToast(data.message || `অ্যাকাউন্ট সফলভাবে ${actionText} করা হয়েছে!`);
      loadAdminUsers(adminUsersPage);
    } else {
      alert(data.message || 'স্ট্যাটাস পরিবর্তন ব্যর্থ হয়েছে');
    }
  } catch (err) {
    alert('সার্ভার যোগাযোগে ত্রুটি ঘটেছে');
  }
}

// Add User / Admin Modal handlers
function openAddUserModal() {
  const modal = document.getElementById('adminUserModal');
  if (!modal) return;
  document.getElementById('newUserName').value = '';
  document.getElementById('newUserPhone').value = '';
  document.getElementById('newUserPassword').value = '';
  document.getElementById('newUserRole').value = 'customer';
  modal.classList.add('active');
}

function closeAddUserModal() {
  const modal = document.getElementById('adminUserModal');
  if (modal) modal.classList.remove('active');
}

// Submit Add User / Admin Form
async function submitAddUserForm() {
  const name = document.getElementById('newUserName').value.trim();
  const phone = document.getElementById('newUserPhone').value.trim();
  const password = document.getElementById('newUserPassword').value;
  const role = document.getElementById('newUserRole').value;

  if (!name || name.length < 2) return alert('সঠিক পূর্ণ নাম দিন (কমপক্ষে ২ অক্ষর)');
  if (!phone || !/^01[3-9]\d{8}$/.test(phone)) return alert('সঠিক ১১ ডিজিটের বাংলাদেশী মোবাইল নম্বর দিন (যেমন: 01XXXXXXXXX)');
  const passwordBytes = new TextEncoder().encode(password).length;
  if (passwordBytes < 8 || passwordBytes > 72) return alert('পাসওয়ার্ড ৮ থেকে ৭২ বাইটের মধ্যে হতে হবে');

  try {
    const res = await fetch(api('/api/admin/users'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({ name, phone, password, role })
    });
    const data = await res.json();

    if (data.success) {
      closeAddUserModal();
      showToast(data.message || 'ইউজার সফলভাবে তৈরি হয়েছে!');
      loadAdminUsers(1);
      if (typeof loadAdminStats === 'function') loadAdminStats();
    } else {
      alert(data.message || 'ইউজার তৈরিতে ব্যর্থ হয়েছে');
    }
  } catch (err) {
    console.error('Create user error:', err);
    alert('সার্ভার ত্রুটি ঘটেছে');
  }
}

// Admin Password Update Modal
function openAdminPasswordModal() {
  const modal = document.getElementById('adminPasswordModal');
  if (!modal) return;
  document.getElementById('adminOldPass').value = '';
  document.getElementById('adminNewPass').value = '';
  modal.classList.add('active');
}

function closeAdminPasswordModal() {
  const modal = document.getElementById('adminPasswordModal');
  if (modal) modal.classList.remove('active');
}

async function submitAdminPasswordChange() {
  const old_password = document.getElementById('adminOldPass').value;
  const new_password = document.getElementById('adminNewPass').value;

  const passwordBytes = new TextEncoder().encode(new_password).length;
  if (passwordBytes < 8 || passwordBytes > 72) {
    return alert('নতুন পাসওয়ার্ড ৮ থেকে ৭২ বাইটের মধ্যে হতে হবে');
  }

  try {
    const res = await fetch(api('/api/admin/profile/password'), {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({ old_password, new_password })
    });
    const data = await res.json();

    if (data.success) {
      // A password change revokes older tokens; keep this admin signed in.
      if (data.token) {
        adminToken = data.token;
        localStorage.setItem('sb_admin_token', data.token);
      }
      closeAdminPasswordModal();
      showToast('✅ এডমিন পাসওয়ার্ড সফলভাবে পরিবর্তন হয়েছে!');
    } else {
      alert(data.message || 'পাসওয়ার্ড পরিবর্তন ব্যর্থ হয়েছে');
    }
  } catch (err) {
    console.error('Password change error:', err);
    alert('সার্ভার ত্রুটি ঘটেছে');
  }
}

// Utility: Copy to Clipboard
function copyToClipboard(text, successMsg) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      showToast(successMsg || 'কপি করা হয়েছে!');
    }).catch(() => fallbackCopy(text, successMsg));
  } else {
    fallbackCopy(text, successMsg);
  }
}

function fallbackCopy(text, successMsg) {
  const textArea = document.createElement('textarea');
  textArea.value = text;
  document.body.appendChild(textArea);
  textArea.select();
  try {
    document.execCommand('copy');
    showToast(successMsg || 'কপি করা হয়েছে!');
  } catch (err) {
    alert('কপি ব্যর্থ হয়েছে: ' + text);
  }
  document.body.removeChild(textArea);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Content Guide & Settings Loader
function loadAdminContentGuide() {
  // Ensure content guide view is refreshed and brand contacts are accurate
  const hotlines = document.querySelectorAll('.guide-hotline-val');
  hotlines.forEach(el => {
    el.style.fontWeight = 'bold';
  });
}

// Attach Search and Filter Listeners on DOM Ready
document.addEventListener('DOMContentLoaded', () => {
  const searchInput = document.getElementById('userSearchInput');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      clearTimeout(userSearchTimeout);
      userSearchTimeout = setTimeout(() => {
        loadAdminUsers(1);
      }, 350);
    });
  }

  const roleFilter = document.getElementById('userRoleFilter');
  if (roleFilter) {
    roleFilter.addEventListener('change', () => {
      loadAdminUsers(1);
    });
  }
});

// Expose globals for window inline events
window.loadAdminUsers = loadAdminUsers;
window.renderAdminUsersTable = renderAdminUsersTable;
window.openAddUserModal = openAddUserModal;
window.closeAddUserModal = closeAddUserModal;
window.submitAddUserForm = submitAddUserForm;
window.quickChangeRole = quickChangeRole;
window.saveSelectedUserRole = saveSelectedUserRole;
window.toggleUserStatus = toggleUserStatus;
window.openAdminPasswordModal = openAdminPasswordModal;
window.closeAdminPasswordModal = closeAdminPasswordModal;
window.submitAdminPasswordChange = submitAdminPasswordChange;
window.copyToClipboard = copyToClipboard;
window.loadAdminContentGuide = loadAdminContentGuide;
