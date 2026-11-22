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

  tbody.innerHTML = users.map((u) => {
    // Role styling
    let roleBadge = '';
    let roleActionBtn = '';

    if (u.role === 'admin') {
      roleBadge = '<span style="background: #ef4444; color: #fff; padding: 3px 8px; border-radius: 4px; font-weight: 600; font-size: 0.75rem;">👑 এডমিন</span>';
      roleActionBtn = `<button class="action-btn-sm" style="background: #4b5563; color: #fff; cursor: pointer;" onclick="quickChangeRole(${u.id}, 'reseller', '${escapeHtml(u.name)}')">💼 রিসেলার করুন</button>`;
    } else if (u.role === 'customer') {
      roleBadge = '<span style="background: #10b981; color: #fff; padding: 3px 8px; border-radius: 4px; font-weight: 600; font-size: 0.75rem;">🛍️ কাস্টমার</span>';
      roleActionBtn = `<button class="action-btn-sm" style="background: #3b82f6; color: #fff; cursor: pointer; margin-right: 4px;" onclick="quickChangeRole(${u.id}, 'reseller', '${escapeHtml(u.name)}')">💼 রিসেলার করুন</button>
                       <button class="action-btn-sm" style="background: #f59e0b; color: #1c1917; cursor: pointer;" onclick="quickChangeRole(${u.id}, 'admin', '${escapeHtml(u.name)}')">👑 মেক এডমিন</button>`;
    } else {
      roleBadge = '<span style="background: #3b82f6; color: #fff; padding: 3px 8px; border-radius: 4px; font-weight: 600; font-size: 0.75rem;">💼 রিসেলার</span>';
      roleActionBtn = `<button class="action-btn-sm" style="background: #f59e0b; color: #1c1917; cursor: pointer;" onclick="quickChangeRole(${u.id}, 'admin', '${escapeHtml(u.name)}')">👑 মেক এডমিন</button>`;
    }

    const joinedDate = u.created_at ? new Date(u.created_at).toLocaleDateString('bn-BD', { year: 'numeric', month: 'short', day: 'numeric' }) : '-';
    const totalOrdersText = `${u.total_orders || 0}টি (${Number(u.total_sales || 0).toLocaleString()}৳)`;
    const balanceText = `${Number(u.balance || 0).toLocaleString()}৳`;

    return `
      <tr>
        <td>
          <div style="font-weight: 600; color: #fff; font-size: 0.9rem;">${escapeHtml(u.name)}</div>
          <div style="font-size: 0.75rem; color: #a8a29e; display: flex; align-items: center; gap: 4px; margin-top: 2px;">
            <span>📞 ${u.phone}</span>
            <button onclick="copyToClipboard('${u.phone}', 'ফোন নম্বর কপি হয়েছে')" style="background: none; border: none; cursor: pointer; color: var(--sbp-yellow); font-size: 0.75rem;" title="কপি করুন">📋</button>
          </div>
          ${u.referred_by_name ? `<div style="font-size: 0.7rem; color: #78716c;">রেফার করেছেন: ${escapeHtml(u.referred_by_name)}</div>` : ''}
        </td>
        <td>${roleBadge}</td>
        <td>
          <code style="background: #1c1917; color: #fde68a; padding: 2px 6px; border-radius: 4px; font-size: 0.8rem;">
            ${u.referral_code || '-'}
          </code>
        </td>
        <td>
          <div style="font-weight: 600; color: #60a5fa;">${totalOrdersText}</div>
        </td>
        <td>
          <div style="font-weight: 700; color: #34d399;">${balanceText}</div>
        </td>
        <td style="color: #a8a29e; font-size: 0.8rem;">${joinedDate}</td>
        <td>
          <div style="display: flex; gap: 6px; align-items: center; flex-wrap: wrap;">
            ${roleActionBtn}
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
      <div style="font-size: 0.8rem; color: var(--sbf-text-muted);">
        সর্বমোট: <strong style="color: #fff;">${totalCount}</strong> জন (পৃষ্ঠা ${currentPage} / ${totalPages})
      </div>
      <div style="display: flex; gap: 6px;">
        <button class="action-btn-sm" style="background: #38332f; color: #fff; cursor: pointer;" ${currentPage <= 1 ? 'disabled style="opacity: 0.5; cursor: not-allowed;"' : ''} onclick="loadAdminUsers(${currentPage - 1})">◀ পূর্ববর্তী</button>
        <button class="action-btn-sm" style="background: #38332f; color: #fff; cursor: pointer;" ${currentPage >= totalPages ? 'disabled style="opacity: 0.5; cursor: not-allowed;"' : ''} onclick="loadAdminUsers(${currentPage + 1})">পরবর্তী ▶</button>
      </div>
    </div>
  `;
}

// Quick Role Toggle / Change
async function quickChangeRole(userId, newRole, userName) {
  const roleNameBn = newRole === 'admin' ? '👑 এডমিন' : (newRole === 'reseller' ? '💼 রিসেলার' : '🛍️ কাস্টমার');
  const confirmMsg = `${userName || 'ইউজার'}-কে ${roleNameBn} করতে চান?`;
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

// Add User / Admin Modal handlers
function openAddUserModal() {
  const modal = document.getElementById('adminUserModal');
  if (!modal) return;
  document.getElementById('newUserName').value = '';
  document.getElementById('newUserPhone').value = '';
  document.getElementById('newUserPassword').value = '';
  document.getElementById('newUserRole').value = 'admin'; // Default to admin for fast admin creation
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
  if (!password || password.length < 6) return alert('পাসওয়ার্ড ন্যূনতম ৬ অক্ষরের হতে হবে');

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

  if (!new_password || new_password.length < 6) {
    return alert('নতুন পাসওয়ার্ড ন্যূনতম ৬ অক্ষরের হতে হবে');
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
window.openAdminPasswordModal = openAdminPasswordModal;
window.closeAdminPasswordModal = closeAdminPasswordModal;
window.submitAdminPasswordChange = submitAdminPasswordChange;
window.copyToClipboard = copyToClipboard;
window.loadAdminContentGuide = loadAdminContentGuide;
