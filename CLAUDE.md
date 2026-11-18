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
  Lane switches (Oct 31 2026, owner's "set the autotrader to wallet copy
  trades only, or copy trades along with crew trades"): `signalEntries`
  (the whale-signal lane and its Vegas-edge promotions; the main signal loop
  is skipped and `skipReasons['Whale-signal lane paused (lanes)']` counts
  the signals), `crewHuntEntries`, `copyEntries`, `forgeLaneEnabled`;
  `processSignals` reports `results.lanes`. Exits always run. The Auto-trader
  Config tab's LANES card edits them with COPY ONLY / COPY + CREW /
  EVERYTHING presets. The live executor still carries the main lane only
  (`enqueueIntent` on main-lane entries and exits); a copy-only real-money
  lane would need the copy lane's entries routed through the executor, and
  Polymarket US lists sports only, so most copied bets would be unroutable.
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
- `src/props.js` — player props (Oct 31 2026, owner's "track every possible
  prop for the best edge" and "ensure it's tracking player props for sports
  where Polymarket does have the props"). While a crew order is active each
  hunt runs `propsSweep` per ordered sport: the soonest `PROPS_MAX_GAMES` (10)
  games' player props from the US books through The Odds API
  (`/sports/{sport}/events/{id}/odds`, `PROP_MARKETS` per sport family, one
  credit per market per game, KV `odds_props:<event>` for `PROPS_TTL_S` 1h;
  the event list is free). `propFairs` devigs every book's two-sided quote on
  the same exact line and averages the books quoting it (`PROPS_MIN_BOOKS` 2);
  a one-way market (anytime TD "Yes") gets the lowest implied price as its
  fair, flagged `oneSided` (cut included, so compared but never paper-bet).
  Two boards from that fair: line shopping (`propRowsFromEvent`, best price
  per side scored per $100 like the DraftKings board; nothing settles) and
  Polymarket's own props (`fetchPolyProps` by Gamma `sports_market_types` per
  `POLY_PROP_TYPES`: NFL passing/rushing/receiving yards, receptions, pass TDs,
  anytime TD; NBA points, rebounds, assists, threes; CFB/NHL/MLB/WNBA/CBB list
  none) matched by stat + normalized player name + exact line (`polyPropRows`;
  a different line is `lineMismatch`), priced at the ask (`polyQuote`), edge =
  fair - ask. In crew.js a prop gap at the order's min edge that is not thin
  (`PROP_MAX_SPREAD` 10c) or one-sided joins the council after the moneylines
  (`PROP_DEBATE_TOP` 3, `kind: 'prop'`, readable `label`), queues with the
  label and is paper-entered by `enterCrewPicks` as `signalSubType
  'player_prop'` (outcome check against Over/Yes). `hunt.props` (`bySport`,
  `rows`, `poly.rows`) feeds the Prop board on the Agent Crew page, the chat
  report (`propsReportLine`) and the chief's state (`playerProps`). The pass
  pauses under `PROPS_CREDIT_FLOOR` (2500) credits and never marks the shared
  odds feed down on a prop-market error.
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
  copied wallets first). Cadence (Oct 31 2026, after a market maker's $4.9k
  buy was sold back six seconds later and the 5-min copy bought into its
  exit): the poll runs on the MINUTE cron (`copy_poll_last` is the last
  pass; the 5-min cron only reports it), reads 200 activity rows, keeps a
  rolling 3h buffer of the wallet's fills (`copy_fills:<addr>`, deduped by
  tx hash, so a bet split across polls adds up and a late-indexed fill still
  counts; `fillFromActivity`, `mergeFills`, `betsFromFills`), filters by the
  follow clock `sinceTs` (set at add / flip to copy, never advanced by a
  poll; `lastSeenTs` is display only now), records each bet once with
  `foundAt` and keeps its `usd`/`price` current, marks `soldUsd`/`soldAt`/
  `soldPx` from the wallet's later SELLs on the same side, and does not
  queue a bet the wallet has already sold `SOLD_OUT_SHARE` (half) of. Entry
  is also per minute: `enterCopyPicksNow` (autotrader.js) runs the shared
  `openCopyPick` gates and parks each new position in its own key
  `copy_inbox:<id>` (caps read the inbox too); `processSignals` adopts the
  inbox (`drainCopyInbox`) right after loading positions, before the exit
  checks, so the two crons never write the positions list together. Each
  copy carries `copyLagS` (seconds behind the whale's last fill) and
  `whaleAt`. `getCopyState` lists inbox copies as open and carries `poll`. A queued pick kept for the next try (a cap, the slip limit) is stamped by `copyWaitStamp` with `waitReason` / `waitCap` / `waitLive` / `waitAt` / `dropAt` (Nov 4 2026, owner's "show the daily limit reason on the queued rows"), and the Followed wallets page shows it on the row. Amounts (Oct 30 2026): `POST /agents/copy/settings` writes the lane's
  copy* config keys through `copySettingsUpdates` (stake default, smallest
  bet to copy, caps, slip, age; floors/ceilings in `COPY_SETTINGS`), and
  `POST /agents/copy/wallets/size` gives one wallet its own stake
  (`betSize`, carried on the picks it queues; `enterCopyPicks` uses it over
  `copyBetSize`). Both edited on the Followed wallets page (admin), which
  sits in the sidebar's Follow the money group and opens the wallet P&L
  card from each row. Paper only; the live flip is the operator's.
  Unseen bets (Oct 31 2026, "users should get an alert when they sign in and
  a tracked wallet has placed bets they have not seen"): each recent entry
  carries `foundAt` (the poll that found it); `GET /agents/copy/unseen`
  (per member: the admin token is member "admin", a Supabase user its id;
  401 otherwise) lists the bets found after the member's mark (KV
  `copy_seen:<member>`, `getUnseenBets`; a member who never looked gets the
  last `UNSEEN_FIRST_LOOK_H` 24h, `firstLook`), newest first with
  `count`/`wallets`/`usd`/`newestAt`/`perWallet`; `POST /agents/copy/seen`
  (`markCopySeen`, body `at` = the read the member saw, clamped to now; the
  one POST under /agents/copy that needs no admin token) clears it. The
  frontend's `useUnseenBets` feeds the sign-in toast (`UnseenBetsAlert` in
  Layout, told once per browser session per `newestAt`), the sidebar badge
  on Followed wallets, and that page's NEW tags, which mark seen on open.
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
  "Will X win" into X's other side; big-four and college names go through
  xvenue's `teamMatchScore` (graded, exact 100 beats a looser match, so a
  shared-prefix pair like Tulsa / Tulane routes to the exact side), everything
  else through `nameScore` (normalized tokens, exact beats subset); soccer is one Yes/No market per team, so
  `slimEvents` rows carry a slug per side (`drawable`)),
  `usLevels` (effective-price levels for long/short x buy/sell),
  `buildUsOrder`, `fillFromExecutions`. 25 req/s per IP; 429 -> 1s retry.
