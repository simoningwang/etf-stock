/**
 * 台股 ETF 配息參考資料與預設範例持股紀錄
 * 說明：此資料作為初期離線展示與計算引擎測試使用，
 * 後續可替換為 Vercel Serverless API / Google Sheets 動態資料來源。
 */

window.ETF_CATALOG = [
  {
    code: '0056',
    name: '元大高股息',
    frequency: '季配',
    price: 38.45,
    annualDividendPerShare: 3.63,
    payoutMonths: [1, 4, 7, 11],
    dividends: [
      { exDate: '2026-01-19', payDate: '2026-02-12', amount: 0.90 },
      { exDate: '2026-04-20', payDate: '2026-05-14', amount: 0.92 },
      { exDate: '2026-07-17', payDate: '2026-08-11', amount: 0.95 },
      { exDate: '2026-10-19', payDate: '2026-11-11', amount: 0.86 }
    ]
  },
  {
    code: '00878',
    name: '國泰永續高股息',
    frequency: '季配',
    price: 22.65,
    annualDividendPerShare: 2.02,
    payoutMonths: [3, 6, 9, 12],
    dividends: [
      { exDate: '2026-02-25', payDate: '2026-03-20', amount: 0.50 },
      { exDate: '2026-05-18', payDate: '2026-06-12', amount: 0.50 },
      { exDate: '2026-08-17', payDate: '2026-09-11', amount: 0.52 },
      { exDate: '2026-11-18', payDate: '2026-12-14', amount: 0.50 }
    ]
  },
  {
    code: '00919',
    name: '群益台灣精選高息',
    frequency: '季配',
    price: 24.10,
    annualDividendPerShare: 2.84,
    payoutMonths: [1, 4, 7, 10],
    dividends: [
      { exDate: '2026-03-17', payDate: '2026-04-13', amount: 0.72 },
      { exDate: '2026-06-16', payDate: '2026-07-13', amount: 0.72 },
      { exDate: '2026-09-16', payDate: '2026-10-14', amount: 0.70 },
      { exDate: '2026-12-17', payDate: '2027-01-13', amount: 0.70 }
    ]
  },
  {
    code: '00713',
    name: '元大台灣高息低波',
    frequency: '季配',
    price: 54.80,
    annualDividendPerShare: 5.40,
    payoutMonths: [1, 4, 7, 10],
    dividends: [
      { exDate: '2026-03-19', payDate: '2026-04-15', amount: 1.40 },
      { exDate: '2026-06-18', payDate: '2026-07-15', amount: 1.40 },
      { exDate: '2026-09-17', payDate: '2026-10-15', amount: 1.30 },
      { exDate: '2026-12-18', payDate: '2027-01-14', amount: 1.30 }
    ]
  },
  {
    code: '00929',
    name: '復華台灣科技優息',
    frequency: '月配',
    price: 18.95,
    annualDividendPerShare: 1.44,
    payoutMonths: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    dividends: [
      { exDate: '2026-01-20', payDate: '2026-02-13', amount: 0.12 },
      { exDate: '2026-02-23', payDate: '2026-03-18', amount: 0.12 },
      { exDate: '2026-03-19', payDate: '2026-04-14', amount: 0.12 },
      { exDate: '2026-04-21', payDate: '2026-05-15', amount: 0.12 },
      { exDate: '2026-05-19', payDate: '2026-06-12', amount: 0.12 },
      { exDate: '2026-06-18', payDate: '2026-07-14', amount: 0.12 },
      { exDate: '2026-07-21', payDate: '2026-08-14', amount: 0.12 },
      { exDate: '2026-08-19', payDate: '2026-09-14', amount: 0.12 },
      { exDate: '2026-09-18', payDate: '2026-10-14', amount: 0.12 },
      { exDate: '2026-10-20', payDate: '2026-11-13', amount: 0.12 },
      { exDate: '2026-11-19', payDate: '2026-12-14', amount: 0.12 },
      { exDate: '2026-12-18', payDate: '2027-01-13', amount: 0.12 }
    ]
  },
  {
    code: '0050',
    name: '元大台灣50',
    frequency: '半年配',
    price: 196.50,
    annualDividendPerShare: 4.70,
    payoutMonths: [2, 8],
    dividends: [
      { exDate: '2026-01-22', payDate: '2026-02-26', amount: 3.70 },
      { exDate: '2026-07-20', payDate: '2026-08-14', amount: 1.00 }
    ]
  }
];

// 預設範例買賣紀錄（2,000 股 0056 於 2026/05/05 買入 -> 11/11 發放剛好為 NT$1,720）
window.DEFAULT_TRANSACTIONS = [
  {
    id: 'tx-1',
    code: '0056',
    type: 'buy',
    date: '2026-05-05',
    shares: 2000,
    price: 37.80
  },
  {
    id: 'tx-2',
    code: '00878',
    type: 'buy',
    date: '2026-11-20',
    shares: 3000,
    price: 22.50
  }
];
