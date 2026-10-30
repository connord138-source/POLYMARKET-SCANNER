# EDGERUNNER — polymarket-scanner (backend)

Cloudflare Worker backend for edgerunner.vip: Polymarket whale-signal scanner,
paper auto-trader, AI learning system, and Vegas-odds edge detector.
Cron runs every 5 minutes. Frontend lives in the separate
`connord138-source/edgerunner-frontend` repo (Vite/React, Cloudflare Pages).
Frontend words (Oct 28 2026): `src/lib/pageGuide.js` there holds every
page's sidebar label, title, purpose and "How to read this page" bullets
plus the glossary; `Home` (Today) is the member front door and `Help` (How
it works) the public explainer. Change the words there, not in the pages.

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
  Open-position caps are per lane (Oct 27 2026, `laneOpenCount`): the main
  lane counts only its own positions against `maxOpenPositions`; Forge has
  `forgeMaxOpen` (10) and Crew `crewMaxOpen` (10). The cap used to be shared
  and Forge's long-dated holds starved the main lane.
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
- `src/copy.js` — followed wallets and copy a whale (Oct 30 2026): one list
  (`copy_wallets`), each wallet in mode `follow` (tracked: its bets as they
  happen in `copy_recent:<addr>`, Polymarket's book, and the P&L since it was
  added via `bookAtAdd`) or `copy` (all that, and paper copies). Added by
  `POST /agents/copy/wallets` (admin; the Followed wallets page, the Follow /
  Copy buttons on the wallet modal and lookup page, or
  `.github/workflows/copy-wallet.yml`); `POST /agents/copy/wallets/mode`
  flips a wallet (to copy starts the copy clock now). Each 5-min cron
  (`pollCopyWallets`, `cronStatus.copy`) reads every followed wallet's newest
  data-api trades; for a copied wallet it queues each fresh BUY of
  `copyMinWhaleUsd` ($500) or more; `enterCopyPicks` in
  autotrader.js fills it at the live Gamma price in its own lane
  (`strategySource 'whale_copy'`, `copyBetSize` $5 paper, `copyMaxOpen` 10,
  `copyMaxPerDay` 10, skipped when the price ran `copyMaxSlipPts` above what
  the wallet paid), holds to resolution and leaves when the wallet sells,
  redeems or merges (`mirrorWhaleExit`, exit type `whale_exit`). A wallet is
  copied from the moment it is added; its history is not replayed. `GET
  /agents/copy` (snapshot key `copy`) carries each wallet's record, the
  ledger's skill row and Polymarket's book (the on-chain refresher pulls
  copied wallets first). Paper only; the live flip is the operator's.
- `src/execution.js` — execution shadow ledger: every paper entry records the
  live CLOB book + Gamma `feeSchedule` and tracks a taker fill (ask + fee) and
  a resting-bid maker fill (filled only if the tape prints at/below the bid
  within `execShadowTtlMin`; earns the rebate), settled on the real exit.
  KV `exec_ledger`; `GET /autotrader/execution`. The paper ledger itself pays
  no spread or fees — read go-live numbers against the taker ledger.
- `src/executor.js` — trade executor, DRY RUN (Oct 24 2026, GO-LIVE section 3).
  While `paperTradeMode` is on, every main-lane paper entry and exit is queued
  as an intent (KV `executor_intents`); each 5-min cron consumes them against
  the live CLOB book, builds the FOK order it would send (tick-rounded price,
  shares), walks the book for the fill, charges the taker fee, evaluates the
  live gates (min size, slippage cap, daily caps, loss limit) and records it
  (KV `executor_fills`). `GET /autotrader/executor` diffs round trips against
  the paper ledger (`dryMinusPaper`); `POST /autotrader/executor/halt` is the
  kill switch (admin). Snapshot key `executor`. Venue (owner's choice, Oct 24
  2026): **Polymarket US** - every intent is routed league -> moneyline ->
  long/short side (`src/polymarket-us.js`) and priced on that book with its
  0.0695 x p(1-p) fee, `clobRef` keeps the global-CLOB fill for comparison,
  unroutable intents (unmapped league, spreads/totals/handicaps, game or map
  winners, combos) are recorded with the reason. Live path: only when `paperTradeMode` is false AND `PMUS_KEY_ID` /
  `PMUS_SECRET_KEY` are set (push-polymarket-us-key.yml); it consumes the
  live exec queue, sends a FOK limit (YES-price convention) or
  close-position with synchronous execution, confirms fills through
  `handleExecConfirm` (position carries `venue/usSlug/usSide`), reconciles an
  ambiguous send against the account position and halts itself if that fails.
  Maker mode (Oct 27 2026, `executorOrderMode: 'maker'`, built after the
  shadow ledger's 60 settled trades read maker > taker by $10 at a 52% fill
  rate): a BUY entry rests post-only at the best level on our side of the US
  book (good-till-date = `executorMakerTtlMin`, 20) instead of crossing;
  dry fills it when the market trades through the level or a print lands
  there (public `/bbo`: best bid/ask, last trade, shares traded), and at the
  TTL falls back to a taker FOK (`executorMakerFallback`, or 'skip'); the
  FOK it would have sent at placement is kept as `takerRef`, so the report's
  `maker.savedVsTakerUsd` / `roundTrips.makerMinusTakerOnFilled` are the
  maker edge on filled trades and `maker.missed` the entries that never
  filled. Live: the GTD post-only order rests on the venue (queue status
  RESTING, polled each cron, canceled at the TTL, cancel failures halt).
  Exits stay taker. Polymarket US pays no maker rebate below $10M monthly
  maker volume (fee schedule Oct 19 2026), so `executorMakerRebateCoef` is 0.
