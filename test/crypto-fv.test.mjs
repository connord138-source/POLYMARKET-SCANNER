// Crypto fair value. Run with: node test/crypto-fv.test.mjs
import { Phi, priceContract, realizedVol, parseCryptoQuestion, priceMarkets, summarize, annotateCryptoFairValue, refreshCryptoFairValue, getCryptoFairValue, fetchCandles } from "../src/crypto-fv.js";
let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.error("FAIL:", n, x ?? ""); } };
const near = (a, b, e = 1e-3) => Math.abs(a - b) < e;

check("Phi", near(Phi(0), 0.5) && near(Phi(1.96), 0.975, 2e-4) && near(Phi(-3), 0.00135, 1e-4));
{
  const base = { spot: 82000, sigma: 0.35, T: 30 / 365 };
  const above = priceContract({ kind: "above", K: 82000, ...base });
  check("above at the money is just under 50% (drift -sigma^2/2)", above < 0.5 && above > 0.47, above);
  check("above + below = 1", near(priceContract({ kind: "above", K: 90000, ...base }) + priceContract({ kind: "below", K: 90000, ...base }), 1));
  check("dip/reach: touched already -> 1; monotone in distance", priceContract({ kind: "dip", K: 85000, ...base }) === 1 && priceContract({ kind: "reach", K: 80000, ...base }) === 1 && priceContract({ kind: "dip", K: 75000, ...base }) > priceContract({ kind: "dip", K: 65000, ...base }) && priceContract({ kind: "reach", K: 86000, ...base }) > priceContract({ kind: "reach", K: 95000, ...base }));
  // reflection principle: P(touch) = 2 * P(end beyond) for a driftless walk
  const K = 75000, sq = 0.35 * Math.sqrt(30 / 365);
  check("dip equals twice the terminal probability (driftless reflection)", near(priceContract({ kind: "dip", K, ...base }), 2 * Phi(Math.log(K / 82000) / sq), 1e-9));
  check("expired contracts settle on spot", priceContract({ kind: "above", K: 80000, spot: 82000, sigma: 0.35, T: 0 }) === 1 && priceContract({ kind: "dip", K: 80000, spot: 82000, sigma: 0.35, T: -1 }) === 0);
  check("bad inputs -> null", priceContract({ kind: "above", K: 0, ...base }) === null && priceContract({ kind: "x", K: 1, ...base }) === null);
  const closes = Array.from({ length: 200 }, (_, i) => 100 * Math.exp(0.01 * Math.sin(i)));
  check("realized vol: annualized from log returns; too few bars -> null", realizedVol(closes, 24 * 365) > 0 && realizedVol([1, 2, 3], 365) === null);
}
{
  const now = Date.parse("2026-10-15T20:00:00Z");
  const P = (q, end) => parseCryptoQuestion(q, { endDate: end, nowMs: now });
  const a = P("Will the price of Bitcoin be above $84,000 on October 16?", "2026-10-16T00:00:00Z");
  check("parse: above on a date -> noon ET that day", a && a.asset === "BTC" && a.kind === "above" && a.K === 84000 && a.resolvesAt === "2026-10-16T16:00:00.000Z", JSON.stringify(a));
  const d = P("Will Bitcoin dip to $77,500 in October?", "2026-11-01T00:00:00Z");
  check("parse: dip window uses endDate", d && d.kind === "dip" && d.K === 77500 && d.resolvesAt === "2026-11-01T00:00:00.000Z", JSON.stringify(d));
  check("parse: reach / hit / k-suffix / Ethereum / Solana", P("Will Bitcoin reach $87,500 in October?", "2026-11-01T00:00:00Z").kind === "reach" && P("Will Bitcoin hit $100k by December 31?", "2027-01-01T00:00:00Z").K === 100000 && P("Will Ethereum be above $2,500 on October 16?", "2026-10-16T00:00:00Z").asset === "ETH" && P("Will Solana dip to $100 in October?", "2026-11-01T00:00:00Z").asset === "SOL");
  check("parse: below / under", P("Will the price of Bitcoin be below $80,000 on October 18?", "2026-10-18T00:00:00Z").kind === "below");
  check("parse: ranges, ETFs, market cap, non-crypto and missing strike rejected", P("Will Bitcoin be between $80,000 and $85,000 on October 16?", "2026-10-16") === null && P("Will a Solana ETF be approved by $100?", "2026-12-31") === null && P("Will Bitcoin's market cap exceed $2T?", "2026-12-31") === null && P("Will the Fed cut rates to $0?", "2026-12-31") === null && P("Will Bitcoin dip in October?", "2026-11-01") === null);
  check("parse: no end date -> null", P("Will Bitcoin reach $90,000 in October?", undefined) === null);
}
{
  const now = Date.parse("2026-10-15T20:00:00Z");
  const assets = { BTC: { spot: 82000, sigma: 0.35, vols: { h30: 0.35 } } };
  const markets = [
    { question: "Will the price of Bitcoin be above $84,000 on October 16?", slug: "btc-84k-oct16", endDate: "2026-10-16T00:00:00Z", yes: 0.137, volume24hr: 73000, tokenId: "t1" },
    { question: "Will Bitcoin dip to $60,000 by December 31, 2026?", slug: "btc-dip-60k", endDate: "2027-01-01T00:00:00Z", yes: 0.165, volume24hr: 12000 },
    { question: "Will Bitcoin be between $80,000 and $85,000?", slug: "range", endDate: "2026-10-16T00:00:00Z", yes: 0.5, volume24hr: 99999 },
    { question: "Will Bitcoin reach $83,000 on October 15?", slug: "expired", endDate: "2026-10-15T00:00:00Z", yes: 0.3, volume24hr: 5000 },
  ];
  const rows = priceMarkets(markets, assets, now);
  check("priceMarkets: two priced, sorted by volume, range and expired skipped", rows.length === 2 && rows[0].slug === "btc-84k-oct16" && rows[0].kind === "above" && rows[0].model > 0 && rows[0].model < 0.3 && near(rows[0].gap, rows[0].model - 0.137) && rows[1].kind === "dip" && rows[1].days > 70, JSON.stringify(rows));
  const sum = summarize(rows);
  check("summarize: liquid count, median gap, by kind", sum.contracts === 2 && sum.liquid === 2 && typeof sum.medianAbsGapLiquid === "number" && sum.byKind.above.n === 1 && typeof sum.byKind.dip.meanGap === "number", JSON.stringify(sum));
  const fv = { assets, rows };
  const signals = [{ marketSlug: "btc-84k-oct16", direction: "Yes", displayPrice: 15 }, { marketSlug: "btc-dip-60k", directionRaw: "No", avgEntryPrice: 85 }, { marketSlug: "nfl-x" }];
  const n = annotateCryptoFairValue(signals, fv);
  check("annotate: Yes side uses model directly, No side flips it, non-crypto untouched", n === 2 && near(signals[0].cryptoFv.modelSide, rows[0].model) && near(signals[0].cryptoFv.gapSide, rows[0].model - 0.15) && signals[1].cryptoFv.side === "No" && near(signals[1].cryptoFv.modelSide, 1 - rows[1].model) && signals[1].cryptoFv.tail === true && signals[0].cryptoFv.tail === false && !signals[2].cryptoFv, JSON.stringify(signals.map(s => s.cryptoFv)));
}
{
  // IO: Coinbase candle paging (300 max per call, newest first) + ticker + Gamma, KV cache
  const kv = new Map();
  const env = { SIGNALS_CACHE: { get: async (k) => (kv.has(k) ? JSON.parse(kv.get(k)) : null), put: async (k, v) => { kv.set(k, v); } } };
  const now = Date.parse("2026-10-15T20:00:00Z");
  let candleCalls = 0, krakenCalls = 0, krakenOk = false;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/candles?")) {
      candleCalls++;
      const g = Number(u.match(/granularity=(\d+)/)[1]); const start = Date.parse(u.match(/start=([^&]+)/)[1]); const end = Date.parse(u.match(/end=([^&]+)/)[1]);
      const rows = []; for (let t = end - g * 1000; t >= start && rows.length < 300; t -= g * 1000) { const i = Math.floor(t / (g * 1000)); const c = 80000 + 2000 * Math.sin(i / 7); rows.push([Math.floor(t / 1000), c - 50, c + 50, c, c, 10]); }
      return { ok: true, json: async () => rows };
    }
    if (u.includes("/ticker")) return { ok: true, json: async () => ({ price: "82000.5" }) };
    if (u.includes("api.kraken.com")) { krakenCalls++; return krakenOk ? { ok: true, json: async () => { const iv = Number((u.match(/interval=(\d+)/) || [])[1] || 0); if (u.includes("/Ticker")) return { error: [], result: { XXBTZUSD: { c: ["82100.0", "1"] } } }; const n = 720; const rows = []; for (let i = 0; i < n; i++) { const c = 80000 + 2000 * Math.sin(i / 7); rows.push([1700000000 + i * iv * 60, c, c, c, String(c), c, 1, 1]); } return { error: [], result: { XXBTZUSD: rows, last: 1 } }; } } : { ok: false, status: 429, json: async () => ({}) }; }
    if (u.includes("gamma-api")) return { ok: true, json: async () => (u.includes("offset=0") ? [{ slug: "ev", markets: [{ question: "Will the price of Bitcoin be above $84,000 on October 16?", slug: "btc-84k-oct16", endDate: "2026-10-16T00:00:00Z", active: true, closed: false, outcomePrices: '["0.137","0.863"]', clobTokenIds: '["t1","t2"]', volume24hr: 73000, bestBid: 0.13, bestAsk: 0.14 }, { question: "Will ETH be above $2,500 on October 16?", slug: "eth", endDate: "2026-10-16T00:00:00Z", active: true, closed: false, outcomePrices: '["0.5","0.5"]', volume24hr: 10 }] }] : []) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const hourly = await fetchCandles("BTC-USD", 3600, 720, now);
  check("candles: paged to the requested bar count, oldest first", hourly.length === 720 && candleCalls === 3, { n: hourly.length, candleCalls });
  const blob = await refreshCryptoFairValue(env, now);
  check("refresh (Kraken down -> Coinbase): spot from ticker, vols from candles, rows priced, cached", blob.assets.BTC.source === "coinbase" && krakenCalls >= 3 && blob.assets.BTC.spot === 82000.5 && blob.assets.BTC.vols.h30 > 0 && blob.assets.BTC.vols.d90 > 0 && blob.assets.ETH && blob.rows.length === 2 && blob.rows[0].slug === "btc-84k-oct16" && blob.rows[0].bestBid === 0.13 && blob.summary.contracts === 2 && kv.has("crypto_fv"), JSON.stringify({ a: blob.assets.BTC, s: blob.summary, e: blob.errors }));
  const again = await getCryptoFairValue(env, { nowMs: now + 60e3 });
  check("get: fresh cache served without refetch", again.at === blob.at);
  const stale = await getCryptoFairValue(env, { nowMs: now + 3600e3 });
  check("get: stale cache refreshed", stale.at !== blob.at);
  krakenOk = true; candleCalls = 0;
  const viaKraken = await refreshCryptoFairValue(env, now + 7200e3);
  check("refresh (Kraken up): one OHLC call per horizon, 720 hourly bars, Kraken ticker spot, Coinbase untouched", viaKraken.assets.BTC.source === "kraken" && viaKraken.assets.BTC.spot === 82100 && viaKraken.assets.BTC.bars.hourly === 720 && viaKraken.assets.BTC.bars.daily === 90 && viaKraken.assets.BTC.vols.h30 > 0 && candleCalls === 0, JSON.stringify(viaKraken.assets.BTC));
}
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
