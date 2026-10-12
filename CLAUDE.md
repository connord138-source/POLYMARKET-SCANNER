# EDGERUNNER — polymarket-scanner (backend)

Cloudflare Worker backend for edgerunner.vip: Polymarket whale-signal scanner,
paper auto-trader, AI learning system, and Vegas-odds edge detector.
Cron runs every 5 minutes. Frontend lives in the separate
`connord138-source/edgerunner-frontend` repo (Vite/React, Cloudflare Pages).

## Backend visibility for Claude sessions (READ THIS FIRST)

Claude Code remote sessions CANNOT reach
`https://polymarket-scanner.connord138.workers.dev` directly — the session
egress policy 403s that domain. Do not burn time curling it.

Instead, live backend state is snapshotted into **`status/backend.json`**
by the `Backend Snapshot` GitHub Action (`.github/workflows/backend-snapshot.yml`),
every 30 minutes and on demand. It contains: auto-trader config, lifetime
performance, daily + 14-day stats, open positions, AI intelligence summary,
last 30 decision-log entries, last 30 closed trades, learning stats/insights,
paper-strategy leaderboard, and live edge opportunities (`fetchedAt` marks age).

To get a FRESH snapshot from a session:
1. Trigger the workflow: GitHub MCP `actions_run_trigger` on
   `backend-snapshot.yml` (ref `main`) — or ask the user to run it.
2. Wait ~60s for the run to finish, then `git pull` / re-read
   `status/backend.json` from `main` via the GitHub MCP.

Commits from the snapshot job use `[skip ci]` and `deploy.yml` ignores
`status/**`, so snapshots never trigger worker deploys.

## Architecture

- `index.js` — main worker: routes, cron, scan pipeline, signal scoring,
  edge annotation, paper strategies, auto-trader glue
  (`adaptSignalForAutotrader`).
- `src/autotrader.js` — paper/live auto-trader: config (KV
  `autotrader_config`), entry gates, AI-learning gate (`useLearningData`),
  exit engine (stop-loss / trailing / take-profit / max-hold /
  whale-exit mirroring via `detectWhaleExits`), performance tracking.
  The proven-edge gate (gate 1b) carries a daily exploration floor
  (v21.3.0, `edgeExplorationTradesPerDay`): a strict edgeNet>0 requirement
  deadlocked the bot for six days in Aug 2026 when every entry band read
  mildly negative — a capped quota of half-size entries keeps the ledger
  learning even while the 14d rolling edge window (`EDGE_WINDOW_DAYS`,
  `edge_profile_v2`) reads cold, so a recovering band can requalify.
- `src/at-learning.js` — confidence scoring (`calculateConfidence`),
  factor stats, combos, pattern discovery.
- `src/crew.js` — Agent Crew orders (chat box on the Agent Crew page):
  `POST /agents/crew/orders` sets a focus ("Focus CFB today"); while active,
  the cron hunts that sport's pregame moneylines (Gamma by sport tag) vs the
  books' devigged consensus, the persona council debates the biggest gaps,
  and non-vetoed picks are paper-entered by `enterCrewPicks` (own lane,
  `strategySource: 'crew_hunt'`, filled at the ask). `GET /agents/crew`.
  `src/crew-llm.js` is the reasoning: a Claude "chief" answers the chat and
  returns a structured order change (code validates and applies it), and a
  per-sweep debate where the personas argue the top plays and a chair rules
  (its verdict decides what is queued). Runs on `claude-haiku-5-5` (operator's
  choice for cost); own daily cap `CREW_LLM_DAILY_USD` (default $1); falls
  back to the keyword parser / rule council. The investigator shares the
  Anthropic account (`INVESTIGATION_DAILY_USD`, $1 since Oct 2026). ESPN only
  serves DraftKings odds to US clients, so the page computes the DraftKings
  board in the browser and POSTs it to `/agents/crew/dk-board`.
- `src/execution.js` — execution shadow ledger: every paper entry records the
  live CLOB book + Gamma `feeSchedule` and tracks a taker fill (ask + fee) and
  a resting-bid maker fill (filled only if the tape prints at/below the bid
  within `execShadowTtlMin`; earns the rebate), settled on the real exit.
  KV `exec_ledger`; `GET /autotrader/execution`. The paper ledger itself pays
  no spread or fees — read go-live numbers against the taker ledger.
- `src/xvenue.js` — Kalshi vs Polymarket live-game sampler on the minute cron
  (`"* * * * *"` runs only this): matched game sides -> D1 `xvenue_quotes`;
  `GET /xvenue/report` = does Kalshi lag Polymarket in-game enough to clear
  its 7%·p(1−p) taker fee (`staleRate`, `avgStaleEdgeC`). Pregame scans
  (Oct 2026) found no cross-venue or neg-risk arbitrage — see
  `docs/PROFIT-AVENUES.md` Part 2 before proposing structural-arb features.
- `src/odds.js` — The Odds API client (KV-cached; `ODDS_API_KEY` secret).
- `src/gamma.js` — Gamma API settlement (`findGammaMarket` handles
  closed markets + multi-market moneyline preference).
- D1 database `polymarket-scanner` — settled signals (`signals` table);
  KV namespace `SIGNALS_CACHE` — cache + auto-trader state.

## External APIs

- Polymarket data-api / Gamma / CLOB (public).
- The Odds API (paid, $30/20k credits) — devig by normalizing implied probs.

## Conventions

- Deploys: push to `main` → `deploy.yml` (wrangler-action) deploys the worker.
- Admin endpoints require `ADMIN_TOKEN` (fail-closed).
- Development branch for Claude sessions: see the session's designated
  branch; PR → squash-merge to `main`.
- Monetization research (Oct 2026): `docs/PROFIT-AVENUES.md` ranks every
  non-betting profit route on Kalshi/Polymarket (affiliate programs, Kalshi
  Builder Codes via DFlow, builder grants, Polymarket US ISV vendor fees,
  data resale) with sources and the US-legality of each. Read it before
  proposing a new revenue feature.
