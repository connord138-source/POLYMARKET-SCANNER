# Go-Live Checklist — real-money trading

Status: **NOT AUTHORIZED — milestone met Oct 20 2026; executor dry run started Oct 24 2026; owner setup (section 2) complete Oct 28 2026; owner decision pending.**
The bot stays in paper mode until every box below is checked, in order.

## 1. The evidence bar (automatic — tracked live)

- [x] **Go-live milestone met** (Oct 20 2026: 37 settled, 17-20, +$12.77 on $200;
      on the taker shadow ledger the same period reads negative — read both):
      ≥ 30 settled *full-size* graduated entries
      (`graduatedEntry` flag — honest live-priced fills by construction)
      with positive total PnL. Progress: Auto-Trader dashboard → PROBE
      GRADUATION card, or `/autotrader/performance.goLiveMilestone`.
- [x] Exploration graduation still active at decision time (active Oct 24) (it auto-revokes
      if the trailing record turns negative — a revoked graduation resets
      this checklist).
- [x] No unresolved settlement/pricing incidents in the prior 14 days (Oct 24).

The milestone is evidence, not authorization: the owner makes the final
call after reading the full-size ledger.

## 2. Owner setup (manual — cannot be done by the bot)

- [x] **Polymarket US** account (Oct 28 2026: funded, $61.72 balance / $55.00
      buying power read by the worker) (the venue the owner chose on Oct 24 2026; the
      global Polymarket CLOB is not open to US persons). Create it in the
      Polymarket US app, complete identity verification, fund it with a
      starting bankroll of **$100–200 max** (an amount whose total loss is
      acceptable tuition). Use an account dedicated to the bot.
- [x] API key created at polymarket.us/developer (Oct 28 2026; the snapshot
      reads `executor.account.configured: true`) (Key ID + Secret Key, shown
      once) and pushed as **repo secrets** `PMUS_KEY_ID` / `PMUS_SECRET_KEY`
      via `.github/workflows/push-polymarket-us-key.yml`. Credentials are
      never pasted in chat, code, or config files. The snapshot's
      `executor.account.configured` confirms the worker has them.

## 3. Trade executor (engineering)

Built Oct 24 2026 (`src/executor.js`); the dry run consumes the paper lane's
intents every cron. Before live trading:

- [x] Build the executor (Oct 24 2026, `src/executor.js`): consumes intents,
      routes each to the Polymarket US moneyline (`src/polymarket-us.js`),
      builds the exact FOK limit (YES-price convention, tick-rounded,
      contracts), walks the live book for the fill, charges the venue fee,
      evaluates every live gate, records the result, and fails closed (stale
      intents, no book, unroutable market). `POST /autotrader/executor/halt`
      is the kill switch.
- [x] Live adapter built (Oct 24 2026, same PR): inert until paperTradeMode
      is false AND the Polymarket US key is pushed. Then it consumes the live
      exec queue, places the FOK limit (entries) or close-position (exits)
      with synchronous execution, confirms fills to the auto-trader, and on
      any ambiguity after a send reconciles against the account position or
      halts itself. Trades with no Polymarket US market (a league outside the
      map in `src/polymarket-us.js`, spreads/totals/handicaps, game or map
      winners) are skipped, never routed elsewhere.
- [x] Maker mode (Oct 27 2026): entries rest post-only at the best level with a
      20-minute good-till-date and fall back to a taker FOK; the shadow ledger's
      50-trade read (maker beat taker by ~$10 on the filled 52%) asked for it.
      The dry run now measures resting fills, misses and the taker alternative
      side by side (`executor.maker`, `roundTrips.makerMinusTakerOnFilled`).
- [ ] Dry-run it against the queue in paper mode for ≥ 1 week (started Oct 24
      2026; `GET /autotrader/executor`, snapshot key `executor`): place no
      orders, log what it *would* have done on Polymarket US, diff against
      paper fills (`roundTrips.dryMinusPaper`), and read `routing.unroutable`:
      the share of the bot's entries that have no Polymarket US market at all.

## 4. First-live configuration (applied via apply-config workflow)

```
paperTradeMode: false
fixedSize: 5            // half of proven paper size to start
maxDailyTrades: 10
maxDailySpend: 50
dailyLossLimit: 15      // ~3 losses stops the day
vegasEdgeEntries: true  // stays PAPER-ONLY by code until separately proven
```

- [ ] Kill switch verified reachable before the first order: emergency stop
      endpoint + flipping `paperTradeMode` back via apply-config.
- [ ] Agent Crew back on Claude Opus (owner's call, Oct 2026: Haiku while
      paper, Opus once live). In `src/crew-llm.js` set `MODEL` to
      `claude-opus-5-5` and `PRICE_IN`/`PRICE_OUT` to its rates ($4 / $20 per
      MTok), restore the refusal fallback (`fallbacks: "default"` + the
      `server-side-fallback-2026-07-01` beta header), and raise
      `CREW_LLM_DAILY_USD` (Opus is ~40x the cost: ~$0.05-0.10 per debate).
      Revisit `INVESTIGATION_DAILY_USD` (cut to $1 while credits were tight).
- [ ] Owner monitoring: check the dashboard daily for the first two weeks.

## 5. Scale-up rule

Size increases only on the **live** ledger's own proof: after 30 settled
live trades with positive ROI, raise `fixedSize` one step ($5 → $10).
Never scale on paper results again — paper's job ends at first live fill.

## Rollback

Any of: dailyLossLimit hit twice in a week, graduation revoked, a pricing
incident, or the live ledger 15+ settled with ROI below −10% → flip
`paperTradeMode: true` the same day, investigate on paper.
