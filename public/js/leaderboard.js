// ============================================================
// SB Furniture & SB POWER — Reseller Leaderboard & Prizes Module
// ============================================================

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

    const prizesHtml = (data.prizes || []).map((p) => `
      <div class="leaderboard-prize-card">
        <div class="prize-icon">${p.icon}</div>
        <div class="prize-details">
          <div class="prize-rank">${p.rank}</div>
          <div class="prize-reward">${p.reward}</div>
        </div>
      </div>
    `).join('');

    const leadersHtml = (data.leaders || []).map((l, index) => {
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
            <div style="font-weight: 700; color: #fff;">${l.name}</div>
            <div style="font-size: 0.75rem; color: var(--sbf-text-muted);">${l.city || l.phone || ''}</div>
          </td>
          <td style="text-align: center; font-weight: 700; color: var(--sbp-yellow);">
            ${l.total_sales} টি সেল
          </td>
          <td style="text-align: right;">
            <span class="badge-leader ${index === 0 ? 'badge-champion' : ''}">${l.badge || 'রিসেলার'}</span>
          </td>
        </tr>
      `;
    }).join('');

    container.innerHTML = `
      <!-- Campaign Banner -->
      <div class="leaderboard-campaign-header">
        <h4>🏆 ${data.campaign}</h4>
        <p>${data.rules || 'প্রতি মাসের শীর্ষ ৩ জন রিসেলার সরাসরি নগদ ক্যাশ ও আকর্ষণীয় গ্যাজেট প্রাইজ বিজয়ী হবেন!'}</p>
      </div>

      <!-- Prizes Grid -->
      <div class="leaderboard-prizes-grid">
        ${prizesHtml}
      </div>

      <!-- Live Rankings -->
      <div style="margin-top: 20px;">
        <h4 style="color: #fff; font-size: 1rem; margin-bottom: 10px; display: flex; align-items: center; justify-content: space-between;">
          <span>📊 শীর্ষ রিসেলারদের লাইভ তালিকা</span>
          <span style="font-size: 0.75rem; color: #10b981;">● লাইভ আপডেট</span>
        </h4>
        <div class="table-responsive" style="border-radius: var(--radius-sm);">
          <table style="width: 100%;">
            <thead>
              <tr style="background: #1c1917; color: var(--sbf-text-muted);">
                <th style="text-align: center; width: 50px;">র‌্যাংক</th>
                <th>রিসেলার নাম</th>
                <th style="text-align: center;">সফল সেল</th>
                <th style="text-align: right;">অর্জন</th>
              </tr>
            </thead>
            <tbody>
              ${leadersHtml}
            </tbody>
          </table>
        </div>
      </div>

      <!-- Action Footer -->
      <div style="margin-top: 18px; text-align: center; background: rgba(180, 83, 9, 0.15); border: 1px dashed var(--sbf-amber); border-radius: var(--radius-sm); padding: 14px;">
        <p style="font-size: 0.88rem; color: #fde68a; font-weight: 600; margin-bottom: 8px;">
          🚀 ঘরে বসেই ফার্নিচার ও গ্যাজেট বিক্রি করে সেরা রিসেলারদের তালিকায় আপনার নাম তুলুন!
        </p>
        <button class="btn-submit" style="margin-top: 0; width: auto; padding: 10px 24px;" onclick="closeModal('leaderboardModal'); openResellerModal();">
          💼 এখনই রিসেলার ড্যাশবোর্ডে যান
        </button>
      </div>
    `;
  } catch (err) {
    console.error('Leaderboard Fetch Error:', err);
    container.innerHTML = `<div style="color: var(--sbp-red); text-align: center; padding: 20px;">সার্ভার সংযোগে সমস্যা হয়েছে।</div>`;
  }
}
