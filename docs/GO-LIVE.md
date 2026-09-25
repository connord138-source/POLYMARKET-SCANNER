# Go-Live Checklist — real-money trading

Status: **NOT AUTHORIZED — milestone pending.**
The bot stays in paper mode until every box below is checked, in order.

## 1. The evidence bar (automatic — tracked live)

- [ ] **Go-live milestone met**: ≥ 30 settled *full-size* graduated entries
      (`graduatedEntry` flag — honest live-priced fills by construction)
      with positive total PnL. Progress: Auto-Trader dashboard → PROBE
      GRADUATION card, or `/autotrader/performance.goLiveMilestone`.
- [ ] Exploration graduation still active at decision time (it auto-revokes
      if the trailing record turns negative — a revoked graduation resets
      this checklist).
- [ ] No unresolved settlement/pricing incidents in the prior 14 days.

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

- [ ] Build the executor: a small service (or scheduled job) that polls the
      queue, places CLOB orders via the official Polymarket client, confirms
      fills back through `/autotrader/exec-confirm`, and hard-fails closed
      on any ambiguity.
- [ ] Dry-run it against the queue in paper mode for ≥ 1 week (place no
      orders, log what it *would* have done, diff against paper fills).

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
- [ ] Owner monitoring: check the dashboard daily for the first two weeks.

## 5. Scale-up rule

Size increases only on the **live** ledger's own proof: after 30 settled
live trades with positive ROI, raise `fixedSize` one step ($5 → $10).
Never scale on paper results again — paper's job ends at first live fill.

## Rollback

Any of: dailyLossLimit hit twice in a week, graduation revoked, a pricing
incident, or the live ledger 15+ settled with ROI below −10% → flip
`paperTradeMode: true` the same day, investigate on paper.
