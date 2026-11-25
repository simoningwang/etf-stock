/**
 * Vercel Serverless Function: /api/dividends
 * 抓取台股 ETF 真實歷史配息與最新除息預告：
 * 1. Yahoo Finance (events=div&range=5y)：取得過去 5 年真實除息日與每股配息金額
 * 2. TWSE 證交所除權除息預告表 (TWT48U)：補齊尚未除息的最新一期公告
 * 設有 1 小時 CDN 快取。
 */

const DEFAULT_CODES = ['0056', '00878', '00919', '00713', '00937B', '006208', '0050'];

function toTaipeiDateStr(unixSeconds) {
  // 轉換為台灣時間 (UTC+8) YYYY-MM-DD
  const ms = (unixSeconds + 8 * 3600) * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function parseRocDate(rocStr) {
  if (!rocStr || typeof rocStr !== 'string') return null;
  const m = rocStr.match(/(\d{2,3})[\/年](\d{1,2})[\/月](\d{1,2})/);
  if (!m) return null;
  const year = parseInt(m[1], 10) + 1911;
  const month = m[2].padStart(2, '0');
  const day = m[3].padStart(2, '0');
  return `${year}-${month}-${day}`;
}

async function fetchYahooDividends(code) {
  const suffixes = code.endsWith('B') ? ['.TWO', '.TW'] : ['.TW', '.TWO'];
  for (const suffix of suffixes) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(code)}${suffix}?events=div&range=5y&interval=1mo`;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(5500)
      });
      if (!res.ok) continue;
      const data = await res.json();
      const result = data?.chart?.result?.[0];
      const divMap = result?.events?.dividends;
      if (!divMap || typeof divMap !== 'object') continue;

      const list = Object.values(divMap)
        .map((item) => {
          const exDate = toTaipeiDateStr(item.date);
          const amount = Number(item.amount);
          if (!exDate || !Number.isFinite(amount) || amount <= 0) return null;
          return {
            exDate,
            payDate: addDays(exDate, 25),
            isEstimatedPayDate: true,
            amount: Number(amount.toFixed(4)),
            source: 'Yahoo'
          };
        })
        .filter(Boolean)
        .sort((a, b) => b.exDate.localeCompare(a.exDate));

      if (list.length > 0) return list;
    } catch (_) {
      // try next suffix
    }
  }
  return [];
}

async function fetchTwseUpcoming() {
  const map = {};
  try {
    const url = 'https://www.twse.com.tw/rwd/zh/exRight/TWT48U?response=json';
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ETFStockTracker/1.0)',
        'Accept': 'application/json'
      },
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) return map;
    const data = await res.json();
    if (!data || !Array.isArray(data.data)) return map;

    for (const row of data.data) {
      // TWT48U 欄位：[0]除權息日期, [1]股票代號, [2]名稱, ..., [7]現金股利
      const exDate = parseRocDate(row[0]);
      const code = typeof row[1] === 'string' ? row[1].trim() : '';
      const rawCash = typeof row[7] === 'string' ? row[7].replace(/,/g, '') : row[7];
      const amount = parseFloat(rawCash);
      if (!exDate || !code || !Number.isFinite(amount) || amount <= 0) continue;

      if (!map[code]) map[code] = [];
      map[code].push({
        exDate,
        payDate: addDays(exDate, 25),
        isEstimatedPayDate: true,
        amount: Number(amount.toFixed(4)),
        source: 'TWSE'
      });
    }
  } catch (_) {
    // ignore TWSE timeout/errors
  }
  return map;
}

function buildEstimatedNextDividend(merged, todayStr) {
  if (!merged || merged.length === 0) return null;
  const latest = merged[0]; // sorted descending by exDate
  // 若已經有未來的正式除息公告，就不重複預估
  if (latest.exDate > todayStr) return null;

  // 推算配息週期（月數）：預設依最近兩次除息日間隔判斷（1 / 3 / 6 / 12 個月）
  let intervalMonths = 3;
  if (merged.length >= 2) {
    const d1 = new Date(`${merged[0].exDate}T00:00:00Z`);
    const d2 = new Date(`${merged[1].exDate}T00:00:00Z`);
    const rawDiff =
      (d1.getUTCFullYear() - d2.getUTCFullYear()) * 12 +
      (d1.getUTCMonth() - d2.getUTCMonth());
    if (rawDiff <= 1) intervalMonths = 1;
    else if (rawDiff <= 4) intervalMonths = 3;
    else if (rawDiff <= 8) intervalMonths = 6;
    else intervalMonths = 12;
  }

  const base = new Date(`${latest.exDate}T00:00:00Z`);
  const target = new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + intervalMonths, base.getUTCDate())
  );
  const estExDate = target.toISOString().slice(0, 10);

  // 取得「下個月」的 YYYY-MM
  const now = new Date(`${todayStr}T00:00:00Z`);
  const nextMonthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const nextMonthYM = nextMonthDate.toISOString().slice(0, 7);
  const currentYM = todayStr.slice(0, 7);

  const estPayDate = addDays(estExDate, 25);
  // 若推算的除息日或發放日落在「本月」或「下個月」且在未來，就提供預估
  if (
    estExDate > todayStr &&
    (estExDate.slice(0, 7) === currentYM ||
      estExDate.slice(0, 7) === nextMonthYM ||
      estPayDate.slice(0, 7) === nextMonthYM)
  ) {
    return {
      exDate: estExDate,
      payDate: estPayDate,
      isEstimatedPayDate: true,
      isEstimatedDividend: true,
      amount: latest.amount,
      source: 'Estimated'
    };
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const rawCodes = typeof req.query?.codes === 'string' ? req.query.codes : '';
  const codes = rawCodes
    ? rawCodes
        .split(',')
        .map((c) => c.trim())
        .filter((c) => /^\d{4,6}[A-Z]?$/.test(c))
    : DEFAULT_CODES;

  const [twseUpcoming, ...yahooLists] = await Promise.all([
    fetchTwseUpcoming(),
    ...codes.map((c) => fetchYahooDividends(c))
  ]);

  const now = new Date();
  const todayStr = toTaipeiDateStr(Math.floor(now.getTime() / 1000));
  const oneYearAgo = new Date(now);
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  const oneYearAgoStr = oneYearAgo.toISOString().slice(0, 10);

  const dividendsByCode = {};
  codes.forEach((code, idx) => {
    const mergedMap = {};
    for (const item of yahooLists[idx] || []) {
      mergedMap[item.exDate] = item;
    }
    for (const item of twseUpcoming[code] || []) {
      mergedMap[item.exDate] = item;
    }

    let merged = Object.values(mergedMap).sort((a, b) => b.exDate.localeCompare(a.exDate));
    if (merged.length === 0) return;

    // 若下個月尚未有官方公告，依歷史節奏預估下一期
    const estNext = buildEstimatedNextDividend(merged, todayStr);
    if (estNext && !mergedMap[estNext.exDate]) {
      merged = [estNext, ...merged];
    }

    const recent12m = merged.filter((d) => !d.isEstimatedDividend && d.exDate >= oneYearAgoStr);
    const annualDividendPerShare = Number(
      recent12m.reduce((s, d) => s + d.amount, 0).toFixed(3)
    );
    const payoutMonths = Array.from(
      new Set(recent12m.map((d) => parseInt(d.payDate.slice(5, 7), 10)))
    ).sort((a, b) => a - b);

    dividendsByCode[code] = {
      code,
      annualDividendPerShare,
      payoutMonths,
      dividends: merged
    };
  });

  return res.status(200).json({
    updatedAt: new Date().toISOString(),
    count: Object.keys(dividendsByCode).length,
    dividendsByCode
  });
}
