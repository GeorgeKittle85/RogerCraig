// Market data via Yahoo Finance's public endpoints. Free, no API key.
// Yahoo doesn't officially publish these as an API anymore, but the
// endpoints that power finance.yahoo.com still work and return clean JSON.
//
// (Stooq's quote endpoint started requiring an emailed/captcha API key as of
// April 2026, so it's no longer usable without one — this replaces it.)

const DEFAULT_SYMBOLS = [
  { symbol: "^GSPC", label: "S&P 500" },
  { symbol: "^DJI", label: "Dow Jones" },
  { symbol: "^IXIC", label: "Nasdaq Composite" }
];

const HEADERS = {
  // Yahoo returns 403s to requests without a browser-like User-Agent.
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
};

async function fetchChartMeta(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    return { symbol, error: `HTTP ${res.status}` };
  }
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) {
    return { symbol, error: "no data returned" };
  }
  return { meta: result.meta };
}

// --- Index snapshot (unchanged interface: /stocks) -------------------------

export async function getMarketSnapshot(symbols = DEFAULT_SYMBOLS) {
  return Promise.all(
    symbols.map(async ({ symbol, label }) => {
      const { meta, error } = await fetchChartMeta(symbol);
      if (error || !meta) return { label, symbol, error: error ?? "no data" };

      const price = meta.regularMarketPrice;
      const prevClose = meta.previousClose ?? meta.chartPreviousClose;
      const changePct = isFinite(price) && isFinite(prevClose) && prevClose !== 0
        ? ((price - prevClose) / prevClose) * 100
        : null;

      return {
        label,
        symbol,
        price,
        prevClose,
        changePct,
        time: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000) : null,
        marketState: meta.marketState ?? null
      };
    })
  );
}

export function formatMarketReport(snapshot) {
  const lines = ["Market snapshot"];
  let stamp = null;

  for (const s of snapshot) {
    if (s.error || !isFinite(s.price)) {
      lines.push(`→ ${s.label}: data unavailable (${s.error ?? "unknown error"})`);
      continue;
    }
    const arrow = s.changePct === null ? "" : s.changePct >= 0 ? "▲" : "▼";
    const changeStr = s.changePct === null ? "" : ` (${arrow} ${Math.abs(s.changePct).toFixed(2)}% today)`;
    lines.push(`→ ${s.label}: ${s.price.toFixed(2)}${changeStr}`);
    if (!stamp && s.time) stamp = s.time;
  }

  const stateNote = snapshot.find(s => s.marketState)?.marketState;
  lines.push(
    `As of ${stamp ? stamp.toLocaleString() : "—"}${stateNote ? ` (market: ${stateNote})` : ""} — source: Yahoo Finance`
  );
  return lines.join("\n");
}

// --- Single-stock lookup by name or ticker (/stock <query>) ----------------