- `src/xvenue.js` — Kalshi + Polymarket US vs global Polymarket live-game
  sampler on the minute cron (`"* * * * *"` runs only this): matched game
  sides -> D1 `xvenue_quotes` (k_*, p_*, us_* columns); `GET /xvenue/report`
  = do the US-legal venues lag global Polymarket in-game enough to clear their
  taker fees (`staleRate`/`staleUsRate`, `avg*EdgeC`) and does Kalshi ever
  cross Polymarket US after both fees (`kUsCross`; `crosses`, Oct 30 2026,
  lists those minutes with next-row persistence, the US shares shown and the
  games they came from, since one game carrying most of a sport's crosses is a
  mis-mapped Kalshi leg). Pairing (Nov 8 2026): `teamMatch` alone passes
  both ways round for college names that share a three-letter start (Tulsa /
  Tulane: the sampler paired Kalshi's Tulsa leg with Polymarket's Tulane and
  read a 57c cross for 176 minutes), so `matchPairs` and `attachUs` pick the
  orientation with the higher `teamMatchScore` (`orientLegs`: exact 100, pro
  alias 50, college per-word 3 same / 2 abbreviation / 1 shared start) and
  skip a tie. `boot` shows the last
  stage the minute cron reached (`xv_boot`). Pregame scans
  (Oct 2026) found no cross-venue or neg-risk arbitrage — see
  `docs/PROFIT-AVENUES.md` Part 2 before proposing structural-arb features.
  The sampler reads Polymarket US from `/v1/markets/{slug}/book` (top of
  book + shares shown, `us_bid_qty`/`us_ask_qty`), falling back to `/bbo`.
  Edge cache (Nov 12 2026): the gateway's market data is served from
  Cloudflare's cache (`cache-control: public, max-age=30`, `cf-cache-status:
  HIT`, age up to 29s) while global Polymarket (CLOB POST /books) and Kalshi
  are read live, so until then a US quote up to 30s old sat next to a live
  global one and read as "the US book has not followed". Every US price read
  (sampler, fill probe, executor, `usGameQuote`) now goes through `freshUrl`
  (xvenue.js: a unique `_=` query string = a cache miss, the book as of now).
  Every US-lane, scalp, probe and stale-US number before Nov 12 2026 was
  measured against the cached copy; read the post-fix record (scalp
  `fresh`) and let the 168h windows roll past it before trusting them.
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
  orders. Kalshi hedge marks (Oct 30 2026, `kh0`/`kh1`, `hedgePnlC`): the
  same leg sold on Kalshi at its bid (for a buy) or bought at its ask (for a
  sell) as a taker, priced in the event minute and at the next sample, US
  entry fee plus Kalshi's taker fee charged; both venues pay on the same game
  so that P&L is locked, i.e. what a two-venue US-legal lane would book per
  share. Filled by the same marker from `xvenue_quotes.k_*` (backfilled on
  older events; NO_DATA where Kalshi was not quoted). Rule: kh1 positive on
  the tradable subset at a >50% hit rate over ~200 Kalshi-quoted events, and
  better than x5, before a hedged lane is proposed.
- `src/scalp.js` — the Polymarket US stale-quote SCALP lane (Oct 31 2026,
  owner's "build the US scalp lane", after the paper lane's week read x5
  +1.6c a share at 58% on 571 tradable events). Runs inside the minute
  cron's `afterSample` hook on the same events the paper lane logs
  (`recordUsLaneEvents` now returns `list`): `runScalpLane` first closes
  open scalps whose `scalpHoldMin` (5) has passed at this minute's US quote
  (buy -> bid, sell -> ask; `rtPnlC`, both taker fees; dry waits
  `scalpExitGraceMin` for a quote, then the last one seen), then enters this
  minute's events biggest edge first through `scalpEntryFor` (edge >=
  `scalpMinEdgeC`, `scalpMinQty` shown, 5-95c, `scalpMaxOpen`, one per game,
  `scalpMaxPerDay`, `scalpDailyLossUsd` stop; size = min(shown, `scalpMaxUsd`
  / cost) whole contracts; a sell event buys the SHORT side at 1 - bid).
  Modes (`scalpMode` in autotrader_config, sanitized by
  `sanitizeScalpUpdates` in `updateAutotraderConfig`): off / dry (default:
  decisions and fills at the sampled quotes, nothing sent) / live (FOK entry
  via `buildUsOrder`+`placeUsOrder`, exit via `closeUsPosition`, fills from
  executions, ambiguity reconciled on `usPositionQty`, else the lane halts
  itself; needs `pmusConfigured`, else runs dry with `liveBlocked`).
  INDEPENDENT of `paperTradeMode`. State: KV `scalp_open`, `scalp_day:<d>`,
  `scalp_last`, `scalp_recent`, `scalp_halt` (`POST /xvenue/scalp/halt`,
  admin); every closed scalp in D1 `scalp_trades` (migration 0012).
  `GET /xvenue/scalp?hours=168` (snapshot key `scalp`): mode, config, open
  with marks, today, `all`/`bySport`/`byKind`/`byMode` (n, hitRate, avgPnlC,
  pnlUsd, feesUsd, roiPct), recent. exitKind x5 | late_last_quote | no_quote
  | x_live | x_live_unpriced | settling. The Auto-trader page's SCALP LANE
  card shows it and (admin) sets the modes and sizes. The live flip is the
  owner's; the lane went in dry. LIVE since Nov 9 2026 (owner's "Yes, set it
  live for me"): config/autotrader.json carries scalpMode 'live',
  scalpKalshiMode 'off', scalpMaxPerDay 40, scalpMaxUsd 10, scalpMaxOpen 3,
  scalpDailyLossUsd 15, applied by the Apply Autotrader Config workflow. A
  live venue's daily loss stop reads the day's LIVE realized P&L
  (`day.livePnlUsd`, added on each live close), so the flip day's dry
  results neither hide a live loss nor stop live entries. First live order
  (Nov 10 2026 00:55 UTC): a FOK that did not fill came back with no
  executions, its state read failed, and the lane halted although nothing
  had filled (balance and positions unchanged). Since then `getUsOrder`
  unwraps the documented `{ order }` reply (the wrapped object had read as
  0 filled, which would have left a real fill untracked), and a failed
  state read is settled on the account position before halting: unchanged
  = not filled, moved = that fill; halt only if the position cannot be
  read. The halt itself is cleared by the owner (UN-HALT on the card).
  First live night (Nov 11-12 2026): 10 FOK entries sent, none filled (2
  read EXPIRED, 8 answered 404 on the state read: a finished FOK is not
  kept), and the lane halted at 01:03 UTC when a position read failed once.
  Cause: the US quotes were the gateway's cached copy (see xvenue.js), so
  the "stale" price had usually gone already. Since then position reads are
  tried three times (`positionQty`, `POSITION_RETRY_MS`), a flat position
  after the send is "not filled" even when the read before it failed, the
  day counts `liveSent` / `liveFilled` (US entries that reached the venue /
  filled), and `scalpReport.fresh` is the US record since
  `US_RECORD_SINCE` (all, byMode, bySport, probe), the one to read.
  Back to DRY on Nov 12 2026 (owner's "Dry first"): config/autotrader.json
  scalpMode 'dry' until the fresh record (~100 scalps on real-time prices)
  is read and the owner decides on live again.
  Dry acts as live (Nov 12 2026, owner's "It needs to be simulating the
  exact same way it would be acting if live"): a dry US entry used to fill
  at the sampler's quote for its whole size and close at the next sampled
  quote. Now `simEnter` builds the very order `liveEnter` sends (market
  status, venue minimum, tick-rounded limit via `buildUsOrder`) and matches
  it on the venue's book read at that moment (`fetchUsBook`, past the edge
  cache) with `matchFok` (polymarket-us.js, pure): the whole size at or
  better than the limit, levels taken best first, the fee per level, else
  no entry ('FOK would not fill (dry)'); `today.drySent` / `dryFilled`
  count them like `liveSent` / `liveFilled`. The exit is close-position on
  the book read at the hold (`simExit` + `matchClose`: whole position into
  the best levels, no limit; `x5`, or `x5_part` on a thin book with the
  rest held a minute; an empty side three minutes running is where live
  halts: `no_quote` unpriced, `today.wouldHalt`). Members' dry lanes run
  the same code. `runScalpLane({ drySim })` (default true) is a test
  switch; Kalshi dry still fills at the sampled quote (the venue is off).
  The record to read (`fresh`) starts at `US_RECORD_SINCE` (Nov 12 18:00
  UTC), after both fixes.
  Kalshi venue (Nov 1 2026, owner's "build the kalshi NHL scalp lane", after
  the sampler's stale-Kalshi read crossed its threshold for NHL: 298 moves,
  Kalshi still crossable after its fee on 9.7% at 8.4c): the sampler now
  passes each leg's `k_ticker`/`k_bid`/`k_ask` to the hook,
  `detectKalshiLaneEvent` (us-lane.js) applies the analyzeSeries stale-Kalshi
  rule per leg (every leg is its own Kalshi YES market, so both legs are
  examined; `recordUsLaneEvents` returns them as `kalshi`, not stored in D1),
  and `runScalpLane({ kalshiEvents })` scalps them on Kalshi's book: a stale
  ask bought as YES, a stale bid sold as YES (= buying NO at 1 - bid), closed
  there `scalpHoldMin` later (buy -> k_bid, sell -> k_ask), both Kalshi taker
  fees (0.07 x p(1-p)). Positions and `scalp_trades` rows carry `venue`
  ('us' | 'kalshi', null = us; migration 0013 adds `venue`, `k_ticker`).
  Config: `scalpKalshiMode` (off / dry default / live), `scalpKalshiMaxUsd`
  (10), `scalpKalshiSports` (['nhl']; empty = every sport). Caps: open and
  per-day per venue, the loss stop and the one-per-game rule across both, one
  halt. Kalshi sizes are not sampled: dry assumes the quote holds for the
  size; live (needs `kalshiAuthConfigured`, else dry with `liveBlocked`) sends
  immediate-or-cancel V2 orders (`kalshiPlaceOrder`, POST
  /portfolio/events/orders: bid = buy YES, ask = sell YES, fixed-point
  strings), fills from the create response, exit = reduce-only IOC 3c through
  the last quote (1c/99c after the grace period), partial exit fills close
  that part (`x_live_part`), an unfilled exit three minutes running halts the
  lane, ambiguity reconciled on `kalshiPositionQty`. Report: `modes`,
  `kalshi`, `byVenue`; the card shows both venue pills, a per-venue strip, a
  venue tag per scalp, and KALSHI MODE / $ / SPORTS settings. Rule for a live
  proposal: 200 dry Kalshi scalps positive after fees at > 50% hit, read by
  the daily routine; the flip is the owner's and needs the Kalshi keys
  (push-kalshi-key.yml).
- `src/scalp-accounts.js` — member scalpers (Nov 9 2026, owner's "he would
  have access to his own auto-scalper that he would connect his own
  polymarket us account to via his desk interface on our site", free, the
  site never holds or moves member money). A Desk member connects his own
  Polymarket US key (`POST /scalper/me/connect` {keyId, secretKey}): checked
  with a balance read on his key, sealed AES-GCM (HKDF from the worker secret
  `MEMBER_KEY_SECRET`, else `ADMIN_TOKEN`; the user id is the additional
  data; rotating that secret means members reconnect), KV
  `scalper_acct:<userId>` + index `scalper_accts`; never returned (only
  `keyTail`). The minute cron runs `runMemberScalpers` right after the
  owner's lane on the same stale US quotes: each member's lane is
  `runScalpLane(credsEnv(env, creds), { account: userId })`, i.e. the same
  code on his key (Kalshi never), with his own KV keys (`scalpKeys(userId)`:
  `scalp_open@<id>` etc.), the owner's lane rules (hold, min edge, shares
  shown, sports) and his own size / open / daily cap / loss stop within
  `MEMBER_LIMITS` (`memberConfig`); D1 rows carry `account` (migration
  0015; the owner's report reads `account IS NULL`), no fill probe. LIVE for
  a member only when the owner allows it (`POST /scalper/accounts/live`
  {userId, liveAllowed}, admin; `effectiveMode` runs a live pick dry with
  `liveBlocked` until then). Member routes (`/scalper/me*`, signed in + Desk
  plan, `scalperMember` in index.js): GET state (`memberState`: his account,
  balance refreshed once a minute, key errors, his lane slim), POST connect /
  settings {mode off|dry|live, maxUsd, maxOpen, maxPerDay, dailyLossUsd} /
  resume (clears his own halt) / disconnect (refused while a scalp is open:
  switch Off first). `GET /scalper/accounts` (admin) lists them; snapshot
  key `scalpers` (no emails or keys, user id cut to 8). Pending the owner's
  question to Polymarket US on third-party use of a member's key. Also fixed
  that day: `runScalpLane` returned before the exits when every venue was
  off, stranding open scalps. Tests: test/scalp-accounts.test.mjs (29).
- `src/fill-probe.js` — the fill probe (Nov 2 2026, owner's "Lets do it!").
  The dry record assumes the order fills at the quote the sampler saw once a
  minute; a live order goes out seconds later and stale quotes get picked
  off. So every DRY scalp entry (both venues) re-reads the venue's book right
  away (t0, `usTopOfBook(slug, { fetchImpl })` for Polymarket US with shares
  shown; `kalshiOrderbook` in kalshi.js for Kalshi, YES bids and NO bids with
  counts, so Kalshi sizes exist here) and again `PROBE_DELAY_MS` (10s) later
  (t1): `probeRead` (pure) says whether the entry price is still quoted on
  our side (`there`), with at least the scalp's size (`enough`, null without
  sizes), the contracts left (`qty`) and the move against us in cents
  (`moveC`). `runFillProbe` reads all of a minute's entries in parallel with
  one shared wait (the minute cron runs ~10s longer on minutes with entries);
  results sit on the position as `probe` and travel onto the `scalp_trades`
  row (`probe` JSON, migration 0014). `scalpReport.probe` =
  `summarizeProbes` per venue: t0/t1 `{ n, read, there, thereRate, enough,
  enoughRate, qtyMed, goneAvgMoveC, avgS, noBook, pnlThere, pnlGone }`; the
  card shows it in one line. `pnlThere` / `pnlGone` (Nov 5 2026) split the
  closed scalps' dry result by that look's answer (n, wins, hitRate,
  avgPnlC, pnlUsd, roiPct): a live order only fills where the price is still
  there, so t0 `pnlThere` is the record to read for a live flip, not the
  whole dry record (the 27 most recent US scalps read -0.25c a share where it
  was there and +21.3c where it was gone). Rule: a live flip of a venue is only worth it when t0 thereRate is
  high (say 70%+) with the size there; a low t1 rate says the edge is
  short-lived and a faster sampler would be needed first. Live entries are
  not probed (their fill is the evidence).
- `src/cross-lane.js` — Kalshi against Polymarket US, tested AS LIVE, dry
  only (Nov 16 2026, owner's "go, build the two-venue dry test", after the
  sampler's clean 48h read 34 of 508 crossing minutes still there a minute
  later). The minute cron's `afterSample` hook starts `runCrossLane` first,
  beside the scalp lane. A sampled cross of `CROSS.minEdgeC` (1c a share
  after both taker fees; `crossCandidates`: `us_k` = the team on Polymarket
  US at its ask + Kalshi NO at 1 - bid, `k_us` = Kalshi YES at its ask + the
  other US side at 1 - bid; either pair pays $1 a share whoever wins) is a
  candidate; `pickCandidates` takes three a minute, one per game, a leg and
  direction once per 5 minutes, 12 looks a game a day (KV `cross_state`).
  t0: both real books read at the same moment (`fetchUsBook` past the edge
  cache, `kalshiBookLevels` = Kalshi's whole book, bids only, a NO bid at p
  is a YES offer at 1 - p) and `planCross` walks both ask sides together,
  taking every share that still locks `minLockC` (1c) after the market's own
  US fee and Kalshi's, up to `stakeUsd` ($25 a pair), whole contracts, at
  least `minShares` (5); none = `gone_t0` / `thin_t0`, no trade. t1: both
  read again right away, standing in for the two fill-or-kill orders
  arriving (`matchPair`: the US leg is the order `buildUsOrder` would send,
  matched by `matchFok`; the Kalshi leg walks its levels, the fee rounded up
  to the cent per level): both fill = `filled` (locked, pnl = shares less
  both costs and both fees, held to the end of the game), one = `legged_us`
  / `legged_kalshi` (sold straight back into that book read, the exit fee
  paid: `unwindLeg`), neither = `killed`. t2 (`delayMs` 5s later, one shared
  wait): still there or not (`t2_both`). `checkCrossHedges` (minute % 5 == 2)
  compares the two venues' mids over the game's `xvenue_quotes` rows:
  `hedge_ok` 1 = the same proposition, 0 = a mis-mapped leg (far apart or
  moving opposite ways; left out of the money as `mismatched`), -1 = too few
  rows. D1 `cross_events` (migration 0017, `CROSS_SCHEMA`); `GET
  /xvenue/cross?hours=168` (snapshot key `cross`): looked, byVerdict, sent,
  filled {n, games, pnlUsd, stakedUsd, avgLockC, hedge}, legged, killed, net
  {pnlUsd, roiPct, perSentUsd, fillPct, leggedPct, tGames (each game counted
  once)}, edge {sampledC, realTopC, plannedC, bookedC}, timing {avgLagS,
  avgGapMs, stillThereAfterDelayPct}, bySport / byDir / byDay / games /
  recent, `last` (KV `cross_last`). The rule is fixed in `CROSS` (version 1);
  changing it bumps the version. wrangler `CROSS_LANE` "dry" | "off". There
  is NO live path in the file; a real two-venue lane is the owner's call
  after the record (and needs Kalshi order keys plus money on both venues).
  Not modelled: the read-to-order latency below the t0-t1 gap, and a game
  the two venues settle differently (a tie, a postponement). Tests:
  test/cross-lane.test.mjs (54).
  First night (Nov 17 2026, five NBA games): 9 sampled crosses of 1c+
  (average 2.5c) looked at about 3 seconds after the sample, all 9
  `gone_t0`: read at the same moment the two real books were on average
  3.5c short of crossing, including the one the sampler called persisted
  (Magic vs. Celtics, 5.5c then 4.3c on consecutive minutes: -5.2c and
  -4.9c on the real books). So the sampler's crosses are, so far, the
  seconds between its Kalshi read and its US read, not prices two orders
  could take. Since that day each row also keeps the cheapest real offer on
  each venue at t0 (`real_us_px` / `real_k_px`, migration 0018; report
  `drift.usC` / `drift.kalshiC` = cents above the sampled price), to say
  which venue's sampled quote had already gone.
  Second night and the cause (Nov 18 2026): 34 looks over NBA, NHL and
  college football, 34 `gone_t0`. On the 25 with the readout the US offer
  was where the sample had it (drift 0.02c) and Kalshi's was 8.6c away
  (5-9c on most, 13-26c on hockey goals). The sampler read its venues one
  after another: Kalshi first, then Polymarket, then Polymarket US one
  game at a time, so the Kalshi quote was seconds older than the US one,
  and a score landing in between read as a cross. The sampler now reads
  the three at the same moment (xvenue.js `readKalshi` / `readPoly` /
  `readUs` under one Promise.all, US games `US_PARALLEL` 10 at a time;
  `status.readMs` and `skewMs` in `xvenue.last`). The same ordering made
  Kalshi look stale against Polymarket (`staleKalshi` ran 11-13% of moves
  in every sport), so every sampler number that compares Kalshi with
  another venue before Nov 18 2026 is that artifact, the NHL "Kalshi lags"
  read of Nov 1 included; read them only on windows that start after it.
  THE US FEE (found building this, Nov 16 2026): every Polymarket US market
  now states `feeCoefficient` 0.095 (NFL, NBA, NHL, CFB all read that day);
  it was 0.0695 through October. The executor and the scalp lane's
  dry-as-live fills already charged the market's own coefficient, but the
  sampler's constants did not: `US_TAKER_RATE` (xvenue.js) and `PMUS_FEE`
  (polymarket-us.js) are 0.095 since that day. So the sampler's stale-US and
  Kalshi-vs-US cross numbers before it were about 0.6c a share too kind at
  mid prices (the "34 persisted at 2.2c" read included), `us_lane_events`
  rows marked before it carry the old fee in their marks (the 168h window is
  clean of them from Nov 23 2026), and a taker round trip on Polymarket US
  costs about 5.7c a share at mid prices, not 4.5c. `xvenueReport` computes
  at read time, so its numbers are right from the deploy on.
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
- `src/kalshi-crypto.js` — the US venue for the Crypto Lab (Oct 30 2026).
  Polymarket US lists sports only, so a US client trades a crypto view on
  Kalshi: `KX{BTC,ETH,SOL}D` ("BTC price on Oct 30 at 5pm EDT?", one event
  an hour, $500 strikes, the 12am/5pm events open a day ahead) matches
  Polymarket's "above/below $X on <date>" (noon ET; the noon event itself
  once it opens, else the nearest open hour, `settleHours` stated), and
  `KX..MAXMON/MINMON` (monthly one-touch, month end) matches "reach/dip to
  $X in <month>". `getUsBoard` (KV `crypto_us_board`, 10 min, stale kept
  6h; public endpoints, signed when Kalshi keys exist) + pure `matchUsVenue`
  / `attachUsVenue`; every `/crypto/fairvalue` row carries `us` (ticker,
  strike, side, match same|near, settles, Kalshi's yes bid/ask) or null, the
  blob `us.listed`. Prices come back as `*_dollars`, volume as `*_fp`.
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
  The sports edge scan (`scanEdges`, KV `edge_opportunities`) is throttled
  to ~14 min for credits and FREEZES each row's entry (polyPrice / edgeNet /
  vegasProb) at detection so settlement pays at the booked price; since Oct
  30 2026 `repriceEdgeOpportunities` runs every 5-min cron and refreshes the
  open pregame rows' venue side from the free books (Gamma for global,
  the US gateway's top of book on the side taken via `usLong` for US rows)
  into `lastPolyPrice` / `lastEdgeNet` / `pricedAt`, and the books' side
  from the odds cache the scan already paid for (`devigH2H`, the same
  preferred-book devig as detection; `lastVegasProb` / `lineUpdatedAt` /
  `lineCheckedAt`, `lineMissing` when the game left the cache)
  (`cronStatus.lastRun.edgeReprice`, route field `lastPrice`). The pages
  show that live view, keep the entry as "booked at", and call a row whose
  line has not been confirmed for 45 min, or whose price moved 3+ points on
  an old line, "check the line" instead of value (frontend
  `src/lib/edges.js`): on Oct 30 a Pacers row carried a 30-hour-old 39%
  line while injury news took the market from 34c to 27c.
  Offers, not displayed prices (Nov 4 2026, owner's "when there are no
  active bids dont show that as value": an untraded CBB market listed
  Virginia Tech at 86c with nobody selling it, and the Odds page showed an
  8% value bet). Every value check prices a side at what a buyer pays:
  global Polymarket through `gammaSideQuote` (gamma.js; Gamma's bestAsk for
  outcome 0, 1 - bestBid for outcome 1, nothing when closed / not accepting
  orders), Polymarket US through `usGameQuote`'s `cost` (ask on the long
  side, 1 - bid on the short side, no longer the mid as a fallback). A side
  with no offer carries `noAsk` and gets no edge (`edgesAgainstVegas` /
  `payOf`), the scanner does not book it (global rows are now booked at the
  ask), a game priced only from the trade tape gets no value bet, and the
  re-price marks an open row `noOffer` when its side has no seller
  (`edgeReprice.noOffers`; the pages hide it as "no offers"). Gamma's
  `shown` keeps the displayed probability for reference.
- `src/wallet-ledger.js` — point-in-time wallet skill in D1 (`signal_wallets`
  joined to `signals_log`): excess = win rate minus average entry price over a
  wallet's settled bets, trusted from `LEDGER_MIN_N` (10). `GET /wallets/ledger`
  is the raw ranking; `GET /wallets/leaderboard` (Oct 29 2026, snapshot key
  `walletLeaderboard`) merges it with the KV running records (`wallet:<addr>`,
  tiers, pending, streaks) for the Top wallets page via
  `buildWalletLeaderboard`, KV-cached two minutes. The page had asked for that
  path since it shipped while only `/learning/leaderboard` existed, so it read
  empty.
- `src/signal-skill.js` — the proven record behind a whale signal (Oct 30
  2026): `annotateSignalWalletSkill` runs at the end of every scan and gives
  each signal `whaleSkill` (every named wallet's row with the money it put in
  and its skill = win rate minus average price, from the D1 signal ledger when
  trusted at `LEDGER_MIN_N`, else the ranked wallets' on-chain book in KV
  `wallet_onchain:*`; `best`, `worst`, `biggest`, `thin`; the call `proven`
  (+8 or more) / `edge` (+3) / `flat` / `losing` / `unproven`, and `fade`
  when the biggest wallet is a trusted loser at -8 or worse), plus the legacy
  `hasWinningWallet` / `winningWalletInfo` / `topTrades[].isWinner` flags
  the pages read, which the scan route had never set. One chunked D1 query
  per scan, the on-chain KV reads only for wallets the ledger does not
  trust, bounded by `wallet_onchain_index`; never fatal. The Free view masks
  the addresses (`maskWhaleSkill` in tiers.js). Display only: the
  auto-trader's own wallet gate is untouched. The frontend's `signalVerdict`
  turns the call into the card's label and sentence. The on-chain refresher
  (`refreshOnChainSkill`, 6 wallets per 5-min cron) queues the wallets
  behind the current signals too (`signalWalletsByMoney`, KV `signals`,
  largest stake first, 60 max, 4 slots a run after the copied wallets, the
  ranked list fills the rest), so a whale's own record backs the call within
  hours of it appearing; `cronStatus.lastRun.onChainSkill.signalWallets`.
- `src/wallet-book.js` — a wallet's recent book rebuilt from its last 500
  data-api activities plus the positions on file (`rebuildWalletBook`, pure;
  `getWalletPnL` in index.js fetches and adds Polymarket's own book from
  `/v2/user-pnl`). Polymarket never lists a losing leg under Closed: it stays
  on Active at $0, or, when the wallet redeems the condition, shows in the
  feed as a `REDEEM` that paid $0 and is burned (nothing left on file). Oct 30
  2026: a wallet whose book read -$2.8k lifetime read +$78k here until $0
  redeems counted as losses (`zeroRedeems`); a redeem whose buys fell before
  the window is `outsideWindow`, sold-out markets settle on the sale. The
  pages show the book's money and this module's record and skill (win rate
  minus average price); its dollars appear only when the book is missing.
- `src/data-api.js` — Polymarket Data API v2 behind the v1 shapes (Nov 2
  2026: Polymarket retired Data API v1 that day; every /trades, /activity,
  /positions and /closed-positions call answered 410 and the 5-min cron died
  at the whale scan from ~22:30 UTC). `dataApi(v1Url, { fetchImpl })` is the
  drop-in for `fetch(v1Url)` at every call site (index.js, autotrader.js
  whale exits, copy.js poll, execution.js tape): it maps the route
  (/positions -> /v2/positions over OPEN then REDEEMABLE, which is what v1
  listed; /closed-positions -> status=CLOSED; market -> condition; offset
  and sizeThreshold dropped), follows the opaque cursor until the v1 `limit`
  is met (pages of 1000; a 5000-trade scan is five calls), and returns a
  Response-like { ok, status, json() } whose rows are camelCased with the
  v1 names added (`v1Row`: token_id -> asset, current_size -> size,
  current_price -> curPrice, current_value -> currentValue, entry_cost_usdc
  -> initialValue, total_pnl -> cashPnl, total_size -> totalBought). /v2
  URLs pass through; a bare-array body (an old test mock) is returned as
  is. v2 activity carries new types (TAKER_REBATE, CONVERSION...) that the
  readers already ignore. The two offset pagers (`fetchAllPositions`,
  `getWalletClosedRecord`) became one cursor read each. Rate limits (Nov 3
  2026, 15:15 UTC: the scan's 5000-trade read answered 429 and the cycle
  died with it): the published limits are per IP (/v2/trades 300 per 10s,
  /v2/activity and /v2/positions 200), enforced by Cloudflare, and a
  cron-triggered Worker reaches a Cloudflare-proxied host from a shared
  egress address, so the window is shared with every other Worker reading
  the feed; the same pages answer 200 from elsewhere. Guards: a 429 / 5xx
  page is retried up to `RETRY_MAX` (3) times after a wait (Retry-After
  honoured, capped 10s); the GLOBAL trades feed (no user / condition / event /
  side / window filter) is kept in the isolate for `FEED_TTL_MS` (4 min; the
  venue's own edge serves that feed from a 300s cache, activity 15s,
  positions 5s) and served to every read no bigger than the one cached, the
  scan insisting on a copy under a minute old (`maxAgeMs`), so one cycle
  pays one paged read; a path that answered 429 after its retries is
  blocked for `FEED_BLOCK_MS` (60s, or Retry-After if longer) and every read
  of it in that window fails at once (`blocked: true`) instead of waiting
  through its own retries (the 15:30 cycle ran past eight minutes when the
  settlement, line-movement and edge readers each retried the feed the scan
  had just been refused). `dataApiStats()` (counters, active blocks, the
  last failure's status / Retry-After / body excerpt) lands in
  `cronStatus.dataApi` every cycle; `describeFailure` puts the same on the
  scan's error text. The 5-min cron no longer dies on a failed scan:
  `runScan` is wrapped, the failure lands in `cronStatus.scan.error`
  (`fromCache: true`, `stored` = the list's size) and the cycle carries on
  with the stored signals (KV `signals`, the 7-day merged list of ~15k rows)
  cut to the scan's own window by `scanWindow` (src/scan-window.js, shared
  with runScan: 48h, event not started or past, not at a resolution price,
  score >= 30; the first fallback handed the auto-trader the whole week, all
  skipped by its gates); every cycle's scan outcome is pushed to KV `scan_history`
  (288 cycles, a day) and summarized in `cronStatus.scanRecent` (`okRate`,
  `failedStreak`, `lastOkAgoMin`, `last` 12) so the daily routine reads the
  hit rate rather than one cycle. If the scan keeps failing from the
  Worker's egress while the feed answers elsewhere, the structural fixes
  are a relay with its own egress (a Supabase edge function the Worker calls
  with a shared secret) or ingesting Polymarket's real-time trade socket
  into our own store; both are the owner's call. Tests:
  test/data-api.test.mjs (43).
- `src/scan-window.js` — the whale scan's window (`scanWindow`, shared by
  runScan, the cron's failed-scan fallback and GET /scan), the route's
  answer shape (`scanResultShape`, runScan's keys) and its clamped params
  (`scanParams`, hours 1-168, minScore 0-1000). GET /scan (Nov 4 2026) is
  served from the cron's work by `scanFromStored` in index.js: KV `signals`
  cut to the request's window, the whale record annotated, kept 60s per
  (hours, minScore) in the isolate and 15 min in KV `scan_serve:<h>:<m>`
  for every isolate (a cold build annotates ~1,900 wallets and took 7.7s
  live; a copy older than 2 min is served at once and rebuilt in the
  background via ctx.waitUntil, one rebuild per key per minute through
  `scan_serve_lock:<key>`), `scanTime` = KV `signals_saved_at` (the last
  successful cron save), `_debug.servedFrom: 'stored'` with `ageS` and
  `builtAt`; the snapshot carries the route slim as `scanServe` (`ms`). It
  used to run a full live scan per page load (45-160s, refused ~40% of the
  time by Data API v2, and the Scanner re-fetched it every two minutes), so
  the Today page, Scanner and Vegas Odds needed refreshes to load.
  `?live=1` with the admin token still runs a live scan; with no stored list
  the route falls back to one. Tests: test/scan-window.test.mjs (15).
- Engine audit (Nov 14 2026, owner's "turning the scalper off is not an
  option. What is an option is building a better engine that will be
  profitable"). What every record said that day, so the dead ends are not
  re-proposed: speed is closed to us (real-time prices: 7 stale Polymarket
  US quotes in two nights, the one over 1c not fillable; the Kalshi probe
  found 0 of ~30 stale Kalshi prices still there after ~4s); following
  whales has no edge before costs (paper `all`: 15,559 settled, +0.6%);
  Forge's walk-forward mined 124 rules on the signal features and promoted
  none; the copied "top" wallets regressed to -$15 on $645; the pregame
  Vegas edge at live fills read -22% on 33; a taker round trip on Polymarket
  US costs ~4.5c a share at mid prices (two 0.0695 x p(1-p) fees plus the
  spread, ~9% of the stake; the executor dry run paid $0.54 per $5 round
  trip), and maker entries are adversely selected (the 88 shadows that never
  filled were the paper winners). The one record with an edge bigger than
  costs was the AI investigator (paper `ai_investigator`: +17% on 58,
  closer than the market on 62% of 99 scored), on global Polymarket's
  non-sports markets; Polymarket US lists sports only, so its US-legal home
  is Kalshi. The engine direction from there: research-picked bets held to
  settlement, tested as-live in dry before any money.
- `src/investigator-report.js` — the investigator's record broken down
  (Nov 14 2026, step 1 of that plan). Pure `buildInvestigatorReport(rows)`
  over D1 `investigations`: each settled row as a bet (`betOf`: backs the
  direction when edge_pts > 0, the other side when < 0, flat $100, to
  settlement), `core` (|edge| >= 12, not LOW: the leaderboard's rule) and
  `wide` (>= 5) with `byKind` (`marketKind`: weather / esports / social /
  entertainment / crypto / economy / tech / politics / sports / other, a
  title heuristic; `samples` lists titles to check it), `byEntry`,
  `byEdge`, `byConfidence`, `bySource`, `bySide`, `byHorizon`, `byModel`,
  `byMonth`; ROI under four cost scenarios (`COSTS`: recorded price, then
  1/2/3c worse plus a 0.07 x p(1-p) fee); `events` and `tEvents` (buckets
  of one event share a `clusterKey`, and the t-stat sums an event's bets
  first); `byMinEdge` (the rule at each disagreement size); `concentration`
  (biggest wins, the record without the top three); `calibration.byKind`
  (Brier, agent vs market); `openDrift` (cents the market moved toward the
  agent on open investigations; the route annotates the 60 newest with
  live prices); `pace`. `GET /learning/investigator` (snapshot key
  `investigator`). Tests: test/investigator-report.test.mjs (24).
  What the breakdown said (Nov 14): the +17% is three bets (Noem divorce,
  Flávio Bolsonaro, Qualcomm earnings; the other 55 lost 5.6%, 11.5% after
  2c + fee); +7.7% after costs with tEvents 0.84; on all 170 scored rows the
  agent is closer than the market 56% of the time but slightly worse on mean
  Brier (0.144 vs 0.140; the earlier "62% of 99" came from the capped KV
  index); weather (43% of the research) loses (-17%); the one shape of an
  edge is the disagreement size (12-20 points -17% after costs, 20+ +28% on
  32, 30+ +47% on 18) and short horizons (settling within 3 days +24% on 43,
  a week or more out -67% on 11).
- `src/investigator-lane.js` — the investigator's TEST LANE (Nov 15 2026,
  owner's "Can you run it at 10 a day in dry mode simulated real?"). That
  pattern tested forward with the rule fixed in advance (`LANE`, version 1:
  $25 a bet, the agent's probability for a side 20+ points above the price
  PAID, the question settles within 72h, confidence not LOW, not weather;
  changing the rule means bumping `version`). Budget: wrangler
  `INVESTIGATION_DAILY_USD` 10 (was 1), `INVESTIGATION_DAILY_CAP` 150,
  `SWEEP_MAX_DAYS` 3, `SWEEP_EXCLUDE_KINDS` weather, `SWEEP_PER_EVENT` 2;
  the Anthropic account has to hold the credits (KV `anthropic_billing_down`
  stops both the investigator and the Agent Crew when it is empty;
  `budget.creditsOut` in the report). The sweep (`pickSweepCandidates` when
  SWEEP_MAX_DAYS <= 7) researches only what the rule can bet:
  `shortDatedSweepPool` reads the busiest markets ending inside the window
  from Gamma (pages of 100 by `volume24hr`, `end_date_min` / `end_date_max`,
  `SWEEP_POOL_PAGES` 12, KV `sweep_pool` for 30 min), `sweepPool` keeps
  Yes/No questions with resolution text at 8-92c, a two-sided book no wider
  than 8c, not sports / esports / short-term gambling
  (`isInvestigableSignal`) and not an excluded kind, `interleaveByKind`
  takes the kinds in turn (crypto price ladders are half the pool), and
  `pickFresh` skips questions already researched (D1) and allows two
  questions of one event a day (KV `sweep_events:<day>`, by `clusterKey`).
  About 100 questions over ~50 events were open on Nov 15. The moment an
  investigation finishes (`investigateSignal` -> `recordLaneBet`, both
  sources), the CLOB book of the side the agent backs is read and the bet is
  the order a live bot would send: `walkAsks` buys up to the stake from the
  asks, cheapest first, never above agent probability minus 20 points
  (`limit_px`); what is offered there is the fill (partial on a thin book,
  under $5 = no bet), so a price that ran while it researched is no bet
  ('under 20 points at the real offer'). Every finished investigation is
  stored in D1 `investigator_bets` (migration 0016, `INV_LANE_SCHEMA`) with
  its book, pass (`rule` 1) or not (`why`), plus `ask_px` (the whole stake
  at the real offer) so other thresholds can be read later (`atEdge`). The
  outcome is read off `investigations.y` at report time; fees are charged
  at Kalshi's 0.07 x p(1-p) (the US venue's cost, the number to read) next
  to Polymarket's own schedule. `laneReport` rides on
  `GET /learning/investigator` as `test` (rule, since, researched, bets,
  open, settled {hitPct vs breakEvenPct, beforeFees / polymarketFees /
  kalshiFees, events, tEvents}, byKind, whyNot, perDay, fill, atEdge,
  openBets, recentSettled) with `budget` (usdToday, usdCap, creditsOut).
  Nothing is sent anywhere: the markets are global Polymarket's, whose
  public book is only read; a US account would trade the same question on
  Kalshi where it lists one, and Kalshi's price can differ. The research
  call no longer holds the 5-min cycle: the sweep starts mid-cycle, the
  settlement / auto-trader / executor stages go on, and the cycle waits for
  it at the end (`cronStatus.coreCompletedAt` = the cycle's own work,
  `completedAt` includes the research; one research at a time across cycles
  through KV `sweep_lock`). Decide at 60+ settled bets. First hours (Nov
  15): the sweep stalled after three questions because D1 answered "DB is
  overloaded. Too many resources consumed within a 10 second window" to the
  pick's read of known questions (a cycle's stages pile onto D1), so the
  same three candidates were offered every run. Since then the pick offers
  a dozen per wanted question, reads D1 through `d1AllRetry` (waits and
  retries) with the KV `investigation_index` standing in when D1 stays
  busy, the sweep allows one PAID call per wanted question a cycle (free
  skips move on) under the investigator's own retry limit, the lane's
  insert and the report's reads retry too, and visibility is on the record:
  `cronStatus.sweep.pick` (pool, known, knownError, eventsToday, offered) /
  `passedOver`, `test.last` (the lane's answer for the newest
  investigation, KV `inv_lane_last`), `test.readError`, `test.pool`. First
  day (Nov 15): the Anthropic account ran dry at 05:06 UTC after $9.18 (29
  questions, 6 bets), and the 10-minute re-probe of the empty account was
  counted as a researched question each time (`researchedToday` 91 for 29
  real); a call refused for lack of credits no longer touches the day's
  count. Research resumes by itself within ten minutes of a top-up. Tests:
  test/investigator-lane.test.mjs (31).
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
