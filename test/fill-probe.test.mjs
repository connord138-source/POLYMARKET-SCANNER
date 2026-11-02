// The fill probe (src/fill-probe.js). Run with: node test/fill-probe.test.mjs
import { probeRead, readBook, runFillProbe, summarizeProbes, PROBE_DELAY_MS } from "../src/fill-probe.js";
import { kalshiOrderbook } from "../src/kalshi.js";
let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.error("FAIL:", n, x ?? ""); } };
const json = (b, status = 200) => ({ ok: status < 400, status, json: async () => b, text: async () => JSON.stringify(b), headers: { get: () => null } });

// ---------- pure ----------
{
  const buy = { venue: "us", side: "buy", px: 0.40, shares: 25 }, sell = { venue: "us", side: "sell", px: 0.60, shares: 25 };
  const a = probeRead(buy, { bid: 0.39, ask: 0.40, bidQty: 100, askQty: 80 }, 3.2);
  check("buy: the ask still at the entry with 80 shares -> there, enough, moveC 0", a.there === true && a.enough === true && a.qty === 80 && a.moveC === 0 && a.px === 0.4 && a.s === 3.2, a);
  const b = probeRead(buy, { bid: 0.40, ask: 0.42, bidQty: 100, askQty: 500 }, 12);
  check("buy: the ask moved up 2c -> gone, moveC +2, enough false", b.there === false && b.enough === false && b.moveC === 2, b);
  const c = probeRead(buy, { bid: 0.37, ask: 0.39, bidQty: 1, askQty: 10 }, 3);
  check("buy: a better ask counts as there; size below the scalp -> enough false", c.there === true && c.moveC === -1 && c.enough === false && c.qty === 10, c);
  const d = probeRead(sell, { bid: 0.60, ask: 0.62, bidQty: 30, askQty: 5 }, 3);
  check("sell: the bid still at the entry with 30 contracts -> there, enough", d.there === true && d.enough === true && d.qty === 30, d);
  const e = probeRead(sell, { bid: 0.58, ask: 0.60, bidQty: 30, askQty: 5 }, 3);
  check("sell: the bid dropped 2c -> gone, moveC +2", e.there === false && e.moveC === 2, e);
  const f = probeRead(buy, { bid: 0.40, ask: 0.40, bidQty: null, askQty: null }, 3);
  check("no sizes (bbo fallback / Kalshi without counts): there is known, enough is null", f.there === true && f.enough === null && f.qty === null, f);
  check("no book -> there null; empty side -> there false", probeRead(buy, null, 3).there === null && probeRead(buy, { bid: 0.4, ask: null }, 3).there === false && probeRead(buy, { bid: 0.4, ask: null }, 3).note === "side empty");
  const sum = summarizeProbes([
    { venue: "us", probe: { t0: { s: 3, there: true, enough: true, qty: 80, moveC: 0 }, t1: { s: 13, there: false, enough: false, qty: 500, moveC: 2 }, delayS: 10 } },
    { venue: "us", probe: { t0: { s: 5, there: true, enough: false, qty: 10, moveC: -1 }, t1: { s: 15, there: true, enough: true, qty: 60, moveC: 0 }, delayS: 10 } },
    { venue: "us", probe: { t0: { s: 4, there: null, note: "no book" }, t1: { s: 14, there: false, moveC: 4 }, delayS: 10 } },
    { venue: "kalshi", probe: { t0: { s: 6, there: true, enough: null, qty: null, moveC: 0 }, t1: { s: 16, there: true, enough: null, qty: null, moveC: 0 }, delayS: 10 } },
    { venue: "us", probe: null }, { venue: "us" },
  ]);
  check("summary: per venue and look, rates over the reads that answered, median size when there, average move when gone, seconds after the sample", sum.us.n === 3 && sum.us.t0.n === 3 && sum.us.t0.read === 2 && sum.us.t0.noBook === 1 && sum.us.t0.there === 2 && sum.us.t0.thereRate === 1 && sum.us.t0.enough === 1 && sum.us.t0.enoughRate === 0.5 && sum.us.t0.qtyMed === 80 && sum.us.t0.avgS === 4 && sum.us.t1.thereRate === Math.round(100 / 3) / 100 && sum.us.t1.goneAvgMoveC === 3 && sum.kalshi.n === 1 && sum.kalshi.t0.thereRate === 1 && sum.kalshi.t0.enoughRate === null, JSON.stringify(sum));
  check("summary: nothing probed -> empty", Object.keys(summarizeProbes([{ venue: "us" }])).length === 0 && Object.keys(summarizeProbes(null)).length === 0);
}

