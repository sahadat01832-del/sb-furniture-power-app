// ============================================================
// SB Furniture & SB POWER — Real Reseller Sales Module
// ============================================================

const escapeLeaderboardHtml = (value) => window.sbEscapeHtml(value);

async function openLeaderboardModal() {
  const modal = document.getElementById('leaderboardModal');
  const container = document.getElementById('leaderboardContent');
  if (!modal || !container) return;

  container.innerHTML = `
    <div style="text-align: center; padding: 30px; color: var(--sbf-text-muted);">
      ⏳ লিডারবোর্ড তথ্য লোড হচ্ছে...
    </div>
  `;
  openModal('leaderboardModal');

  try {
    const fetchUrl = typeof apiUrl === 'function' ? apiUrl('/api/leaderboard') : '/api/leaderboard';
    const res = await fetch(fetchUrl);
    const data = await res.json();

    if (!data.success) {
      container.innerHTML = `<div style="color: var(--sbp-red); text-align: center; padding: 20px;">ডাটা লোড করা যায়নি।</div>`;
      return;
    }

    const leaders = Array.isArray(data.leaders) ? data.leaders : [];
    if (leaders.length === 0) {
      container.innerHTML = `
        <div class="leaderboard-campaign-header">
          <h2>বাস্তব বিক্রির তালিকা</h2>
          <p>সফল ডেলিভারি এখনো নেই। প্রথম delivered অর্ডার এলে এখানে রিসেলার তালিকা দেখা যাবে।</p>
        </div>
      `;
      return;
    }

    const leadersHtml = leaders.map((l, index) => {
      let rankBadgeClass = 'rank-default';
      let rankIcon = `${index + 1}`;
      if (index === 0) {
        rankBadgeClass = 'rank-gold';
        rankIcon = '🥇';
      } else if (index === 1) {
        rankBadgeClass = 'rank-silver';
        rankIcon = '🥈';
      } else if (index === 2) {
        rankBadgeClass = 'rank-bronze';
        rankIcon = '🥉';
      }

      return `
        <tr class="${index < 3 ? 'top-leader-row' : ''}">
          <td style="text-align: center;"><span class="rank-circle ${rankBadgeClass}">${rankIcon}</span></td>
          <td>
            <div style="font-weight: 700; color: var(--text-primary);">${escapeLeaderboardHtml(l.name)}</div>
            <div style="font-size: 0.75rem; color: var(--text-muted);">${escapeLeaderboardHtml(l.city || l.phone || '')}</div>
          </td>
          <td style="text-align: center; font-weight: 700; color: var(--brand-primary-hv);">
            ${escapeLeaderboardHtml(l.total_sales)} টি সেল
          </td>
          <td style="text-align: right;">
            <span class="badge-leader ${index === 0 ? 'badge-champion' : ''}">${escapeLeaderboardHtml(l.badge || 'রিসেলার')}</span>
          </td>
        </tr>
      `;
    }).join('');

    container.innerHTML = `
      <div class="leaderboard-campaign-header">
        <h2>📊 ${escapeLeaderboardHtml(data.campaign || 'সফল অর্ডারের তালিকা')}</h2>
        <p>${escapeLeaderboardHtml(data.rules || 'শুধু delivered অর্ডারের বাস্তব তথ্য এখানে দেখানো হয়।')}</p>
      </div>

      <div style="margin-top: 20px;">
        <h3 style="color: var(--text-primary); font-size: 1rem; margin-bottom: 10px; display: flex; align-items: center; justify-content: space-between;">
          <span>📊 শীর্ষ রিসেলারদের লাইভ তালিকা</span>
          <span style="font-size: 0.75rem; color: var(--brand-success); font-weight: 700;">● লাইভ আপডেট</span>
        </h3>
        <div class="table-responsive">
          <table>
            <thead>
              <tr>
                <th scope="col" style="text-align: center; width: 56px;">র‌্যাংক</th>
                <th scope="col">রিসেলার নাম</th>
                <th scope="col" style="text-align: center;">সফল সেল</th>
                <th scope="col" style="text-align: right;">অর্জন</th>
              </tr>
            </thead>
            <tbody>
              ${leadersHtml}
            </tbody>
          </table>
        </div>
      </div>

    `;
  } catch (err) {
    console.error('Leaderboard Fetch Error:', err);
    container.innerHTML = `<div style="color: var(--sbp-red); text-align: center; padding: 20px;">সার্ভার সংযোগে সমস্যা হয়েছে।</div>`;
  }
}
