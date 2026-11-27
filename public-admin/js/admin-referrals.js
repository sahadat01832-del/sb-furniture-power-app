(() => {
  const apiUrl = (path) => (typeof window.apiUrl === 'function' ? window.apiUrl(path) : path);
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
  const statusLabel = (status) => ({
    pending: 'অপেক্ষমাণ', confirmed: 'নিশ্চিত', shipped: 'পাঠানো হয়েছে', delivered: 'ডেলিভারি সম্পন্ন', cancelled: 'বাতিল'
  }[status] || 'অজানা');
  let searchTimer = null;

  async function request(path, options = {}) {
    const response = await fetch(apiUrl(path), {
      ...options,
      headers: {
        Authorization: `Bearer ${localStorage.getItem('sb_admin_token') || ''}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {})
      }
    });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.message || 'রিকোয়েস্ট ব্যর্থ হয়েছে');
    return data;
  }

  window.loadAdminReferrals = async () => {
    const tree = document.getElementById('adminReferralTree');
    const status = document.getElementById('referralTreeStatus');
    if (!tree) return;
    tree.innerHTML = '<div class="referral-state">রেফারেল তথ্য লোড হচ্ছে…</div>';
    try {
      const data = await request('/api/admin/referrals/settings');
      document.getElementById('referralProgramEnabled').checked = data.settings.is_enabled;
      document.getElementById('referralCustomerPercent').value = data.settings.customer_reward_percent;
      document.getElementById('referralResellerPercent').value = data.settings.reseller_commission_percent;
      if (status) status.textContent = 'যে সদস্যের শাখা দেখতে চান, তার নাম চাপুন। বড় শাখা ধাপে ধাপে খুলবে।';
      await loadAdminReferralBranch(null, 'adminReferralTree');
    } catch (error) {
      console.error('Admin referral load error:', error);
      tree.innerHTML = `<div class="referral-state referral-state-error">${escape(error.message)}</div>`;
    }
  };

  window.saveAdminReferralSettings = async () => {
    const button = document.querySelector('#adminReferralsSection .referral-admin-settings .btn-submit');
    if (button) button.disabled = true;
    try {
      const body = {
        is_enabled: document.getElementById('referralProgramEnabled').checked,
        customer_reward_percent: Number(document.getElementById('referralCustomerPercent').value),
        reseller_commission_percent: Number(document.getElementById('referralResellerPercent').value)
      };
      await request('/api/admin/referrals/settings', { method: 'PUT', body: JSON.stringify(body) });
      alert('রেফারেল প্রোগ্রামের নতুন নিয়ম সংরক্ষণ হয়েছে। এগুলো নতুন অর্ডারে প্রযোজ্য হবে।');
    } catch (error) {
      alert(error.message || 'রেফারেল নিয়ম সংরক্ষণ করা যায়নি');
    } finally {
      if (button) button.disabled = false;
    }
  };

  window.loadAdminReferralBranch = async (parentId, containerId, offset = 0) => {
    const container = document.getElementById(containerId);
    if (!container) return;
    if (offset === 0) container.innerHTML = '<div class="referral-state">শাখা লোড হচ্ছে…</div>';
    else container.querySelector('.referral-load-more')?.remove();
    try {
      const params = new URLSearchParams({ offset: String(offset) });
      if (parentId) params.set('parent_id', String(parentId));
      const suffix = `?${params.toString()}`;
      const data = await request(`/api/admin/referrals/tree${suffix}`);
      if (!data.members.length) {
        container.innerHTML = '<div class="referral-state">এখানে কোনো আমন্ত্রিত সদস্য পাওয়া যায়নি।</div>';
        return;
      }
      const membersHtml = data.members.map((member) => renderMember(member)).join('');
      if (offset === 0) container.innerHTML = membersHtml;
      else container.insertAdjacentHTML('beforeend', membersHtml);
      if (data.next_offset !== null && data.next_offset !== undefined) {
        const parentArg = parentId ? String(Number(parentId)) : 'null';
        container.insertAdjacentHTML('beforeend', `<button type="button" class="referral-load-more" onclick="loadAdminReferralBranch(${parentArg}, '${escape(containerId)}', ${Number(data.next_offset)})">আরও সদস্য দেখুন</button>`);
      }
      container.dataset.loaded = 'true';
    } catch (error) {
      console.error('Admin referral branch error:', error);
      container.innerHTML = `<div class="referral-state referral-state-error">${escape(error.message)}</div>`;
    }
  };

  function renderMember(member) {
    const role = member.role === 'reseller' ? 'রিসেলার' : member.role === 'admin' ? 'অ্যাডমিন' : 'কাস্টমার';
    return `
      <article class="admin-referral-member">
        <div class="admin-referral-member-main">
          <button type="button" class="admin-referral-member-name" onclick="openAdminReferralMember(${Number(member.id)})">
            <strong>${escape(member.name)}</strong><span>${role} · ${escape(member.phone)}</span>
          </button>
          <div class="admin-referral-member-counts"><span>সরাসরি আমন্ত্রিত: ${escape(member.direct_referral_count)}</span><span>কাস্টমার: ${escape(member.direct_customer_count)}</span><span>রিসেলার: ${escape(member.direct_reseller_count)}</span></div>
          <div class="admin-referral-member-counts"><span>ডেলিভারি সম্পন্ন অর্ডার: ${escape(member.delivered_order_count)}</span><span>পণ্য: ${escape(member.delivered_units)}টি</span><span>বিক্রি: ${escape(member.delivered_order_total)} ৳</span></div>
        </div>
        <div class="admin-referral-member-actions">
          <button type="button" class="action-btn-sm btn-confirm" onclick="openAdminReferralMember(${Number(member.id)})">প্রোফাইল ও অর্ডার</button>
          ${member.has_children ? `<button type="button" class="action-btn-sm btn-ship" onclick="toggleAdminReferralBranch(${Number(member.id)})">শাখা খুলুন (${escape(member.direct_referral_count)})</button>` : '<span class="referral-leaf-label">শেষ শাখা</span>'}
        </div>
        ${member.has_children ? `<div id="adminReferralBranch${Number(member.id)}" class="referral-tree-children" hidden></div>` : ''}
      </article>`;
  }

  window.toggleAdminReferralBranch = async (memberId) => {
    const child = document.getElementById(`adminReferralBranch${memberId}`);
    if (!child) return;
    if (!child.hidden && child.dataset.loaded === 'true') {
      child.hidden = true;
      return;
    }
    child.hidden = false;
    if (child.dataset.loaded !== 'true') await window.loadAdminReferralBranch(memberId, child.id);
  };

  window.searchAdminReferralMembers = () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(async () => {
      const input = document.getElementById('referralMemberSearch');
      const results = document.getElementById('referralSearchResults');
      const term = input ? input.value.trim() : '';
      if (!results) return;
      if (term.length < 2) {
        results.replaceChildren();
        return;
      }
      results.innerHTML = '<div class="referral-state">সদস্য খোঁজা হচ্ছে…</div>';
      try {
        const data = await request(`/api/admin/referrals/search?q=${encodeURIComponent(term)}`);
        results.innerHTML = data.members.length ? data.members.map((member) => `
          <button type="button" class="referral-search-result" onclick="openAdminReferralMember(${Number(member.id)})">
            <strong>${escape(member.name)}</strong><span>${member.role === 'reseller' ? 'রিসেলার' : member.role === 'admin' ? 'অ্যাডমিন' : 'কাস্টমার'} · ${escape(member.phone)} · ${escape(member.referral_code)}</span>
          </button>`).join('') : '<div class="referral-state">মিল পাওয়া যায়নি।</div>';
      } catch (error) {
        results.innerHTML = `<div class="referral-state referral-state-error">${escape(error.message)}</div>`;
      }
    }, 250);
  };

  window.openAdminReferralMember = async (memberId) => {
    const profile = document.getElementById('adminReferralProfile');
    if (!profile) return;
    profile.innerHTML = '<div class="referral-state">সদস্যের তথ্য লোড হচ্ছে…</div>';
    try {
      const [profileData, orderData] = await Promise.all([
        request(`/api/admin/referrals/members/${memberId}`),
        request(`/api/admin/referrals/members/${memberId}/orders`)
      ]);
      const member = profileData.member;
      const orders = orderData.orders;
      profile.innerHTML = `
        <div class="referral-admin-section-title"><h4>👤 ${escape(member.name)}</h4><span class="referral-role-chip">${member.role === 'reseller' ? 'রিসেলার' : member.role === 'admin' ? 'অ্যাডমিন' : 'কাস্টমার'}</span></div>
        <div class="referral-profile-details"><div><span>ফোন</span><strong>${escape(member.phone)}</strong></div><div><span>রেফারেল কোড</span><strong>${escape(member.referral_code)}</strong></div><div><span>যিনি আমন্ত্রণ করেছেন</span><strong>${escape(member.referrer_name || 'সরাসরি / নেই')}</strong></div><div><span>সরাসরি সদস্য</span><strong>${escape(member.direct_referrals)} (${escape(member.direct_customers)} কাস্টমার · ${escape(member.direct_resellers)} রিসেলার)</strong></div><div><span>পুরো দল</span><strong>${escape(member.total_team_count)} জন</strong></div><div><span>অর্ডার</span><strong>${escape(member.delivered_orders)} ডেলিভারি সম্পন্ন / ${escape(member.total_orders)} মোট</strong></div><div><span>ডেলিভারি সম্পন্ন বিক্রি</span><strong>${escape(member.delivered_sales)} ৳</strong></div>${member.role === 'reseller' ? `<div><span>নগদ রেফারেল কমিশন</span><strong>${escape(member.referral_commission_earned)} ৳ · অপেক্ষমাণ ${escape(member.referral_commission_pending)} ৳</strong></div>` : member.role === 'customer' ? `<div><span>ব্যবহারযোগ্য রেফারেল ছাড়</span><strong>${escape(member.referral_credit_available)} ৳ · ডেলিভারি হলে জমা ${escape(member.referral_credit_pending)} ৳</strong></div><div><span>মোট ছাড় জমা / ব্যবহার</span><strong>${escape(member.referral_credit_earned)} ৳ / ${escape(member.referral_credit_used)} ৳</strong></div>` : ''}</div>
        ${Number(member.direct_referrals) > 0 ? `<button type="button" class="action-btn-sm btn-ship" onclick="showAdminReferralBranch(${Number(member.id)})">এই সদস্যের আমন্ত্রণের শাখা দেখুন</button>` : ''}
        <h5 class="referral-orders-heading">কেনাকাটা ও পণ্যের হিসাব (${orders.length})</h5>
        <div class="referral-admin-orders">${orders.length ? orders.map((order) => `
          <article class="referral-admin-order"><div><strong>#${escape(order.order_number)}</strong><span>${escape(statusLabel(order.status))} · ${escape(new Date(order.created_at).toLocaleDateString('bn-BD'))}</span></div><strong>${escape(order.total_amount)} ৳</strong><small>${order.items.map((item) => `${escape(item.title)} × ${escape(item.quantity)}`).join(' · ') || 'পণ্যের তথ্য নেই'}</small><small>পণ্যের দাম ${escape(order.subtotal_amount)} ৳ · ব্যবহৃত ছাড় ${escape(order.discount_amount)} ৳ · রিসেলার আমন্ত্রণ কমিশন ${escape(order.referral_commission_amount)} ৳ · কাস্টমার ছাড় জমা ${escape(order.referral_credit_amount)} ৳</small></article>
        `).join('') : '<div class="referral-state">এই অ্যাকাউন্টের কোনো অর্ডার নেই।</div>'}</div>`;
    } catch (error) {
      console.error('Admin referral profile error:', error);
      profile.innerHTML = `<div class="referral-state referral-state-error">${escape(error.message)}</div>`;
    }
  };

  window.showAdminReferralBranch = async (memberId) => {
    const tree = document.getElementById('adminReferralTree');
    const status = document.getElementById('referralTreeStatus');
    if (status) status.textContent = 'নির্বাচিত সদস্যের সরাসরি আমন্ত্রণের শাখা দেখানো হচ্ছে।';
    await window.loadAdminReferralBranch(memberId, 'adminReferralTree');
    tree?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
})();
