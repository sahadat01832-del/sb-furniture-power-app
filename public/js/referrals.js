(() => {
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
  const apiUrl = (path) => (typeof window.apiUrl === 'function' ? window.apiUrl(path) : path);
  let checkoutCreditBalance = 0;

  const normalizePhone = (value) => {
    let digits = String(value || '').replace(/\D/g, '');
    if (digits.startsWith('00880')) digits = `0${digits.slice(5)}`;
    else if (digits.startsWith('880')) digits = `0${digits.slice(3)}`;
    return digits;
  };
  const statusLabel = (status) => ({
    pending: 'অপেক্ষমাণ', confirmed: 'নিশ্চিত', shipped: 'পাঠানো হয়েছে', delivered: 'ডেলিভারি সম্পন্ন', cancelled: 'বাতিল'
  }[status] || 'অজানা');

  window.referralCreditAvailable = 0;

  async function fetchReferralSummary() {
    if (!authToken || !currentUser) return null;
    const response = await fetch(apiUrl('/api/referrals/summary'), {
      headers: { Authorization: `Bearer ${authToken}` }
    });
    const data = await response.json();
    return response.ok && data.success ? data.summary : null;
  }

  window.loadMyReferralDashboard = async (containerId) => {
    const container = document.getElementById(containerId);
    if (!container || !currentUser) return;
    container.innerHTML = '<div class="referral-state">আপনার রেফারেল হিসাব লোড হচ্ছে…</div>';
    try {
      const summary = await fetchReferralSummary();
      if (!summary) {
        container.innerHTML = '<div class="referral-state">রেফারেল হিসাব এখন পাওয়া যাচ্ছে না। পরে আবার চেষ্টা করুন।</div>';
        return;
      }
      const shareUrl = `${window.location.origin}/?ref=${encodeURIComponent(summary.referral_code)}`;
      const isReseller = summary.role === 'reseller';
      const rewardPending = isReseller ? summary.referral_commission_pending : summary.referral_credit_pending;
      const rewardLabel = isReseller ? 'নগদ রেফারেল কমিশন' : 'ব্যবহারযোগ্য ছাড়';
      const rewardAvailable = isReseller
        ? `${escape(summary.referral_commission_earned)} ৳`
        : `${escape(summary.referral_credit_available)} ৳`;
      const rewardDescription = isReseller
        ? `আপনার সরাসরি আমন্ত্রিত সদস্যের নিজের প্রতিটি ডেলিভারি সম্পন্ন অর্ডারে পণ্যমূল্যের ${escape(summary.reseller_commission_percent)}% পর্যন্ত নগদ কমিশন পাবেন।`
        : `আপনার আমন্ত্রিত বন্ধুর প্রতিটি ডেলিভারি সম্পন্ন অর্ডারে পণ্যমূল্যের ${escape(summary.customer_reward_percent)}% পর্যন্ত পরের কেনাকাটার ছাড় জমা হবে।`;
      container.innerHTML = `
        <section class="member-referral-card">
          <div class="member-referral-heading">
            <div><span class="referral-kicker">আপনার রেফারেল</span><h4>শেয়ার করুন, ছাড় ও আয় দেখুন</h4></div>
            <span class="member-referral-tree-icon" aria-hidden="true">🌳</span>
          </div>
          <p class="member-referral-copy">এই লিংক দিয়ে নতুন অ্যাকাউন্ট খুললে তিনি আপনার রেফারেল গাছে যুক্ত হবেন। পুরস্কার পেতে তাঁকে নিজের অ্যাকাউন্টে লগইন করে সেই অ্যাকাউন্টের ফোন নম্বর দিয়ে অর্ডার করতে হবে; ডেলিভারি সম্পন্ন হলে হিসাব হবে। ${rewardDescription} অ্যাডমিনের নিয়মে পুরস্কারের হার বদলাতে পারে।</p>
          <div class="member-referral-share-row">
            <input id="myReferralShareLink${escape(containerId)}" class="form-control" type="text" readonly value="${escape(shareUrl)}" aria-label="আপনার রেফারেল লিংক">
            <button type="button" class="btn-copy-link" onclick="copyMyReferralLink('${escape(containerId)}')">লিংক কপি</button>
          </div>
          <div class="member-referral-code">কোড: <strong>${escape(summary.referral_code)}</strong> ${summary.program_enabled ? '<span class="referral-program-on">প্রোগ্রাম চালু</span>' : '<span class="referral-program-off">প্রোগ্রাম আপাতত বন্ধ</span>'}</div>
          <div class="member-referral-stats">
            <div><span>সরাসরি ক্রেতা</span><strong>${escape(summary.direct_customer_count)}</strong></div>
            <div><span>সরাসরি রিসেলার</span><strong>${escape(summary.direct_reseller_count)}</strong></div>
            <div><span>পুরো দল</span><strong>${escape(summary.total_team_count)}</strong></div>
            <div><span>${escape(rewardLabel)}</span><strong>${rewardAvailable}</strong></div>
            <div><span>ডেলিভারি হলে জমা হবে</span><strong>${escape(rewardPending)} ৳</strong></div>
            <div><span>রেফারেলের ডেলিভারি সম্পন্ন অর্ডার</span><strong>${escape(summary.delivered_referral_order_count)}</strong></div>
          </div>
          ${isReseller ? '<p class="member-referral-footnote">কমিশন সরাসরি আমন্ত্রিত সদস্যের নিজের ডেলিভারি সম্পন্ন অর্ডারে হিসাব হয়। এটি পণ্য বিক্রির রিসেলার কমিশন থেকে আলাদা।</p>' : `<p class="member-referral-footnote">বন্ধুর ডেলিভারি সম্পন্ন অর্ডারের পর ছাড় জমা হবে। পরে নিজের অ্যাকাউন্ট দিয়ে কেনাকাটায় ব্যবহার করতে পারবেন। মোট জমা: ${escape(summary.referral_credit_earned)} ৳ · ব্যবহার: ${escape(summary.referral_credit_used)} ৳</p>`}
          <details class="member-referral-tree" ontoggle="if(this.open) loadMyReferralBranch(${Number(summary.user_id)}, 'myReferralBranch${escape(containerId)}')">
            <summary>আমার রেফারেল গাছ খুলুন (${escape(summary.total_team_count)} জন)</summary>
            <div id="myReferralBranch${escape(containerId)}" class="referral-tree-list"></div>
          </details>
        </section>`;
      const useCreditPanel = document.getElementById('referralCreditPanel');
      const matchesAccount = ['customer', 'reseller'].includes(currentUser.role);
      if (matchesAccount) checkoutCreditBalance = Number(summary.referral_credit_available || 0);
      if (useCreditPanel) {
        window.syncReferralCreditCheckout();
      }
    } catch (error) {
      console.error('Referral dashboard error:', error);
      container.innerHTML = '<div class="referral-state referral-state-error">রেফারেল হিসাব লোড করা যায়নি। ইন্টারনেট দেখে আবার চেষ্টা করুন।</div>';
    }
  };

  window.copyMyReferralLink = async (containerId) => {
    const input = document.getElementById(`myReferralShareLink${containerId}`);
    if (!input) return;
    try {
      await navigator.clipboard.writeText(input.value);
    } catch (error) {
      input.select();
      document.execCommand('copy');
    }
    if (typeof window.showToast === 'function') window.showToast('রেফারেল লিংক কপি হয়েছে');
  };

  window.loadReferralCreditForCheckout = async () => {
    const panel = document.getElementById('referralCreditPanel');
    if (!panel) return;
    const user = currentUser;
    if (!user || !['customer', 'reseller'].includes(user.role) || !authToken) {
      panel.hidden = true;
      window.referralCreditAvailable = 0;
      return;
    }
    try {
      const summary = await fetchReferralSummary();
      checkoutCreditBalance = Number(summary && summary.referral_credit_available || 0);
      const label = document.getElementById('referralCreditAvailableLabel');
      if (label) label.textContent = `${checkoutCreditBalance} ৳`;
      window.syncReferralCreditCheckout();
    } catch (error) {
      console.error('Checkout referral credit error:', error);
      panel.hidden = true;
    }
  };

  window.syncReferralCreditCheckout = () => {
    const panel = document.getElementById('referralCreditPanel');
    const checkbox = document.getElementById('useReferralCredit');
    if (!panel || !checkbox) return;
    const accountPhone = currentUser && ['customer', 'reseller'].includes(currentUser.role) ? normalizePhone(currentUser.phone) : '';
    const orderPhone = normalizePhone(document.getElementById('orderCustPhone')?.value);
    const canUse = Boolean(accountPhone && accountPhone === orderPhone && checkoutCreditBalance > 0);
    panel.hidden = !canUse;
    if (!canUse) checkbox.checked = false;
    window.referralCreditAvailable = canUse ? checkoutCreditBalance : 0;
    const label = document.getElementById('referralCreditAvailableLabel');
    if (label) label.textContent = `${checkoutCreditBalance} ৳`;
    if (typeof window.calculateCartTotals === 'function') window.calculateCartTotals();
  };

  window.loadMyReferralBranch = async (parentId, containerId, offset = 0) => {
    const container = document.getElementById(containerId);
    if (!container) return;
    if (offset === 0) container.innerHTML = '<div class="referral-state">শাখা লোড হচ্ছে…</div>';
    else container.querySelector('.referral-load-more')?.remove();
    try {
      const response = await fetch(apiUrl(`/api/referrals/tree?parent_id=${encodeURIComponent(parentId)}&offset=${offset}`), {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || 'শাখা লোড ব্যর্থ');
      if (!data.members.length) {
        container.innerHTML = '<div class="referral-state">এই শাখায় এখনো কেউ যুক্ত হয়নি।</div>';
        return;
      }
      const membersHtml = data.members.map((member) => `
        <article class="referral-tree-member">
          <div class="referral-tree-member-top">
            <div><strong>${escape(member.name)}</strong><span class="referral-member-role">${member.role === 'reseller' ? 'রিসেলার' : 'কাস্টমার'} · ${escape(member.phone)}</span></div>
            <span class="referral-member-orders">${escape(member.delivered_order_count)}টি ডেলিভারি</span>
          </div>
          <div class="referral-tree-member-stats"><span>তার সরাসরি আমন্ত্রণ: ${escape(member.direct_referral_count)}</span><span>পণ্য: ${escape(member.delivered_units)}টি</span><span>বিক্রি: ${escape(member.delivered_order_total)} ৳</span></div>
          <div class="referral-tree-member-actions">
            <button type="button" onclick="loadMyReferralOrders(${Number(member.id)}, 'myReferralOrders${Number(member.id)}')">কেনাকাটা দেখুন</button>
            ${member.has_children ? `<button type="button" onclick="toggleMyReferralBranch(${Number(member.id)})">তার আমন্ত্রণের শাখা খুলুন</button>` : ''}
          </div>
          <div id="myReferralOrders${Number(member.id)}" class="referral-member-orders-list" hidden></div>
          ${member.has_children ? `<div id="myReferralBranch${Number(member.id)}" class="referral-tree-children" hidden></div>` : ''}
        </article>`).join('');
      if (offset === 0) container.innerHTML = membersHtml;
      else container.insertAdjacentHTML('beforeend', membersHtml);
      if (data.next_offset !== null && data.next_offset !== undefined) {
        container.insertAdjacentHTML('beforeend', `<button type="button" class="referral-load-more" onclick="loadMyReferralBranch(${Number(parentId)}, '${escape(containerId)}', ${Number(data.next_offset)})">আরও সদস্য দেখুন</button>`);
      }
      container.dataset.loaded = 'true';
    } catch (error) {
      console.error('Referral branch error:', error);
      container.innerHTML = '<div class="referral-state referral-state-error">এই রেফারেল শাখা লোড করা যায়নি।</div>';
    }
  };

  window.toggleMyReferralBranch = async (parentId) => {
    const child = document.getElementById(`myReferralBranch${parentId}`);
    if (!child) return;
    if (!child.hidden && child.dataset.loaded === 'true') {
      child.hidden = true;
      return;
    }
    child.hidden = false;
    if (child.dataset.loaded !== 'true') await window.loadMyReferralBranch(parentId, child.id);
  };

  window.loadMyReferralOrders = async (memberId, containerId) => {
    const container = document.getElementById(containerId);
    if (!container) return;
    if (container.dataset.loaded === 'true') {
      container.hidden = !container.hidden;
      return;
    }
    container.hidden = false;
    container.innerHTML = '<div class="referral-state">অর্ডার লোড হচ্ছে…</div>';
    try {
      const response = await fetch(apiUrl(`/api/referrals/members/${memberId}/orders`), {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || 'অর্ডার লোড ব্যর্থ');
      container.innerHTML = data.orders.length ? data.orders.map((order) => `
        <div class="referral-order-row"><strong>#${escape(order.order_number)} · ${escape(statusLabel(order.status))}</strong><span>${escape(order.total_amount)} ৳ · ছাড় ${escape(order.discount_amount)} ৳</span><small>${order.items.map((item) => `${escape(item.title)} × ${escape(item.quantity)}`).join(' · ')}</small></div>
      `).join('') : '<div class="referral-state">এই সদস্যের অর্ডার নেই।</div>';
      container.dataset.loaded = 'true';
    } catch (error) {
      console.error('Referral member orders error:', error);
      container.innerHTML = '<div class="referral-state referral-state-error">অর্ডার লোড করা যায়নি।</div>';
    }
  };
})();
