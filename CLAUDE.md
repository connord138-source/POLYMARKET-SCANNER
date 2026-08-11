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
- `src/at-learning.js` — confidence scoring (`calculateConfidence`),
  factor stats, combos, pattern discovery.
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
