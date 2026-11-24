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
    transactions: loadTransactions(),
    quoteStatus: 'idle',   // 'idle' | 'loading' | 'live' | 'offline'
    quoteUpdatedAt: null,
    detailCode: null,
    historyPage: 1,
    showMonthDetail: false,
    selectedYear: parseInt(TODAY_STR.slice(0, 4), 10),
    selectedMonth: parseInt(TODAY_STR.slice(5, 7), 10),
    user: null,
    cloudSynced: false
  };

  async function fetchLiveQuotes(manual = false) {
    if (state.quoteStatus === 'loading') return;
    state.quoteStatus = 'loading';
    if (manual) render();

    const codes = window.ETF_CATALOG.map((e) => e.code).join(',');
    let gotAnyLive = false;

    const [quoteRes, divRes] = await Promise.allSettled([
      fetch(`./api/etf?codes=${encodeURIComponent(codes)}`, {
        signal: AbortSignal.timeout(6500)
      }),
      fetch(`./api/dividends?codes=${encodeURIComponent(codes)}`, {
        signal: AbortSignal.timeout(8000)
      })
    ]);

    try {
      if (quoteRes.status === 'fulfilled' && quoteRes.value.ok) {
        const data = await quoteRes.value.json();
        if (data && data.quotes && Object.keys(data.quotes).length > 0) {
          for (const etf of window.ETF_CATALOG) {
            const q = data.quotes[etf.code];
            if (q && Number.isFinite(q.price) && q.price > 0) {
              etf.price = q.price;
              etf.changePct = q.changePct;
              etf.quoteSource = q.source;
            }
          }
          gotAnyLive = true;
          state.quoteUpdatedAt = data.updatedAt || new Date().toISOString();
        }
      }
    } catch (_) {
      // ignore quote parse error
    }

    try {
      if (divRes.status === 'fulfilled' && divRes.value.ok) {
        const divData = await divRes.value.json();
        if (divData && divData.dividendsByCode && Object.keys(divData.dividendsByCode).length > 0) {
          for (const etf of window.ETF_CATALOG) {
            const dInfo = divData.dividendsByCode[etf.code];
            if (dInfo && Array.isArray(dInfo.dividends) && dInfo.dividends.length > 0) {
              etf.dividends = dInfo.dividends;
              if (Number.isFinite(dInfo.annualDividendPerShare) && dInfo.annualDividendPerShare > 0) {
                etf.annualDividendPerShare = dInfo.annualDividendPerShare;
              }
              if (Array.isArray(dInfo.payoutMonths) && dInfo.payoutMonths.length > 0) {
                etf.payoutMonths = dInfo.payoutMonths;
              }
              etf.dividendSource = 'live';
            }
          }
          gotAnyLive = true;
        }
      }
    } catch (_) {
      // ignore dividend parse error
    }

    if (gotAnyLive) {
      state.quoteStatus = 'live';
      if (manual) showToast('已更新最新股價與真實配息紀錄');
    } else {
      state.quoteStatus = 'offline';
      if (manual) showToast('目前為離線參考資料（部署於 Vercel 後可即時更新）');
    }
    render();
  }

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
            isPaid,
            isEstimatedPayDate: Boolean(div.isEstimatedPayDate)
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
          <div style="margin-top: 10px; display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
            <span class="tag ${state.quoteStatus === 'live' ? 'tag-eligible' : 'tag-neutral'}">
              ${
                state.quoteStatus === 'live'
                  ? '即時報價已連線'
                  : state.quoteStatus === 'loading'
                    ? '更新報價中...'
                    : '離線參考價'
              }
            </span>
            <button class="link-btn" id="btn-refresh-quotes" type="button" style="font-size:12px;">↻ 更新股價</button>
            <button class="tag ${state.user ? 'tag-eligible' : 'tag-neutral'}" id="btn-hero-cloud" type="button" style="border:none; cursor:pointer; font-family:inherit;">
              ${state.user ? '☁ 雲端同步中' : '☁ 登入同步'}
            </button>
          </div>
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
          isEstimatedPayDate: Boolean(div.isEstimatedPayDate),
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
                  <span>發放日：<strong style="color:#fff;">${ev.payDate}${ev.isEstimatedPayDate ? ' (預估)' : ''}</strong></span>
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
              <div class="card card-interactive" data-open-etf="${h.code}" style="padding: 15px 16px;">
                <div class="row-between" style="margin-bottom: 8px;">
                  <div>
                    <div class="payout-code">${h.code} ${h.etf ? h.etf.name : ''}</div>
                    <div class="payout-meta">${h.shares.toLocaleString()} 股 · 均價 ${h.avgCost.toFixed(2)}</div>
                  </div>
                  <div style="text-align:right;">
                    <div class="payout-amount">${formatNT(h.marketValue)} <span class="chevron">&rsaquo;</span></div>
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
    const cloudCardHtml = state.user
      ? `
        <div class="card">
          <div class="row-between" style="margin-bottom: 8px;">
            <div class="card-row-title" style="margin-bottom:0;">雲端跨裝置同步</div>
            <span class="tag tag-eligible">即時同步中</span>
          </div>
          <p class="card-row-sub" style="margin-bottom: 14px;">
            已登入：<strong style="color:#fff;">${state.user.email || state.user.displayName || 'Google 帳號'}</strong><br/>
            你的買賣紀錄會自動同步至所有登入同一帳號的手機與電腦。
          </p>
          <div class="form-grid-2">
            <button class="btn btn-secondary" id="btn-upload-local-to-cloud" type="button">上傳本機紀錄</button>
            <button class="btn btn-danger" id="btn-google-signout" type="button">登出帳號</button>
          </div>
        </div>`
      : `
        <div class="card">
          <div class="row-between" style="margin-bottom: 8px;">
            <div class="card-row-title" style="margin-bottom:0;">雲端跨裝置同步</div>
            <span class="tag tag-neutral">未登入</span>
          </div>
          <p class="card-row-sub" style="margin-bottom: 14px;">
            登入 Google 帳號後，手機與電腦看到的持股與買賣紀錄將自動即時同步（只有你能讀寫自己的資料）。
          </p>
          ${state.authError ? `<p class="card-row-sub" style="color: var(--accent-danger); margin-bottom: 12px;">${state.authError}</p>` : ''}
          <button class="btn btn-primary btn-full" id="btn-google-signin" type="button">使用 Google 帳號登入並同步</button>
        </div>`;

    return `
      <header class="section-header" style="margin-bottom: 16px;">
        <div>
          <div class="eyebrow">PREFERENCES & DATA</div>
          <h1 class="hero-title" style="font-size: 24px; margin-bottom: 4px;">設定與資料備份</h1>
          <p class="section-desc">${state.user ? '目前使用 Firebase Firestore 雲端同步' : '目前僅儲存在本機瀏覽器中'}</p>
        </div>
      </header>

      <div class="stack-sm">
        ${cloudCardHtml}
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

  function renderEtfDetail(code) {
    const etf = getETF(code);
    if (!etf) return '<div class="card">找不到此 ETF 資料。</div>';

    const yld = etf.price > 0 ? (etf.annualDividendPerShare / etf.price) * 100 : 0;
    const sortedDivs = [...etf.dividends].sort((a, b) => b.exDate.localeCompare(a.exDate));

    // 近 12 個月配息摘要（從今天往前 365 天內的實際配息）
    const oneYearAgoDate = new Date();
    oneYearAgoDate.setFullYear(oneYearAgoDate.getFullYear() - 1);
    const oneYearAgoStr = oneYearAgoDate.toISOString().slice(0, 10);
    const recent12m = sortedDivs.filter((d) => d.exDate >= oneYearAgoStr && d.exDate <= TODAY_STR);
    const sum12m = recent12m.reduce((s, d) => s + d.amount, 0);

    // 分頁設定（每頁 6 筆）
    const pageSize = 6;
    const totalCount = sortedDivs.length;
    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
    const currentPage = Math.min(Math.max(1, state.historyPage), totalPages);
    const startIdx = (currentPage - 1) * pageSize;
    const pageItems = sortedDivs.slice(startIdx, startIdx + pageSize);

    const historyRowsHtml = pageItems
      .map((d) => {
        const rocYear = parseInt(d.exDate.slice(0, 4), 10) - 1911;
        const exFormatted = d.exDate.replace(/-/g, '/');
        const payFormatted = d.payDate.replace(/-/g, '/') + (d.isEstimatedPayDate ? ' (預估)' : '');
        const amtText = Number.isInteger(d.amount * 100) ? d.amount.toFixed(2) : d.amount.toFixed(3);
        return `
        <div class="history-item">
          <div class="history-item-top">
            <div>
              <div class="history-amount">NT$ ${amtText}</div>
              <div class="history-sub">每單位配息</div>
            </div>
            <span class="history-roc-year">${rocYear} 年度</span>
          </div>
          <div class="history-dates-grid">
            <div>
              <div class="history-date-label"><span class="dot-gold"></span> 除息日</div>
              <div class="history-date-value">${exFormatted}</div>
            </div>
            <div>
              <div class="history-date-label"><span class="dot-green"></span> 發放日</div>
              <div class="history-date-value">${payFormatted}</div>
            </div>
          </div>
        </div>`;
      })
      .join('');

    return `
      <div class="detail-topbar">
        <button class="detail-back-btn" id="btn-detail-back" type="button">&lsaquo; 返回</button>
        <button class="btn btn-primary btn-sm" data-quick-buy="${etf.code}" type="button">+ 新增交易</button>
      </div>

      <header style="margin-bottom: 16px;">
        <div class="eyebrow eyebrow-gold">${etf.code} · ${etf.frequency}</div>
        <h1 class="hero-title" style="font-size: 26px; margin-bottom: 6px;">${etf.code} ${etf.name}</h1>
        <p class="section-desc">目前參考價 <strong style="color:#fff;">NT$${etf.price.toFixed(2)}</strong> · 預估年化殖利率 <strong style="color:var(--accent-mint);">${yld.toFixed(2)}%</strong></p>
      </header>

      <div class="card" style="margin-bottom: 22px;">
        <div class="detail-info-grid">
          <div>
            <div class="detail-info-label">投資範圍</div>
            <div class="detail-info-value">${etf.scope || '台灣成分'}</div>
          </div>
          <div>
            <div class="detail-info-label">發行單位數</div>
            <div class="detail-info-value">${etf.units || '—'}</div>
          </div>
        </div>
      </div>

      <section class="section-block">
        <div class="section-header">
          <div>
            <div class="eyebrow">12-MONTH SUMMARY</div>
            <h2 class="section-title">近 12 個月配息摘要</h2>
          </div>
        </div>
        <div class="card">
          <div class="stats-grid-3">
            <div class="stat-box">
              <div class="stat-box-label">每單位合計</div>
              <div class="stat-box-value">NT$ ${sum12m.toFixed(3).replace(/0$/, '')}</div>
            </div>
            <div class="stat-box">
              <div class="stat-box-label">配息次數</div>
              <div class="stat-box-value">${recent12m.length} 次</div>
            </div>
            <div class="stat-box">
              <div class="stat-box-label">官方頻率</div>
              <div class="stat-box-value">${etf.frequency}</div>
            </div>
          </div>
          <p class="disclaimer-text" style="margin-top: 2px;">
            金額與次數依近 12 個月公告彙整。頻率另依官方政策；待確認不代表不配息，月配也不保證每月配發。
          </p>
          <p class="disclaimer-text" style="margin-top: 8px; color: var(--text-secondary);">
            頻率核對日：${etf.freqCheckedDate || '2026-09-23'}
          </p>
        </div>
      </section>

      <section class="section-block">
        <div class="section-header">
          <div>
            <div class="eyebrow">DIVIDEND HISTORY</div>
            <h2 class="section-title">歷史配息紀錄</h2>
          </div>
          <span class="payout-meta">${totalCount} 筆</span>
        </div>

        <div class="card history-list-card">
          ${historyRowsHtml}
        </div>

        <div class="pagination-bar">
          <button class="page-btn" id="btn-hist-prev" type="button" ${currentPage <= 1 ? 'disabled' : ''}>&lsaquo; 上一頁</button>
          <span class="page-indicator">${currentPage} / ${totalPages}</span>
          <button class="page-btn" id="btn-hist-next" type="button" ${currentPage >= totalPages ? 'disabled' : ''}>下一頁 &rsaquo;</button>
        </div>
      </section>
    `;
  }

  function renderMonthDetail() {
    const y = state.selectedYear;
    const m = state.selectedMonth;
    const allPayouts = getEligiblePayouts();
    const monthPayouts = allPayouts.filter((p) => p.payYear === y && p.payMonth === m);

    const monthTotal = monthPayouts.reduce((s, p) => s + p.totalAmount, 0);
    const monthPaid = monthPayouts
      .filter((p) => p.isPaid)
      .reduce((s, p) => s + p.totalAmount, 0);
    const monthPending = monthTotal - monthPaid;

    const listHtml =
      monthPayouts.length > 0
        ? monthPayouts
            .map((p) => {
              const exFormatted = p.exDate.replace(/-/g, '/');
              const payFormatted = p.payDate.replace(/-/g, '/') + (p.isEstimatedPayDate ? ' (預估)' : '');
              return `
              <div class="history-item card-interactive" data-open-etf="${p.code}">
                <div class="history-item-top">
                  <div>
                    <div class="payout-code">${p.code} ${p.name}</div>
                    <div class="history-sub">${p.shares.toLocaleString()} 股 × ${p.perShare.toFixed(2)} 元</div>
                  </div>
                  <div style="text-align:right;">
                    <div class="history-amount">${formatNT(p.totalAmount)}</div>
                    <span class="tag ${p.isPaid ? 'tag-eligible' : 'tag-neutral'}" style="margin-top:4px;">${p.isPaid ? '已到發放日' : '待發放'}</span>
                  </div>
                </div>
                <div class="history-dates-grid">
                  <div>
                    <div class="history-date-label"><span class="dot-gold"></span> 除息日</div>
                    <div class="history-date-value">${exFormatted}</div>
                  </div>
                  <div>
                    <div class="history-date-label"><span class="dot-green"></span> 發放日</div>
                    <div class="history-date-value">${payFormatted}</div>
                  </div>
                </div>
              </div>`;
            })
            .join('')
        : `
          <div class="history-item" style="text-align:center; padding: 28px 18px;">
            <div class="card-row-title" style="margin-bottom:6px;">${y} 年 ${m} 月尚無預估入帳</div>
            <div class="card-row-sub" style="margin-bottom:14px;">可切換其他月份查看，或至「自選」新增買賣紀錄。</div>
            <button class="btn btn-secondary btn-sm" id="btn-month-add-trade" type="button">+ 新增交易紀錄</button>
          </div>`;

    return `
      <div class="detail-topbar">
        <button class="detail-back-btn" id="btn-month-back" type="button">&lsaquo; 返回動態</button>
        <div style="display:flex; align-items:center; gap:6px;">
          <button class="page-btn" id="btn-month-prev" type="button" style="padding:6px 12px;">&lsaquo;</button>
          <span class="pill-badge" style="padding:6px 12px;">${y} 年 ${m} 月</span>
          <button class="page-btn" id="btn-month-next" type="button" style="padding:6px 12px;">&rsaquo;</button>
        </div>
      </div>

      <header style="margin-bottom: 16px;">
        <div class="eyebrow">MONTHLY CASH FLOW</div>
        <h1 class="hero-title" style="font-size: 24px; margin-bottom: 4px;">${m} 月完整入帳明細</h1>
        <p class="section-desc">依除息日前持有股數自動計算，點擊項目可查看該 ETF 歷史配息</p>
      </header>

      <div class="card" style="margin-bottom: 20px;">
        <div class="amount-label">本月預估入帳總額</div>
        <div class="amount-hero">${formatNT(monthTotal)}</div>
        <div class="stats-grid-3" style="margin-bottom: 0;">
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
      </div>

      <section class="section-block">
        <div class="section-header">
          <div>
            <div class="eyebrow">PAYOUT BREAKDOWN</div>
            <h2 class="section-title">入帳項目明細</h2>
          </div>
          <span class="payout-meta">${monthPayouts.length} 筆</span>
        </div>
        <div class="card history-list-card">
          ${listHtml}
        </div>
      </section>
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

    document.getElementById('form-add-trade').addEventListener('submit', async (e) => {
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
      if (state.user && window.FirebaseSync) {
        try {
          await window.FirebaseSync.saveTransaction(state.user.uid, newTx);
          showToast(`已新增並同步 ${newTx.code} 交易紀錄`);
          return;
        } catch (_) {
          showToast(`已儲存至本機，但雲端同步失敗`);
          return;
        }
      }
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
    if (state.detailCode) main.innerHTML = renderEtfDetail(state.detailCode);
    else if (state.showMonthDetail) main.innerHTML = renderMonthDetail();
    else if (state.activeTab === 'dashboard') main.innerHTML = renderDashboard();
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
        state.selectedYear = parseInt(TODAY_STR.slice(0, 4), 10);
        state.selectedMonth = parseInt(TODAY_STR.slice(5, 7), 10);
        state.showMonthDetail = true;
        window.scrollTo({ top: 0, behavior: 'smooth' });
        render();
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
      btn.addEventListener('click', async () => {
        const id = btn.dataset.deleteTx;
        state.transactions = state.transactions.filter((t) => t.id !== id);
        saveTransactions();
        render();
        if (state.user && window.FirebaseSync) {
          try {
            await window.FirebaseSync.deleteTransaction(state.user.uid, id);
            showToast('已刪除並同步雲端');
            return;
          } catch (_) {
            showToast('已從本機刪除，雲端刪除失敗');
            return;
          }
        }
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
        reader.onload = async () => {
          try {
            const parsed = JSON.parse(reader.result);
            if (!Array.isArray(parsed)) throw new Error('invalid');
            state.transactions = parsed;
            saveTransactions();
            render();
            if (state.user && window.FirebaseSync) {
              await window.FirebaseSync.replaceAllTransactions(state.user.uid, parsed);
              showToast('已匯入並同步至雲端');
              return;
            }
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
      btnResetDemo.addEventListener('click', async () => {
        const demo = JSON.parse(JSON.stringify(window.DEFAULT_TRANSACTIONS));
        state.transactions = demo;
        saveTransactions();
        render();
        if (state.user && window.FirebaseSync) {
          try {
            await window.FirebaseSync.replaceAllTransactions(state.user.uid, demo);
            showToast('已恢復範例資料並同步雲端');
            return;
          } catch (_) {
            // ignore
          }
        }
        showToast('已恢復範例資料');
      });
    }

    const btnRefreshQuotes = document.getElementById('btn-refresh-quotes');
    if (btnRefreshQuotes) {
      btnRefreshQuotes.addEventListener('click', () => fetchLiveQuotes(true));
    }

    document.querySelectorAll('[data-open-etf]').forEach((el) => {
      el.addEventListener('click', () => {
        state.detailCode = el.dataset.openEtf;
        state.historyPage = 1;
        window.scrollTo({ top: 0, behavior: 'smooth' });
        render();
      });
    });

    const btnDetailBack = document.getElementById('btn-detail-back');
    if (btnDetailBack) {
      btnDetailBack.addEventListener('click', () => {
        state.detailCode = null;
        window.scrollTo({ top: 0, behavior: 'smooth' });
        render();
      });
    }

    const btnHistPrev = document.getElementById('btn-hist-prev');
    if (btnHistPrev) {
      btnHistPrev.addEventListener('click', () => {
        if (state.historyPage > 1) {
          state.historyPage -= 1;
          render();
        }
      });
    }

    const btnHistNext = document.getElementById('btn-hist-next');
    if (btnHistNext) {
      btnHistNext.addEventListener('click', () => {
        state.historyPage += 1;
        render();
      });
    }

    const btnMonthBack = document.getElementById('btn-month-back');
    if (btnMonthBack) {
      btnMonthBack.addEventListener('click', () => {
        state.showMonthDetail = false;
        window.scrollTo({ top: 0, behavior: 'smooth' });
        render();
      });
    }

    const btnMonthPrev = document.getElementById('btn-month-prev');
    if (btnMonthPrev) {
      btnMonthPrev.addEventListener('click', () => {
        state.selectedMonth -= 1;
        if (state.selectedMonth < 1) {
          state.selectedMonth = 12;
          state.selectedYear -= 1;
        }
        render();
      });
    }

    const btnMonthNext = document.getElementById('btn-month-next');
    if (btnMonthNext) {
      btnMonthNext.addEventListener('click', () => {
        state.selectedMonth += 1;
        if (state.selectedMonth > 12) {
          state.selectedMonth = 1;
          state.selectedYear += 1;
        }
        render();
      });
    }

    const btnMonthAddTrade = document.getElementById('btn-month-add-trade');
    if (btnMonthAddTrade) {
      btnMonthAddTrade.addEventListener('click', () => openAddTradeModal('0056'));
    }

    const btnHeroCloud = document.getElementById('btn-hero-cloud');
    if (btnHeroCloud) {
      btnHeroCloud.addEventListener('click', () => {
        state.activeTab = 'settings';
        render();
      });
    }

    const btnGoogleSignIn = document.getElementById('btn-google-signin');
    if (btnGoogleSignIn) {
      btnGoogleSignIn.addEventListener('click', async () => {
        if (!window.FirebaseSync || !window.FirebaseSync.isAvailable()) {
          showToast('Firebase 尚未載入，請確認網路連線');
          return;
        }
        state.authError = null;
        try {
          const user = await window.FirebaseSync.signIn();
          if (user) {
            state.user = user;
            render();
            showToast('已登入：' + (user.email || 'Google 帳號'));
          }
        } catch (err) {
          const code = err && err.code ? err.code : '';
          let msg = err && err.message ? err.message : '登入失敗';
          if (code === 'auth/unauthorized-domain') {
            msg = `網域「${window.location.hostname}」尚未加入 Firebase 已授權網域，請至 Firebase Console → Authentication → Settings → Authorized domains 新增此網域。`;
          } else if (code === 'auth/popup-closed-by-user') {
            msg = '已取消登入視窗';
          }
          state.authError = msg;
          render();
          showToast(msg);
        }
      });
    }

    const btnGoogleSignOut = document.getElementById('btn-google-signout');
    if (btnGoogleSignOut) {
      btnGoogleSignOut.addEventListener('click', async () => {
        if (window.FirebaseSync) {
          await window.FirebaseSync.signOut();
          showToast('已登出帳號');
        }
      });
    }

    const btnUploadLocal = document.getElementById('btn-upload-local-to-cloud');
    if (btnUploadLocal) {
      btnUploadLocal.addEventListener('click', async () => {
        if (!state.user || !window.FirebaseSync) return;
        const localTx = loadTransactions();
        if (localTx.length === 0) {
          showToast('本機目前沒有紀錄可上傳');
          return;
        }
        try {
          await window.FirebaseSync.uploadTransactions(state.user.uid, localTx);
          showToast(`已上傳 ${localTx.length} 筆本機紀錄至雲端`);
        } catch (_) {
          showToast('上傳失敗，請確認 Firestore 規則已發布');
        }
      });
    }

    const btnClearAll = document.getElementById('btn-clear-all');
    if (btnClearAll) {
      btnClearAll.addEventListener('click', async () => {
        state.transactions = [];
        saveTransactions();
        render();
        if (state.user && window.FirebaseSync) {
          try {
            await window.FirebaseSync.replaceAllTransactions(state.user.uid, []);
            showToast('已清空本機與雲端紀錄');
            return;
          } catch (_) {
            // ignore
          }
        }
        showToast('已清空所有交易紀錄');
      });
    }
  }

  // Bottom nav clicks
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.detailCode = null;
      state.showMonthDetail = false;
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

  if (window.FirebaseSync && window.FirebaseSync.isAvailable()) {
    window.FirebaseSync.init({
      onAuthChange: (user) => {
        state.user = user;
        state.cloudSynced = false;
        if (!user) {
          state.transactions = loadTransactions();
        }
        render();
      },
      onTransactionsSync: (cloudList) => {
        const isFirstSync = !state.cloudSynced;
        state.cloudSynced = true;
        if (isFirstSync && cloudList.length === 0) {
          const localTx = loadTransactions();
          if (localTx.length > 0 && state.user) {
            state.transactions = localTx;
            window.FirebaseSync.uploadTransactions(state.user.uid, localTx).catch(() => {});
            render();
            showToast(`已將本機 ${localTx.length} 筆紀錄自動同步至雲端`);
            return;
          }
        }
        state.transactions = cloudList;
        saveTransactions();
        render();
      },
      onError: (err) => {
        const code = err && err.code ? err.code : '';
        const msg =
          code === 'permission-denied'
            ? 'Firestore 權限不足，請確認已發布安全規則'
            : '雲端連線異常：' + (err && err.message ? err.message : code);
        state.authError = msg;
        render();
        showToast(msg);
      }
    });
  }

  render();
  fetchLiveQuotes(false);
})();
