/**
 * ETF配息通 — 核心計算引擎與介面控制器
 */
(function () {
  const STORAGE_KEY = 'etf_stock_transactions_v1';
  const TODAY_STR = new Date().toISOString().slice(0, 10);

  let state = {
    activeTab: 'dashboard',
    calendarFilter: 'all', // 'all' | 'holdings'
    rankingSort: 'yield',  // 'yield' | 'freq' | 'amount'
    transactions: loadTransactions()
  };

  function loadTransactions() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch (_) {
      // ignore storage errors
    }
    return JSON.parse(JSON.stringify(window.DEFAULT_TRANSACTIONS));
  }

  function saveTransactions() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.transactions));
    } catch (_) {
      // ignore storage errors
    }
  }

  function formatNT(num) {
    return 'NT$' + Math.round(num).toLocaleString('zh-TW');
  }

  function formatMD(dateStr) {
    const parts = dateStr.split('-');
    return `${parseInt(parts[1], 10)}/${parseInt(parts[2], 10)}`;
  }

  function getETF(code) {
    return window.ETF_CATALOG.find((e) => e.code === code);
  }

  /**
   * 計算特定 ETF 在「除息日前一日（嚴格小於 exDate）」的實際持有股數
   * 規則：買入日期 < exDate 才具備該期領息資格；賣出日期 < exDate 則扣除股數
   */
  function getEligibleShares(code, exDate) {
    let shares = 0;
    for (const tx of state.transactions) {
      if (tx.code !== code) continue;
      if (tx.date < exDate) {
        shares += tx.type === 'buy' ? Number(tx.shares) : -Number(tx.shares);
      }
    }
    return Math.max(0, shares);
  }

  /**
   * 取得目前總持股明細（含平均成本、現值）
   */
  function getCurrentHoldings() {
    const map = {};
    const sorted = [...state.transactions].sort((a, b) => a.date.localeCompare(b.date));

    for (const tx of sorted) {
      if (!map[tx.code]) {
        map[tx.code] = { code: tx.code, shares: 0, totalCost: 0 };
      }
      const h = map[tx.code];
      const qty = Number(tx.shares);
      const price = Number(tx.price);
      if (tx.type === 'buy') {
        h.shares += qty;
        h.totalCost += qty * price;
      } else {
        const avg = h.shares > 0 ? h.totalCost / h.shares : 0;
        h.shares = Math.max(0, h.shares - qty);
        h.totalCost = Math.max(0, h.shares * avg);
      }
    }

    return Object.values(map)
      .filter((h) => h.shares > 0)
      .map((h) => {
        const etf = getETF(h.code);
        const avgCost = h.shares > 0 ? h.totalCost / h.shares : 0;
        const marketValue = etf ? h.shares * etf.price : 0;
        const estAnnualDiv = etf ? h.shares * etf.annualDividendPerShare : 0;
        return {
          ...h,
          etf,
          avgCost,
          marketValue,
          estAnnualDiv
        };
      });
  }

  /**
   * 取得所有符合領息資格的配息入帳項目
   */
  function getEligiblePayouts() {
    const payouts = [];
    for (const etf of window.ETF_CATALOG) {
      for (const div of etf.dividends) {
        const shares = getEligibleShares(etf.code, div.exDate);
        if (shares > 0) {
          const totalAmount = Math.round(shares * div.amount);
          const isPaid = div.payDate <= TODAY_STR;
          payouts.push({
            code: etf.code,
            name: etf.name,
            exDate: div.exDate,
            payDate: div.payDate,
            payYear: parseInt(div.payDate.slice(0, 4), 10),
            payMonth: parseInt(div.payDate.slice(5, 7), 10),
            perShare: div.amount,
            shares,
            totalAmount,
            isPaid
          });
        }
      }
    }
    return payouts.sort((a, b) => a.payDate.localeCompare(b.payDate));
  }

  /* ======================== RENDERERS ======================== */

  function renderDashboard() {
    const currentYear = parseInt(TODAY_STR.slice(0, 4), 10);
    const currentMonth = parseInt(TODAY_STR.slice(5, 7), 10);
    const allPayouts = getEligiblePayouts();

    // 下一筆預估入帳（payDate >= 今天）
    const upcomingPayouts = allPayouts.filter((p) => p.payDate >= TODAY_STR);
    const nextPayout = upcomingPayouts[0] || null;

    // 本月入帳明細
    const monthPayouts = allPayouts.filter(
      (p) => p.payYear === currentYear && p.payMonth === currentMonth
    );
    const monthTotal = monthPayouts.reduce((s, p) => s + p.totalAmount, 0);
    const monthPaid = monthPayouts
      .filter((p) => p.isPaid)
      .reduce((s, p) => s + p.totalAmount, 0);
    const monthPending = monthTotal - monthPaid;

    // 年度入帳總覽
    const yearPayouts = allPayouts.filter((p) => p.payYear === currentYear);
    const yearTotal = yearPayouts.reduce((s, p) => s + p.totalAmount, 0);
    const monthlyTotals = Array(12).fill(0);
    for (const p of yearPayouts) {
      monthlyTotals[p.payMonth - 1] += p.totalAmount;
    }
    const maxMonthVal = Math.max(1, ...monthlyTotals);

    const nextCardHtml = nextPayout
      ? `
      <div class="card card-interactive" id="next-payout-card" data-code="${nextPayout.code}" data-paydate="${nextPayout.payDate}">
        <div class="row-between">
          <div class="payout-left">
            <div class="icon-badge">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>
              </svg>
            </div>
            <div>
              <div class="card-row-title">${nextPayout.code} ${nextPayout.name}</div>
              <div class="card-row-sub">預計 ${formatMD(nextPayout.payDate)} 發放 · ${nextPayout.shares.toLocaleString()} 股</div>
            </div>
          </div>
          <div class="payout-amount">
            <span>${formatNT(nextPayout.totalAmount)}</span>
            <span class="chevron">&rsaquo;</span>
          </div>
        </div>
      </div>`
      : `
      <div class="card card-interactive empty-next-card" id="go-watchlist-card">
        <div class="icon-badge">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>
          </svg>
        </div>
        <div class="card-row-content">
          <div class="card-row-title">目前沒有符合持有資格的近期配息發放</div>
          <div class="card-row-sub">依各期除息日前持股計算；買賣紀錄可在自選的「買賣紀錄管理」查看或更正。</div>
        </div>
        <span class="chevron">&rsaquo;</span>
      </div>`;

    const monthItemsHtml =
      monthPayouts.length > 0
        ? monthPayouts
            .map(
              (p) => `
          <div class="payout-row" data-payout-detail="${p.code}|${p.payDate}">
            <div class="payout-left">
              <span class="dot ${p.isPaid ? '' : 'pending'}"></span>
              <div>
                <div class="payout-code">${p.code}</div>
                <div class="payout-meta">${p.name} · ${formatMD(p.payDate)}</div>
              </div>
            </div>
            <div class="payout-amount">
              <span>${formatNT(p.totalAmount)}</span>
              <span class="chevron">&rsaquo;</span>
            </div>
          </div>`
            )
            .join('')
        : `<div class="payout-row" id="add-trade-shortcut">
            <div class="payout-left">
              <span class="dot pending"></span>
              <div>
                <div class="payout-code">本月尚無預估入帳</div>
                <div class="payout-meta">點此新增買入紀錄，系統將自動計算除息資格</div>
              </div>
            </div>
            <span class="chevron">&rsaquo;</span>
          </div>`;

    const barsHtml = monthlyTotals
      .map((val, idx) => {
        const pct = val > 0 ? Math.max(12, Math.round((val / maxMonthVal) * 100)) : 4;
        const isCurr = idx + 1 === currentMonth;
        return `
        <div class="bar-col" title="${idx + 1}月：${formatNT(val)}">
          <div class="bar-track">
            <div class="bar-fill ${isCurr ? 'current' : ''}" style="height: ${pct}%"></div>
          </div>
          <span class="bar-label">${idx + 1}</span>
        </div>`;
      })
      .join('');

    return `
      <header class="hero-header">
        <div class="hero-text">
          <div class="eyebrow eyebrow-gold">ETF DIVIDEND TRACKER</div>
          <h1 class="hero-title">ETF配息通</h1>
          <p class="hero-subtitle">你的下一筆配息，不用再找。</p>
          <p class="hero-caption">先看個人預估入帳，再掌握全市場除息與發放節奏。</p>
        </div>
        <svg class="hero-art" viewBox="0 0 120 90" fill="none" aria-hidden="true">
          <defs>
            <linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#34d399" stop-opacity="0.85" />
              <stop offset="100%" stop-color="#064e3b" stop-opacity="0.1" />
            </linearGradient>
          </defs>
          <rect x="14" y="54" width="16" height="30" rx="3" fill="url(#barGrad)" />
          <rect x="38" y="42" width="16" height="42" rx="3" fill="url(#barGrad)" />
          <rect x="62" y="28" width="16" height="56" rx="3" fill="url(#barGrad)" />
          <rect x="86" y="14" width="16" height="70" rx="3" fill="url(#barGrad)" />
          <path d="M14 58 C 36 48, 60 32, 94 12" stroke="#4ade80" stroke-width="2" stroke-linecap="round" />
          <circle cx="94" cy="12" r="4" fill="#fde047" />
          <circle cx="94" cy="12" r="9" fill="#fde047" fill-opacity="0.22" />
        </svg>
      </header>

      <section class="section-block">
        <div class="section-header">
          <div>
            <div class="eyebrow">MY CASH FLOW</div>
            <h2 class="section-title">下一筆預估入帳</h2>
            <p class="section-desc">依持有日期自動排除不符合除息資格的期別</p>
          </div>
        </div>
        ${nextCardHtml}
      </section>

      <section class="section-block">
        <div class="section-header">
          <div>
            <div class="eyebrow">THIS MONTH</div>
            <h2 class="section-title">本月入帳明細</h2>
          </div>
          <button class="link-btn" id="btn-view-month-detail" type="button">查看完整明細 &rsaquo;</button>
        </div>
        <div class="card">
          <div class="monthly-card-top">
            <div class="monthly-card-title-group">
              <div class="icon-badge">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="18" y1="20" x2="18" y2="10"></line>
                  <line x1="12" y1="20" x2="12" y2="4"></line>
                  <line x1="6" y1="20" x2="6" y2="14"></line>
                </svg>
              </div>
              <div>
                <div class="eyebrow" style="margin-bottom:2px;">MONTHLY CASH FLOW</div>
                <div class="card-row-title" style="margin-bottom:0;">${currentMonth} 月預估入帳</div>
              </div>
            </div>
            <span class="pill-badge">${monthPayouts.length} 筆</span>
          </div>

          <div class="amount-label">本月預估入帳</div>
          <div class="amount-hero">${formatNT(monthTotal)}</div>

          <div class="stats-grid-3">
            <div class="stat-box">
              <div class="stat-box-label">已到發放日</div>
              <div class="stat-box-value emerald">${formatNT(monthPaid)}</div>
            </div>
            <div class="stat-box">
              <div class="stat-box-label">入帳筆數</div>
              <div class="stat-box-value">${monthPayouts.length} 筆</div>
            </div>
            <div class="stat-box">
              <div class="stat-box-label">待發放</div>
              <div class="stat-box-value">${formatNT(monthPending)}</div>
            </div>
          </div>

          <div class="payout-list">
            ${monthItemsHtml}
          </div>

          <p class="disclaimer-text">依持有數量、起始日與官方已公告資料估算，實際入帳以券商為準。</p>
        </div>
      </section>

      <section class="section-block">
        <div class="section-header">
          <div>
            <div class="eyebrow">YEAR AT A GLANCE</div>
            <h2 class="section-title">我的年度入帳</h2>
          </div>
          <button class="link-btn" id="btn-view-annual-detail" type="button">查看詳情 &rsaquo;</button>
        </div>
        <div class="card card-interactive" id="annual-card">
          <div class="row-between">
            <div class="monthly-card-title-group">
              <div class="icon-badge">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <ellipse cx="12" cy="5" rx="9" ry="3"></ellipse>
                  <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path>
                  <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path>
                </svg>
              </div>
              <div>
                <div class="eyebrow" style="margin-bottom:2px;">ANNUAL CASH FLOW</div>
                <div class="card-row-title" style="margin-bottom:0;">${currentYear} 已公告配息</div>
              </div>
            </div>
            <div class="payout-amount">${formatNT(yearTotal)}</div>
          </div>
          <div class="annual-chart">${barsHtml}</div>
        </div>
      </section>
    `;
  }

  function renderCalendar() {
    const holdingsCodes = new Set(getCurrentHoldings().map((h) => h.code));
    const events = [];

    for (const etf of window.ETF_CATALOG) {
      if (state.calendarFilter === 'holdings' && !holdingsCodes.has(etf.code)) {
        continue;
      }
      for (const div of etf.dividends) {
        const eligibleShares = getEligibleShares(etf.code, div.exDate);
        const hasHolding = holdingsCodes.has(etf.code);
        events.push({
          code: etf.code,
          name: etf.name,
          frequency: etf.frequency,
          exDate: div.exDate,
          payDate: div.payDate,
          amount: div.amount,
          eligibleShares,
          hasHolding,
          estPayout: Math.round(eligibleShares * div.amount)
        });
      }
    }

    events.sort((a, b) => a.exDate.localeCompare(b.exDate));

    const itemsHtml =
      events.length > 0
        ? events
            .map((ev) => {
              let tagHtml = '<span class="tag tag-neutral">未持有</span>';
              if (ev.eligibleShares > 0) {
                tagHtml = `<span class="tag tag-eligible">符合資格 · ${formatNT(ev.estPayout)}</span>`;
              } else if (ev.hasHolding) {
                tagHtml = '<span class="tag tag-ineligible">除息日後買入</span>';
              }
              return `
              <div class="card" style="padding: 14px 16px;">
                <div class="row-between" style="margin-bottom: 8px;">
                  <div>
                    <span class="payout-code">${ev.code}</span>
                    <span class="payout-meta" style="margin-left: 6px;">${ev.name}</span>
                  </div>
                  ${tagHtml}
                </div>
                <div class="row-between" style="font-size: 12.5px; color: var(--text-secondary);">
                  <span>除息日：<strong style="color:#fff;">${ev.exDate}</strong></span>
                  <span>發放日：<strong style="color:#fff;">${ev.payDate}</strong></span>
                  <span>每股 <strong style="color:var(--accent-mint);">${ev.amount.toFixed(2)}</strong> 元</span>
                </div>
              </div>`;
            })
            .join('')
        : `<div class="card"><div class="card-row-sub">尚無符合條件的除息排程，請先至「自選」新增買入紀錄。</div></div>`;

    return `
      <header class="section-header" style="margin-bottom: 14px;">
        <div>
          <div class="eyebrow">DIVIDEND CALENDAR</div>
          <h1 class="hero-title" style="font-size: 24px; margin-bottom: 4px;">除息與發放行事曆</h1>
          <p class="section-desc">自動比對買入日期與各期除息日</p>
        </div>
      </header>

      <div class="chip-row">
        <button class="chip ${state.calendarFilter === 'all' ? 'active' : ''}" data-cal-filter="all" type="button">全部熱門 ETF</button>
        <button class="chip ${state.calendarFilter === 'holdings' ? 'active' : ''}" data-cal-filter="holdings" type="button">只看我的持股</button>
      </div>

      <div class="stack-sm">
        ${itemsHtml}
      </div>
    `;
  }

  function renderWatchlist() {
    const holdings = getCurrentHoldings();
    const totalMarketVal = holdings.reduce((s, h) => s + h.marketValue, 0);
    const totalAnnualDiv = holdings.reduce((s, h) => s + h.estAnnualDiv, 0);
    const avgYield = totalMarketVal > 0 ? (totalAnnualDiv / totalMarketVal) * 100 : 0;

    const holdingsHtml =
      holdings.length > 0
        ? holdings
            .map((h) => {
              const yld = h.etf ? (h.etf.annualDividendPerShare / h.etf.price) * 100 : 0;
              return `
              <div class="card" style="padding: 15px 16px;">
                <div class="row-between" style="margin-bottom: 8px;">
                  <div>
                    <div class="payout-code">${h.code} ${h.etf ? h.etf.name : ''}</div>
                    <div class="payout-meta">${h.shares.toLocaleString()} 股 · 均價 ${h.avgCost.toFixed(2)}</div>
                  </div>
                  <div style="text-align:right;">
                    <div class="payout-amount">${formatNT(h.marketValue)}</div>
                    <div class="payout-meta">年化殖利率 ${yld.toFixed(2)}%</div>
                  </div>
                </div>
                <div class="row-between" style="font-size: 12px; color: var(--text-secondary);">
                  <span>預估年領股息：<strong style="color: var(--accent-mint);">${formatNT(h.estAnnualDiv)}</strong></span>
                  <span>${h.etf ? h.etf.frequency : ''}</span>
                </div>
              </div>`;
            })
            .join('')
        : `<div class="card"><div class="card-row-sub">目前沒有持股，點擊下方「新增買賣紀錄」開始建立你的現金流組合。</div></div>`;

    const sortedTx = [...state.transactions].sort((a, b) => b.date.localeCompare(a.date));
    const txHtml =
      sortedTx.length > 0
        ? sortedTx
            .map((tx) => {
              const etf = getETF(tx.code);
              const isBuy = tx.type === 'buy';
              return `
              <div class="payout-row" style="cursor:default;">
                <div class="payout-left">
                  <span class="dot ${isBuy ? '' : 'pending'}"></span>
                  <div>
                    <div class="payout-code">${tx.code} ${etf ? etf.name : ''} <span class="tag ${isBuy ? 'tag-eligible' : 'tag-ineligible'}" style="margin-left:4px;">${isBuy ? '買入' : '賣出'}</span></div>
                    <div class="payout-meta">${tx.date} · ${Number(tx.shares).toLocaleString()} 股 @ ${Number(tx.price).toFixed(2)}</div>
                  </div>
                </div>
                <button class="btn btn-danger btn-sm" data-delete-tx="${tx.id}" type="button">刪除</button>
              </div>`;
            })
            .join('')
        : `<div class="card-row-sub">尚無買賣紀錄。</div>`;

    return `
      <header class="section-header" style="margin-bottom: 14px;">
        <div>
          <div class="eyebrow">MY PORTFOLIO</div>
          <h1 class="hero-title" style="font-size: 24px; margin-bottom: 4px;">自選與買賣紀錄</h1>
          <p class="section-desc">新增或刪除交易後，配息資格會即時重算</p>
        </div>
        <button class="btn btn-primary btn-sm" id="btn-open-add-tx" type="button">+ 新增交易</button>
      </header>

      <div class="card" style="margin-bottom: 18px;">
        <div class="stats-grid-3" style="margin-bottom: 0;">
          <div class="stat-box">
            <div class="stat-box-label">目前總市值</div>
            <div class="stat-box-value">${formatNT(totalMarketVal)}</div>
          </div>
          <div class="stat-box">
            <div class="stat-box-label">預估年配息</div>
            <div class="stat-box-value emerald">${formatNT(totalAnnualDiv)}</div>
          </div>
          <div class="stat-box">
            <div class="stat-box-label">預估殖利率</div>
            <div class="stat-box-value">${avgYield.toFixed(2)}%</div>
          </div>
        </div>
      </div>

      <section class="section-block">
        <div class="section-header">
          <h2 class="section-title">目前持股</h2>
        </div>
        <div class="stack-sm">
          ${holdingsHtml}
        </div>
      </section>

      <section class="section-block">
        <div class="section-header">
          <h2 class="section-title">買賣紀錄管理</h2>
        </div>
        <div class="card">
          <div class="payout-list">
            ${txHtml}
          </div>
        </div>
      </section>
    `;
  }

  function renderRanking() {
    const list = [...window.ETF_CATALOG].map((etf) => ({
      ...etf,
      yieldPct: (etf.annualDividendPerShare / etf.price) * 100
    }));

    if (state.rankingSort === 'yield') {
      list.sort((a, b) => b.yieldPct - a.yieldPct);
    } else if (state.rankingSort === 'amount') {
      list.sort((a, b) => b.annualDividendPerShare - a.annualDividendPerShare);
    } else {
      list.sort((a, b) => b.payoutMonths.length - a.payoutMonths.length);
    }

    const itemsHtml = list
      .map(
        (etf, idx) => `
      <div class="card" style="padding: 15px 16px;">
        <div class="row-between" style="margin-bottom: 8px;">
          <div class="payout-left">
            <span class="pill-badge ${idx < 3 ? 'pill-gold' : ''}" style="padding: 4px 10px;">#${idx + 1}</span>
            <div>
              <div class="payout-code">${etf.code} ${etf.name}</div>
              <div class="payout-meta">參考股價 ${etf.price.toFixed(2)} · ${etf.frequency}</div>
            </div>
          </div>
          <div style="text-align:right;">
            <div class="payout-amount">${etf.yieldPct.toFixed(2)}%</div>
            <div class="payout-meta">年配 ${etf.annualDividendPerShare.toFixed(2)} 元</div>
          </div>
        </div>
        <div class="row-between">
          <span class="payout-meta">領息月：${etf.payoutMonths.join('、')} 月</span>
          <button class="btn btn-secondary btn-sm" data-quick-buy="${etf.code}" type="button">+ 加入持股</button>
        </div>
      </div>`
      )
      .join('');

    return `
      <header class="section-header" style="margin-bottom: 14px;">
        <div>
          <div class="eyebrow">MARKET RANKING</div>
          <h1 class="hero-title" style="font-size: 24px; margin-bottom: 4px;">熱門台股 ETF 排行</h1>
          <p class="section-desc">依殖利率、配息頻率與年度配息比較</p>
        </div>
      </header>

      <div class="chip-row">
        <button class="chip ${state.rankingSort === 'yield' ? 'active' : ''}" data-rank-sort="yield" type="button">年化殖利率</button>
        <button class="chip ${state.rankingSort === 'freq' ? 'active' : ''}" data-rank-sort="freq" type="button">配息頻率</button>
        <button class="chip ${state.rankingSort === 'amount' ? 'active' : ''}" data-rank-sort="amount" type="button">年配金額</button>
      </div>

      <div class="stack-sm">
        ${itemsHtml}
      </div>
    `;
  }

  function renderSettings() {
    return `
      <header class="section-header" style="margin-bottom: 16px;">
        <div>
          <div class="eyebrow">PREFERENCES & DATA</div>
          <h1 class="hero-title" style="font-size: 24px; margin-bottom: 4px;">設定與資料備份</h1>
          <p class="section-desc">所有交易紀錄皆安全儲存在本機瀏覽器中</p>
        </div>
      </header>

      <div class="stack-sm">
        <div class="card">
          <div class="card-row-title">備份與還原交易紀錄 (JSON)</div>
          <p class="card-row-sub" style="margin-bottom: 14px;">更換手機或電腦時，可匯出 JSON 檔案或直接匯入。</p>
          <div class="form-grid-2">
            <button class="btn btn-primary" id="btn-export-json" type="button">匯出備份</button>
            <label class="btn btn-secondary" style="cursor:pointer;">
              匯入還原
              <input type="file" id="input-import-json" accept="application/json" hidden />
            </label>
          </div>
        </div>

        <div class="card">
          <div class="card-row-title">資料重置</div>
          <p class="card-row-sub" style="margin-bottom: 14px;">目前共有 ${state.transactions.length} 筆買賣紀錄。</p>
          <div class="form-grid-2">
            <button class="btn btn-secondary" id="btn-reset-demo" type="button">恢復範例資料</button>
            <button class="btn btn-danger" id="btn-clear-all" type="button">清空所有紀錄</button>
          </div>
        </div>

        <div class="card">
          <div class="card-row-title">關於 ETF配息通</div>
          <p class="card-row-sub" style="margin-top: 6px;">
            目前版本使用內建台股 ETF 示範資料與本機儲存（無需 Firebase 或登入）。後續可串接 Vercel Serverless API 自動抓取最新 TWSE 除息公告與收盤價，或連結 Google Sheets 同步持股。
          </p>
        </div>
      </div>
    `;
  }

  /* ======================== MODALS ======================== */

  function openModal(html) {
    const overlay = document.getElementById('modal-overlay');
    const sheet = document.getElementById('modal-sheet');
    sheet.innerHTML = html;
    overlay.classList.remove('hidden');
  }

  function closeModal() {
    document.getElementById('modal-overlay').classList.add('hidden');
  }

  function showToast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => el.classList.add('hidden'), 2400);
  }

  function openAddTradeModal(presetCode = '0056') {
    const optionsHtml = window.ETF_CATALOG.map(
      (e) => `<option value="${e.code}" ${e.code === presetCode ? 'selected' : ''}>${e.code} ${e.name}</option>`
    ).join('');

    const defaultEtf = getETF(presetCode) || window.ETF_CATALOG[0];

    openModal(`
      <div class="modal-header">
        <h3 class="section-title">新增買賣紀錄</h3>
        <button class="modal-close" id="btn-close-modal" type="button">&times;</button>
      </div>
      <form id="form-add-trade">
        <div class="form-group">
          <label class="form-label" for="tx-code">ETF 代號</label>
          <select class="form-select" id="tx-code" required>${optionsHtml}</select>
        </div>
        <div class="form-grid-2">
          <div class="form-group">
            <label class="form-label" for="tx-type">交易類型</label>
            <select class="form-select" id="tx-type">
              <option value="buy">買入</option>
              <option value="sell">賣出</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label" for="tx-date">交易日期</label>
            <input class="form-input" id="tx-date" type="date" value="${TODAY_STR}" required />
          </div>
        </div>
        <div class="form-grid-2">
          <div class="form-group">
            <label class="form-label" for="tx-shares">股數（1張 = 1000股）</label>
            <input class="form-input" id="tx-shares" type="number" min="1" step="1" value="1000" required />
          </div>
          <div class="form-group">
            <label class="form-label" for="tx-price">成交單價</label>
            <input class="form-input" id="tx-price" type="number" min="0.01" step="0.01" value="${defaultEtf.price}" required />
          </div>
        </div>
        <button class="btn btn-primary btn-full" type="submit" style="margin-top: 6px;">儲存紀錄並重算配息</button>
      </form>
    `);

    document.getElementById('tx-code').addEventListener('change', (e) => {
      const etf = getETF(e.target.value);
      if (etf) {
        document.getElementById('tx-price').value = etf.price;
      }
    });

    document.getElementById('form-add-trade').addEventListener('submit', (e) => {
      e.preventDefault();
      const newTx = {
        id: 'tx-' + Date.now(),
        code: document.getElementById('tx-code').value,
        type: document.getElementById('tx-type').value,
        date: document.getElementById('tx-date').value,
        shares: Number(document.getElementById('tx-shares').value),
        price: Number(document.getElementById('tx-price').value)
      };
      state.transactions.push(newTx);
      saveTransactions();
      closeModal();
      render();
      showToast(`已新增 ${newTx.code} 交易紀錄`);
    });
  }

  function openPayoutDetailModal(code, payDate) {
    const allPayouts = getEligiblePayouts();
    const item = allPayouts.find((p) => p.code === code && p.payDate === payDate);
    if (!item) return;

    openModal(`
      <div class="modal-header">
        <h3 class="section-title">${item.code} ${item.name}</h3>
        <button class="modal-close" id="btn-close-modal" type="button">&times;</button>
      </div>
      <div class="card" style="margin-bottom: 12px;">
        <div class="amount-label">預估入帳金額</div>
        <div class="amount-hero" style="margin-bottom: 10px;">${formatNT(item.totalAmount)}</div>
        <div class="divider"></div>
        <div class="stack-sm" style="font-size: 13.5px;">
          <div class="row-between"><span style="color:var(--text-secondary);">狀態</span><span class="tag ${item.isPaid ? 'tag-eligible' : 'tag-neutral'}">${item.isPaid ? '已到發放日' : '待發放'}</span></div>
          <div class="row-between"><span style="color:var(--text-secondary);">除息日</span><strong>${item.exDate}</strong></div>
          <div class="row-between"><span style="color:var(--text-secondary);">發放日</span><strong>${item.payDate}</strong></div>
          <div class="row-between"><span style="color:var(--text-secondary);">除息前持有股數</span><strong>${item.shares.toLocaleString()} 股</strong></div>
          <div class="row-between"><span style="color:var(--text-secondary);">每股配息</span><strong>${item.perShare.toFixed(2)} 元</strong></div>
        </div>
      </div>
      <button class="btn btn-secondary btn-full" id="btn-close-modal-2" type="button">關閉</button>
    `);
  }

  function openListModal(title, payouts) {
    const rows =
      payouts.length > 0
        ? payouts
            .map(
              (p) => `
          <div class="payout-row" style="cursor:default;">
            <div class="payout-left">
              <span class="dot ${p.isPaid ? '' : 'pending'}"></span>
              <div>
                <div class="payout-code">${p.code} ${p.name}</div>
                <div class="payout-meta">除息 ${p.exDate} · 發放 ${p.payDate} · ${p.shares.toLocaleString()} 股</div>
              </div>
            </div>
            <div class="payout-amount">${formatNT(p.totalAmount)}</div>
          </div>`
            )
            .join('')
        : '<div class="card-row-sub">此區間尚無符合除息資格的配息紀錄。</div>';

    openModal(`
      <div class="modal-header">
        <h3 class="section-title">${title}</h3>
        <button class="modal-close" id="btn-close-modal" type="button">&times;</button>
      </div>
      <div class="payout-list">${rows}</div>
    `);
  }

  /* ======================== EVENT WIRING ======================== */

  function render() {
    const main = document.getElementById('main-content');
    if (state.activeTab === 'dashboard') main.innerHTML = renderDashboard();
    else if (state.activeTab === 'calendar') main.innerHTML = renderCalendar();
    else if (state.activeTab === 'watchlist') main.innerHTML = renderWatchlist();
    else if (state.activeTab === 'ranking') main.innerHTML = renderRanking();
    else if (state.activeTab === 'settings') main.innerHTML = renderSettings();

    document.querySelectorAll('.nav-item').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === state.activeTab);
    });

    bindDynamicEvents();
  }

  function bindDynamicEvents() {
    const goWatch = document.getElementById('go-watchlist-card');
    if (goWatch) {
      goWatch.addEventListener('click', () => {
        state.activeTab = 'watchlist';
        render();
      });
    }

    const nextCard = document.getElementById('next-payout-card');
    if (nextCard) {
      nextCard.addEventListener('click', () => {
        openPayoutDetailModal(nextCard.dataset.code, nextCard.dataset.paydate);
      });
    }

    const addShortcut = document.getElementById('add-trade-shortcut');
    if (addShortcut) {
      addShortcut.addEventListener('click', () => openAddTradeModal('0056'));
    }

    document.querySelectorAll('[data-payout-detail]').forEach((el) => {
      el.addEventListener('click', () => {
        const [code, payDate] = el.dataset.payoutDetail.split('|');
        openPayoutDetailModal(code, payDate);
      });
    });

    const btnMonthDetail = document.getElementById('btn-view-month-detail');
    if (btnMonthDetail) {
      btnMonthDetail.addEventListener('click', () => {
        const y = parseInt(TODAY_STR.slice(0, 4), 10);
        const m = parseInt(TODAY_STR.slice(5, 7), 10);
        const items = getEligiblePayouts().filter((p) => p.payYear === y && p.payMonth === m);
        openListModal(`${m} 月完整入帳明細`, items);
      });
    }

    const btnAnnual = document.getElementById('btn-view-annual-detail');
    const annualCard = document.getElementById('annual-card');
    const openAnnual = () => {
      const y = parseInt(TODAY_STR.slice(0, 4), 10);
      const items = getEligiblePayouts().filter((p) => p.payYear === y);
      openListModal(`${y} 年度配息入帳明細`, items);
    };
    if (btnAnnual) btnAnnual.addEventListener('click', openAnnual);
    if (annualCard) annualCard.addEventListener('click', openAnnual);

    // Calendar filters
    document.querySelectorAll('[data-cal-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.calendarFilter = btn.dataset.calFilter;
        render();
      });
    });

    // Watchlist add / delete
    const btnAddTx = document.getElementById('btn-open-add-tx');
    if (btnAddTx) {
      btnAddTx.addEventListener('click', () => openAddTradeModal('0056'));
    }

    document.querySelectorAll('[data-delete-tx]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.deleteTx;
        state.transactions = state.transactions.filter((t) => t.id !== id);
        saveTransactions();
        render();
        showToast('已刪除交易紀錄');
      });
    });

    // Ranking sort & quick buy
    document.querySelectorAll('[data-rank-sort]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.rankingSort = btn.dataset.rankSort;
        render();
      });
    });

    document.querySelectorAll('[data-quick-buy]').forEach((btn) => {
      btn.addEventListener('click', () => openAddTradeModal(btn.dataset.quickBuy));
    });

    // Settings export/import/reset
    const btnExport = document.getElementById('btn-export-json');
    if (btnExport) {
      btnExport.addEventListener('click', () => {
        const blob = new Blob([JSON.stringify(state.transactions, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `etf-stock-backup-${TODAY_STR}.json`;
        a.click();
        URL.revokeObjectURL(url);
        showToast('已匯出交易備份檔');
      });
    }

    const inputImport = document.getElementById('input-import-json');
    if (inputImport) {
      inputImport.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const parsed = JSON.parse(reader.result);
            if (!Array.isArray(parsed)) throw new Error('invalid');
            state.transactions = parsed;
            saveTransactions();
            render();
            showToast('已成功匯入紀錄');
          } catch (_) {
            showToast('檔案格式不正確');
          }
        };
        reader.readAsText(file);
      });
    }

    const btnResetDemo = document.getElementById('btn-reset-demo');
    if (btnResetDemo) {
      btnResetDemo.addEventListener('click', () => {
        state.transactions = JSON.parse(JSON.stringify(window.DEFAULT_TRANSACTIONS));
        saveTransactions();
        render();
        showToast('已恢復範例資料');
      });
    }

    const btnClearAll = document.getElementById('btn-clear-all');
    if (btnClearAll) {
      btnClearAll.addEventListener('click', () => {
        state.transactions = [];
        saveTransactions();
        render();
        showToast('已清空所有交易紀錄');
      });
    }
  }

  // Bottom nav clicks
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.activeTab = btn.dataset.tab;
      window.scrollTo({ top: 0, behavior: 'smooth' });
      render();
    });
  });

  // Modal close delegation
  document.getElementById('modal-overlay').addEventListener('click', (e) => {
    if (
      e.target.id === 'modal-overlay' ||
      e.target.id === 'btn-close-modal' ||
      e.target.id === 'btn-close-modal-2'
    ) {
      closeModal();
    }
  });

  render();
})();