// Resolves free text ("american airlines") or a ticker ("AAL") to a symbol
// using Yahoo's search endpoint, which covers both company names and tickers.
export async function resolveSymbol(query) {
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=5&newsCount=0`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`Symbol search failed: HTTP ${res.status}`);
  const data = await res.json();
  const quotes = (data.quotes || []).filter(q => q.symbol && (q.isYahooFinance ?? true));

  if (!quotes.length) {
    throw new Error(`No ticker found matching "${query}".`);
  }

  // Prefer an exact ticker match (e.g. user typed "AAL"), otherwise take the
  // top-ranked result, favoring equities over funds/options where possible.
  const exact = quotes.find(q => q.symbol.toUpperCase() === query.trim().toUpperCase());
  const best = exact || quotes.find(q => q.quoteType === "EQUITY") || quotes[0];

  return {
    symbol: best.symbol,
    name: best.longname || best.shortname || best.symbol,
    exchange: best.exchDisp || best.exchange || null
  };
}

export async function getStockDetail(query) {
  const resolved = await resolveSymbol(query);
  const { meta, error } = await fetchChartMeta(resolved.symbol);
  if (error || !meta) {
    throw new Error(`Could not fetch data for ${resolved.symbol}: ${error ?? "no data"}`);
  }

  const price = meta.regularMarketPrice;
  const prevClose = meta.previousClose ?? meta.chartPreviousClose;
  const changePct = isFinite(price) && isFinite(prevClose) && prevClose !== 0
    ? ((price - prevClose) / prevClose) * 100
    : null;
  const changeAbs = isFinite(price) && isFinite(prevClose) ? price - prevClose : null;

  return {
    symbol: meta.symbol ?? resolved.symbol,
    name: meta.longName || meta.shortName || resolved.name,
    exchange: meta.fullExchangeName || meta.exchangeName || resolved.exchange,
    currency: meta.currency,
    price,
    prevClose,
    changeAbs,
    changePct,
    dayHigh: meta.regularMarketDayHigh,
    dayLow: meta.regularMarketDayLow,
    fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
    fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
    volume: meta.regularMarketVolume,
    marketState: meta.marketState ?? null,
    time: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000) : null,
    // Present only outside regular trading hours, when Yahoo has newer data
    // than the last regular-session trade.
    preMarketPrice: meta.preMarketPrice,
    preMarketTime: meta.preMarketTime ? new Date(meta.preMarketTime * 1000) : null,
    postMarketPrice: meta.postMarketPrice,
    postMarketTime: meta.postMarketTime ? new Date(meta.postMarketTime * 1000) : null
  };
}

const MARKET_STATE_LABELS = {
  REGULAR: "market open",
  PRE: "pre-market",
  POST: "after-hours",
  POSTPOST: "after-hours",
  CLOSED: "market closed"
};

export function formatStockDetail(d) {
  if (!isFinite(d.price)) {
    return `No live price available for ${d.symbol}.`;
  }
  const arrow = d.changePct === null ? "" : d.changePct >= 0 ? "▲" : "▼";
  const changeStr = d.changePct === null
    ? ""
    : ` ${arrow} ${d.changeAbs >= 0 ? "+" : ""}${d.changeAbs.toFixed(2)} (${d.changePct.toFixed(2)}%) today`;

  const fmt = (n) => (isFinite(n) ? n.toFixed(2) : "—");
  const vol = isFinite(d.volume) ? d.volume.toLocaleString() : "—";
  const stateLabel = MARKET_STATE_LABELS[d.marketState] ?? d.marketState ?? null;

  const lines = [
    `${d.name} (${d.symbol})${d.exchange ? " — " + d.exchange : ""}`,
    `→ Price: ${fmt(d.price)} ${d.currency ?? ""}${changeStr}`,
    `→ Day range: ${fmt(d.dayLow)} - ${fmt(d.dayHigh)}`,
    `→ 52-week range: ${fmt(d.fiftyTwoWeekLow)} - ${fmt(d.fiftyTwoWeekHigh)}`,
    `→ Volume: ${vol}`
  ];

  // If it's pre-market or after-hours and Yahoo has a newer indicative
  // price than the last regular-session trade, surface it — this is the
  // closest thing to "down to the minute" outside the 9:30-4:00 ET window.
  if (isFinite(d.postMarketPrice) && d.marketState !== "REGULAR") {
    lines.push(`→ After-hours: ${fmt(d.postMarketPrice)} ${d.currency ?? ""} (as of ${d.postMarketTime?.toLocaleTimeString() ?? "—"})`);
  } else if (isFinite(d.preMarketPrice) && d.marketState !== "REGULAR") {
    lines.push(`→ Pre-market: ${fmt(d.preMarketPrice)} ${d.currency ?? ""} (as of ${d.preMarketTime?.toLocaleTimeString() ?? "—"})`);
  }

  lines.push(
    `As of ${d.time ? d.time.toLocaleString() : "—"}${stateLabel ? ` — ${stateLabel}` : ""} — source: Yahoo Finance (free feed, may run ~15 min behind during live trading; outside trading hours this is the last actual trade)`
  );
  return lines.join("\n");
}
