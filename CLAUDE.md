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
  `whaleAt`. `getCopyState` lists inbox copies as open and carries `poll`. Amounts (Oct 30 2026): `POST /agents/copy/settings` writes the lane's
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
  cross Polymarket US after both fees (`kUsCross`; `crosses`, Oct 30 2026,
  lists those minutes with next-row persistence, the US shares shown and the
  games they came from, since one game carrying most of a sport's crosses is a
  mis-mapped Kalshi leg). `boot` shows the last
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
  owner's; the lane went in dry.
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
  enoughRate, qtyMed, goneAvgMoveC, avgS, noBook }`; the card shows it in one
  line. Rule: a live flip of a venue is only worth it when t0 thereRate is
  high (say 70%+) with the size there; a low t1 rate says the edge is
  short-lived and a faster sampler would be needed first. Live entries are
  not probed (their fill is the evidence).
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