- `src/polymarket-us.js` — Polymarket US client: Ed25519 signature over
  `${tsMs}${METHOD}${pathname}` (no query/body) in X-PM-Signature, key id in
  X-PM-Access-Key; gateway.polymarket.us (public: league events, market by
  slug, book) vs api.polymarket.us (orders, positions, balances); routing
  (`LEAGUES`: global slug prefix -> US league list, Oct 25 2026 covers the
  US big four + CFB/WNBA/CBB, tennis atp/wta/itf, UFC/boxing, esports
  lol/cs2/dota2/valorant/cod, ~45 soccer leagues; `marketKind` keeps
  totals/spreads/handicaps/game winners out; `legOfIntent` turns NO on
  "Will X win" into X's other side; big-four names go through xvenue's
  `teamMatch`, everything else through `nameScore` (normalized tokens,
  exact beats subset); soccer is one Yes/No market per team, so
  `slimEvents` rows carry a slug per side (`drawable`)),
  `usLevels` (effective-price levels for long/short x buy/sell),
  `buildUsOrder`, `fillFromExecutions`. 25 req/s per IP; 429 -> 1s retry.
- `src/xvenue.js` — Kalshi + Polymarket US vs global Polymarket live-game
  sampler on the minute cron (`"* * * * *"` runs only this): matched game
  sides -> D1 `xvenue_quotes` (k_*, p_*, us_* columns); `GET /xvenue/report`
  = do the US-legal venues lag global Polymarket in-game enough to clear their
  taker fees (`staleRate`/`staleUsRate`, `avg*EdgeC`) and does Kalshi ever
  cross Polymarket US after both fees (`kUsCross`). `boot` shows the last
  stage the minute cron reached (`xv_boot`). Pregame scans
  (Oct 2026) found no cross-venue or neg-risk arbitrage — see
  `docs/PROFIT-AVENUES.md` Part 2 before proposing structural-arb features.
  The sampler reads Polymarket US from `/v1/markets/{slug}/book` (top of
  book + shares shown, `us_bid_qty`/`us_ask_qty`), falling back to `/bbo`.
- `src/us-lane.js` — Polymarket US stale-quote **paper** lane (Oct 17 2026):
  in-game, the US book lagged global Polymarket by more than its taker fee on
  ~20-30% of 3c+ minute moves (NHL/NBA/CFB). The sampler's `afterSample` hook
  logs a hypothetical taker fill at the sampled US quote for every such
  minute (D1 `us_lane_events`, KV `xv_prev` holds the previous minute), the
  minute cron marks events against global Polymarket's mid at +1/+5/+15/+60
  min and end of game, the 5-min cron settles them through Gamma
  (`cronStatus.usLane`). `GET /xvenue/uslane?hours=168` (snapshot key
  `usLane`): m*/final/settle are cents per share after the entry fee with
  exit costs not charged; `x5`/`x15` are the round trip closed on the US
  book (spread paid, exit fee charged), i.e. what a scalping lane would book.
  Week 1 (Oct 19): the stale quote is right for minutes, flat by settlement
  on tradable size. Decision rule: ~200 events with the round trip (or
  settle) positive on the tradable subset at a >50% hit rate before a
  real-money lane is proposed; that flip is the operator's call. Places no
  orders.