// ---------- Kalshi order book -> YES-terms top of book ----------
{
  const calls = [];
  const fetchImpl = async (u) => { calls.push(String(u)); return json({ orderbook_fp: { yes_dollars: [["0.4000", "35.00"], ["0.3900", "120.00"]], no_dollars: [["0.5800", "22.00"], ["0.5700", "80.00"]] } }); };
  const ob = await kalshiOrderbook({}, "KXNHLGAME-26NOV02NJWAS-NJ", { fetchImpl });
  check("orderbook: best YES bid 0.40 x 35; best NO bid 0.58 = YES ask 0.42 x 22; depth asked for", ob.bid === 0.40 && ob.bidQty === 35 && ob.ask === 0.42 && ob.askQty === 22 && /\/markets\/KXNHLGAME-26NOV02NJWAS-NJ\/orderbook\?depth=5$/.test(calls[0]), { ob, calls });
  const legacy = await kalshiOrderbook({}, "T", { fetchImpl: async () => json({ orderbook: { yes: [[40, 35]], no: [[58, 22]] } }) });
  check("orderbook: the legacy cents shape is read the same way", legacy.bid === 0.40 && legacy.ask === 0.42 && legacy.askQty === 22, legacy);
  const empty = await kalshiOrderbook({}, "T", { fetchImpl: async () => json({ orderbook_fp: { yes_dollars: [], no_dollars: [] } }) });
  check("orderbook: empty on both sides -> null; one side -> the other null", empty === null && (await kalshiOrderbook({}, "T", { fetchImpl: async () => json({ orderbook_fp: { yes_dollars: [["0.40", "1"]], no_dollars: [] } }) })).ask === null);
  let threw = false; try { await kalshiOrderbook({}, "T", { fetchImpl: async () => json({ message: "nope" }, 404) }); } catch (e) { threw = e.status === 404; }
  check("orderbook: a venue error throws with its status (readBook swallows it)", threw && (await readBook({}, { venue: "kalshi", kTicker: "T", side: "buy", px: 0.4, shares: 10 }, { fetchImpl: async () => json({ message: "nope" }, 404) })) === null);
}

// ---------- runFillProbe: both venues in one pass, one shared wait, results on the positions ----------
{
  const reads = [];
  const fetchImpl = async (u) => {
    const s = String(u); reads.push(s);
    if (/gateway\.polymarket\.us\/v1\/markets\/nba-lal-bos\/book/.test(s)) return json({ marketData: { bids: [{ px: { value: "0.39" }, qty: "100" }], offers: [{ px: { value: reads.filter(x => /nba-lal-bos\/book/.test(x)).length === 1 ? "0.40" : "0.43" }, qty: "60" }] } });
    if (/\/markets\/K-NJ\/orderbook/.test(s)) return json({ orderbook_fp: { yes_dollars: [["0.6000", "40.00"]], no_dollars: [["0.3800", "15.00"]] } });
    return json({}, 404);
  };
  let slept = null; const sleep = async (ms) => { slept = ms; };
  let t = 0; const clock = () => 1_000_000 + (t += 3000);
  const us = { venue: "us", usSlug: "nba-lal-bos", side: "buy", px: 0.40, shares: 25, live: false };
  const k = { venue: "kalshi", kTicker: "K-NJ", side: "sell", px: 0.60, shares: 16, live: false };
  const live = { venue: "us", usSlug: "nba-lal-bos", side: "buy", px: 0.40, shares: 25, live: true };
  const r = await runFillProbe({}, [us, k, live], { fetchImpl, nowMs: 1_000_000, delayMs: 10000, sleep, clock });
  check("probe: dry positions only, both venues read twice, one wait of the delay, t0/t1 on each", r.probed === 2 && r.there0 === 2 && r.there1 === 1 && slept === 10000 && !live.probe && us.probe.t0.there === true && us.probe.t0.qty === 60 && us.probe.t1.there === false && us.probe.t1.moveC === 3 && k.probe.t0.there === true && k.probe.t0.qty === 40 && k.probe.t1.there === true && us.probe.delayS === 10 && us.probe.t0.s === 3 && reads.length === 4, { r, us: us.probe, k: k.probe, reads });
  const none = await runFillProbe({}, [{ venue: "us", usSlug: null, side: "buy", px: 0.4, shares: 1 }], { fetchImpl, sleep, clock });
  check("probe: nothing probeable -> probed 0, no wait", none.probed === 0 && PROBE_DELAY_MS === 10000);
  const failing = { venue: "us", usSlug: "x", side: "buy", px: 0.4, shares: 1 };
  const rf = await runFillProbe({}, [failing], { fetchImpl: async () => { throw new Error("net"); }, sleep, clock });
  check("probe: a failing book read records no book, never throws", rf.probed === 1 && failing.probe.t0.there === null && failing.probe.t0.note === "no book", failing.probe);
}

console.log(`fill-probe: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
