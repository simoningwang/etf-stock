/**
 * Vercel Serverless Function: /api/etf
 * 取得台股 ETF 即時成交價 / 參考價（優先使用 TWSE 證交所即時介面，備援 Yahoo Finance）
 * 設有 60 秒 CDN 快取，避免過度請求公開來源。
 */

const DEFAULT_CODES = ['0056', '00878', '00919', '00713', '00929', '0050'];

async function fetchFromTWSE(codes) {
  const exCh = codes.map((c) => `tse_${c}.tw`).join('|');
  const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(exCh)}&json=1&delay=0`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; ETFStockTracker/1.0)',
      'Accept': 'application/json'
    },
    signal: AbortSignal.timeout(5000)
  });

  if (!res.ok) throw new Error(`TWSE HTTP ${res.status}`);
  const data = await res.json();
  if (!data || !Array.isArray(data.msgArray)) {
    throw new Error('TWSE unexpected payload');
  }

  const quotes = {};
  for (const item of data.msgArray) {
    const code = item.c;
    if (!code) continue;
    // z = 最新成交價（盤中無成交可能為 '-'），y = 昨收價
    const rawPrice = item.z && item.z !== '-' ? item.z : item.y;
    const price = parseFloat(rawPrice);
    const prevClose = parseFloat(item.y);
    if (!Number.isFinite(price) || price <= 0) continue;

    quotes[code] = {
      code,
      price,
      prevClose: Number.isFinite(prevClose) ? prevClose : price,
      change: Number.isFinite(prevClose) ? Number((price - prevClose).toFixed(2)) : 0,
      changePct:
        Number.isFinite(prevClose) && prevClose > 0
          ? Number((((price - prevClose) / prevClose) * 100).toFixed(2))
          : 0,
      source: 'TWSE'
    };
  }
  return quotes;
}

async function fetchOneFromYahoo(code) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(code)}.TW?interval=1d&range=2d`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(4500)
  });
  if (!res.ok) return null;
  const data = await res.json();
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta || !Number.isFinite(meta.regularMarketPrice)) return null;

  const price = Number(meta.regularMarketPrice.toFixed(2));
  const prevClose = Number.isFinite(meta.chartPreviousClose)
    ? Number(meta.chartPreviousClose.toFixed(2))
    : price;

  return {
    code,
    price,
    prevClose,
    change: Number((price - prevClose).toFixed(2)),
    changePct: prevClose > 0 ? Number((((price - prevClose) / prevClose) * 100).toFixed(2)) : 0,
    source: 'Yahoo'
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');

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

  let quotes = {};
  try {
    quotes = await fetchFromTWSE(codes);
  } catch (_) {
    // Fallback to Yahoo Finance per symbol if TWSE fails
  }

  // 補齊 TWSE 沒抓到的代號
  const missing = codes.filter((c) => !quotes[c]);
  if (missing.length > 0) {
    const yahooResults = await Promise.allSettled(missing.map((c) => fetchOneFromYahoo(c)));
    for (const r of yahooResults) {
      if (r.status === 'fulfilled' && r.value) {
        quotes[r.value.code] = r.value;
      }
    }
  }

  return res.status(200).json({
    updatedAt: new Date().toISOString(),
    count: Object.keys(quotes).length,
    quotes
  });
}
