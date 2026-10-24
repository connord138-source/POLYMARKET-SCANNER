# Go-Live Checklist — real-money trading

Status: **NOT AUTHORIZED — milestone met Oct 20 2026; executor dry run started Oct 24 2026; owner decision pending.**
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

- [ ] Polymarket account with a dedicated wallet — never a personal main
      wallet. Fund with USDC on Polygon; starting bankroll **$100–200 max**
      (an amount whose total loss is acceptable tuition).
- [ ] Wallet private key / Polymarket API credentials pushed as **repo
      secrets**, delivered to the worker via a `wrangler secret put`
      workflow (same pattern as `push-anthropic-key.yml`). Credentials are
      never pasted in chat, code, or config files.

## 3. Trade executor (engineering — does not exist yet)

The worker only maintains an execution queue (`/autotrader/exec-queue`);
nothing currently consumes it. Before live trading:

- [x] Build the executor (Oct 24 2026, `src/executor.js`): consumes intents,
      builds the exact FOK order (tick-rounded price, shares), walks the live
      book for the fill, charges the fee, evaluates every live gate, records
      the result, and fails closed (stale intents, no book, no token id). The
      live adapter (signing and sending the order) is deliberately absent:
      the global Polymarket CLOB is not open to US persons, so the venue for
      real orders (Polymarket US / Kalshi) is the owner's decision and comes
      with its own API work. `POST /autotrader/executor/halt` is the kill
      switch.
- [ ] Dry-run it against the queue in paper mode for ≥ 1 week (started Oct 24
      2026; `GET /autotrader/executor`, snapshot key `executor`): place no
      orders, log what it *would* have done, diff against paper fills
      (`roundTrips.dryMinusPaper`).

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