- `src/crypto-fv.js` — crypto fair value: every Polymarket BTC/ETH/SOL price
  contract ("above $X on <date>" = European digital; "dip to"/"reach" =
  one-touch via reflection) priced from Coinbase realized vol (7d/30d/90d,
  30d is the model sigma). KV `crypto_fv`, refreshed at the top of each cron;
  `GET /crypto/fairvalue` (snapshot key `cryptoFv`); scan signals on those
  markets carry `cryptoFv` (modelSide vs paid for the whale's side). The
  frontend Crypto Lab re-prices client-side (src/lib/cryptoFv.js). Kraken and
  Coinbase throttle the candle endpoints a few times a day: a throttled asset
  reuses its last good vols (KV `crypto_fv_assets`, up to 48h) with a fresh
  ticker spot and is flagged `stale` instead of dropping out. Calibration
  Oct 2026: median |gap| 1.4c on liquid BTC contracts; far-dated tails trade
  7-12c above the lognormal — a tail gap is a model warning, not an edge.
- `src/kalshi.js` — signed Kalshi API client (Ed25519 or RSA-PSS over
  `timestamp + METHOD + /trade-api/v2/path`, query stripped). Secrets
  `KALSHI_API_KEY_ID` + `KALSHI_PRIVATE_KEY` (PEM) are pushed by
  `.github/workflows/push-kalshi-key.yml` (operator creates the key at
  kalshi.com/account/profile). Without them Kalshi 429s most calls from
  Cloudflare's shared egress and `xvenue_quotes.k_*` stays empty;
  `xvenue.last.kalshiAuth` in the snapshot shows which mode is active.
- Accounts + billing (Oct 2026): `src/auth.js` verifies Supabase access
  tokens (HS256 via `SUPABASE_JWT_SECRET`, or ES256/RS256 via the project's
  JWKS at `SUPABASE_URL`); `src/tiers.js` holds PLANS (free / pro $19
  founding → $29 / desk $49), `ROUTE_POLICY` (which routes need which plan,
  which are trimmed for Free via `degradeFor`) and `planOf`; `src/billing.js`
  is Stripe without the SDK (Checkout, portal, signed webhook at
  `POST /billing/webhook`, entitlements in KV `ent:<userId>`, founding-seat
  counter); `src/business.js` is the operator view (`GET /admin/business`:
  subscribers, MRR, sign-ups via service role, affiliate clicks from
  `/go/:venue`, waitlist). `GET /me`, `POST /billing/checkout|portal`,
  `GET /public/record` (landing page proof). Enforcement is behind the
  wrangler var `AUTH_GATE` ("off" until the sign-in frontend is live); admin
  token bypasses it, and the snapshot job sends ADMIN_TOKEN. Secrets via
  `.github/workflows/push-billing-keys.yml`; price ids in wrangler.toml.
  The Stripe account is SpecScan LLC, shared with the owner's other product
  (owner's choice, Oct 25 2026): the five EdgeRunner prices live there, the
  EdgeRunner products carry statement descriptor EDGERUNNER.VIP, every
  Checkout session and subscription is tagged `metadata.app=edgerunner` and
  the webhook ignores untagged objects (`isOurs`, so SpecScan sales never
  mint entitlements or burn founding seats), and `STRIPE_PORTAL_CONFIG` is
  EdgeRunner's own Customer Portal configuration. SpecScan's webhook sees
  EdgeRunner events too but matches no profile row, which is harmless.
- `src/odds.js` — The Odds API client (KV-cached; `ODDS_API_KEY` secret, pushed
  by `.github/workflows/push-odds-api-key.yml` from the repo secret of the same
  name). The edge scanner pauses under 150 credits remaining (`crew.oddsApi`
  in the snapshot shows the count); the Oct 29 2026 key read 48 of 500 (free
  tier) until the owner renewed the 20k plan.
- `src/wallet-ledger.js` — point-in-time wallet skill in D1 (`signal_wallets`
  joined to `signals_log`): excess = win rate minus average entry price over a
  wallet's settled bets, trusted from `LEDGER_MIN_N` (10). `GET /wallets/ledger`
  is the raw ranking; `GET /wallets/leaderboard` (Oct 29 2026, snapshot key
  `walletLeaderboard`) merges it with the KV running records (`wallet:<addr>`,
  tiers, pending, streaks) for the Top wallets page via
  `buildWalletLeaderboard`, KV-cached two minutes. The page had asked for that
  path since it shipped while only `/learning/leaderboard` existed, so it read
  empty.
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
