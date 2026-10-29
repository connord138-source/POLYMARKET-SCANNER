// ============================================================
// CREW-LLM.JS — the crew's actual reasoning (Claude)
// ============================================================
//
// Two jobs, both returning schema-constrained JSON (output_config.format)
// so the code — not the model — applies every change:
//
//   chief()  — reads the operator's chat message with the conversation and
//              the crew's current board, replies in plain English, and says
//              what to change in the orders (sports, markets, edge, bets,
//              duration, stand down). Replaces the keyword parser, which
//              stays as the fallback.
//   debate() — the six personas argue the sweep's top plays from the real
//              numbers (opening positions = the rule-based council votes),
//              then the chair rules APPROVE / TRIM / VETO per play and
//              writes the operator summary.
//
// Runs on claude-haiku-5-5 (operator's call, Oct 2026: ~40x cheaper than
// Opus, so a debate costs ~a quarter of a cent). Haiku is given more room to
// think (effort medium for chat, high for the debate) since the cost is
// negligible either way. Spend has its own daily cap (CREW_LLM_DAILY_USD,
// default $1), tracked from response usage. Over the cap, out of credits,
// or on any error, callers fall back to the rule-based paths. Haiku has no
// server-side refusal fallback; a decline just falls back like an error.
// Same raw-HTTP pattern as the investigator and the council tiebreak.
// ============================================================

const MODEL = 'claude-haiku-5-5';
const PRICE_IN = 0.10 / 1e6;   // $/input token  (claude-haiku-5-5, prompts <= 100K)
const PRICE_OUT = 0.50 / 1e6;  // $/output token (thinking included)
const SPEND_KEY = 'crew_llm_usd:';
const BILLING_REPROBE_MS = 10 * 60 * 1000;

const day = () => new Date().toISOString().slice(0, 10);

export async function crewLlmSpend(env) {
  try { return parseFloat((await env.SIGNALS_CACHE.get(SPEND_KEY + day())) || '0') || 0; } catch (e) { return 0; }
}

async function addSpend(env, usd) {
  try {
    const cur = await crewLlmSpend(env);
    await env.SIGNALS_CACHE.put(SPEND_KEY + day(), String(Math.round((cur + usd) * 10000) / 10000), { expirationTtl: 3 * 86400 });
  } catch (e) {}
}

export async function crewLlmStatus(env) {
  const cap = parseFloat(env.CREW_LLM_DAILY_USD || '1');
  if (!env.ANTHROPIC_API_KEY) return { ok: false, why: 'no Anthropic key', cap, spent: 0 };
  // A failed call costs nothing, so re-probe 10 min after an out-of-credits
  // flag instead of waiting out its hour: topped-up credits come back fast.
  let down = false;
  try {
    const f = await env.SIGNALS_CACHE.get('anthropic_billing_down', { type: 'json' });
    down = !!f && !(f.at && Date.now() - f.at > BILLING_REPROBE_MS);
  } catch (e) {}
  const spent = await crewLlmSpend(env);
  if (down) return { ok: false, why: 'the Anthropic account is out of credits (add them at console.anthropic.com, Plans & Billing)', cap, spent };
  if (spent >= cap) return { ok: false, why: `crew's daily $${cap} Claude budget used`, cap, spent };
  return { ok: true, cap, spent };
}

async function callClaude(env, { system, messages, schema, effort, maxTokens, timeoutMs }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 45000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        system,
        messages,
        output_config: { effort, format: { type: 'json_schema', schema } },
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = String((body && body.error && body.error.message) || JSON.stringify(body)).slice(0, 300);
      if (/credit balance is too low/i.test(msg)) {
        try { await env.SIGNALS_CACHE.put('anthropic_billing_down', JSON.stringify({ at: Date.now() }), { expirationTtl: 3600 }); } catch (e) {}
        return { ok: false, error: 'the Anthropic account is out of credits (add them at console.anthropic.com, Plans & Billing)' };
      }
      if (res.status === 403 && /not allowed/i.test(msg)) return { ok: false, error: 'Claude API error 403: request not allowed from this edge location' };
      return { ok: false, error: `Claude API error ${res.status}: ${msg.slice(0, 140)}` };
    }
    const u = body.usage || {};
    const usd = ((u.input_tokens || 0) + (u.cache_creation_input_tokens || 0)) * PRICE_IN +
      (u.cache_read_input_tokens || 0) * PRICE_IN * 0.1 + (u.output_tokens || 0) * PRICE_OUT;
    await addSpend(env, usd);
    if (body.stop_reason === 'refusal') return { ok: false, error: 'declined', usd };
    if (body.stop_reason === 'max_tokens') return { ok: false, error: 'ran out of output room', usd };
    const text = (body.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    let data;
    try { data = JSON.parse(text); } catch (e) { return { ok: false, error: 'unparseable reply', usd }; }
    return { ok: true, data, usd };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timed out' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] });

// ---------- the chief (chat) ----------

const CHIEF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'action', 'focus'],
  properties: {
    reply: { type: 'string' },
    action: { type: 'string', enum: ['none', 'set_focus', 'update_focus', 'stand_down'] },
    focus: nullable({
      type: 'object',
      additionalProperties: false,
      required: ['sports', 'markets', 'minEdge', 'maxBets', 'until', 'hours'],
      properties: {
        sports: { type: 'array', items: { type: 'string', enum: ['cfb', 'nfl', 'nba', 'wnba', 'mlb', 'nhl', 'ncaab'] } },
        markets: { type: 'array', items: { type: 'string', enum: ['moneyline', 'spread', 'total'] } },
        minEdge: nullable({ type: 'number' }),
        maxBets: nullable({ type: 'integer' }),
        until: { type: 'string', enum: ['end_of_day', 'stand_down', 'hours'] },
        hours: nullable({ type: 'number' }),
      },
    }),
  },
};

const CHIEF_SYSTEM = `You are the chief of the EDGERUNNER agent crew, talking with the operator in the Agent Crew chat. The operator bets on DraftKings and runs a paper-trading bot on Polymarket. Talk like a sharp, honest betting analyst: short, plain English, no hype, no jargon the operator has to decode.

What the crew does while it has orders (every ~15 minutes):
- Prices every pregame game in the ordered sport(s) two ways: the DraftKings line vs the fair price (Polymarket's price, blended with the sportsbook consensus where available), and Polymarket's price vs the sportsbooks.
- The DraftKings value board (on the page, pulled live in the operator's browser) covers moneylines, full-game spreads and full-game totals, matched to Polymarket markets at the same line. "Per $100" is what a $100 bet makes on average; positive means DraftKings pays more than it should.
- The council (GREED, FOMO, PANIC, DOUBT, QUANT, RISK) debates the biggest gaps and a chair rules approve / split (half size) / veto. Approved Polymarket moneyline gaps of at least the order's min edge are placed as PAPER bets ($5, $2.50 on a split), capped per day. Nothing here ever places a real-money bet.

Hard limits — say them plainly when relevant, never pretend otherwise:
- Player props: Polymarket lists no player props for these games and the free DraftKings feed has none, so the crew has no fair price to compare them to and cannot evaluate them. Getting props needs a paid odds plan with player-prop markets (The Odds API).
- Halves, quarters and team totals are not compared (DraftKings' feed here only has full-game lines).
- Sports it can hunt: cfb, nfl, nba, wnba, mlb, nhl, ncaab. Not soccer, tennis, golf, UFC, esports, politics, crypto.
- Most of the time DraftKings and Polymarket agree; DraftKings' cut (~2-2.5% per side) makes most lines slightly negative. Say so rather than inventing value. Never invent injuries, news, or numbers that aren't in the state you're given.
- Polymarket prices move in 1-cent steps, so the fair price itself is only good to about +/-1%. Treat anything under +$1.50 per $100 as fair/noise, not value; only recommend a DraftKings line at +$1.50 per $100 or better, and say plainly when nothing clears that bar. The operator wants to make money, not to bet for the sake of it.

Deciding the action:
- "none": questions, chit-chat, or a message that restates the current orders (e.g. "only nfl nothing else" when the orders are already NFL only) — answer, don't reset anything.
- "set_focus": new orders that change which sports are hunted.
- "update_focus": same sports, different settings (markets, min edge, bets per day, duration).
- "stand_down": stop hunting.
For set_focus / update_focus fill every focus field: sports; markets (default all three: moneyline, spread, total); minEdge in points (null = keep current/default 3); maxBets per day (null = keep current/default 6, max 25); until = "end_of_day" for "today/tonight", "stand_down" for "until I tell you / until further notice", "hours" with hours set for a specific duration. Otherwise focus is null.

The state block in the operator's message is the crew's live view: current orders, the latest sweep (games priced, top Polymarket gaps with council verdicts, the chair's summary), the DraftKings value board the operator's browser last reported (may be missing), bets placed, and budget. Use it to answer questions like "any good plays?" with specific teams and numbers. Keep replies under ~90 words unless the operator asks for detail.`;

export async function chief(env, { text, chat, state }) {
  const history = [];
  for (const m of (chat || []).slice(-12)) {
    const role = m.from === 'you' ? 'user' : 'assistant';
    if (history.length && history[history.length - 1].role === role) history[history.length - 1].content += `\n\n${m.text}`;
    else history.push({ role, content: m.text });
  }
  while (history.length && history[0].role !== 'user') history.shift();
  const final = `<state>\n${JSON.stringify(state)}\n</state>\n\nOperator: ${text}`;
  if (history.length && history[history.length - 1].role === 'user') history[history.length - 1].content += `\n\n${final}`;
  else history.push({ role: 'user', content: final });
  return callClaude(env, { system: CHIEF_SYSTEM, messages: history, schema: CHIEF_SCHEMA, effort: 'medium', maxTokens: 8000, timeoutMs: 40000 });
}

// ---------- the debate (each sweep) ----------

const DEBATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['debate', 'verdicts', 'summary'],
  properties: {
    debate: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['agent', 'line'],
        properties: { agent: { type: 'string', enum: ['GREED', 'FOMO', 'PANIC', 'DOUBT', 'QUANT', 'RISK', 'CHAIR'] }, line: { type: 'string' } },
      },
    },
    verdicts: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'verdict', 'reason'],
        properties: { id: { type: 'string' }, verdict: { type: 'string', enum: ['APPROVE', 'TRIM', 'VETO'] }, reason: { type: 'string' } },
      },
    },
    summary: { type: 'string' },
  },
};

const DEBATE_SYSTEM = `You run the EDGERUNNER council: six agents who argue over the plays the crew's sweep found, then a chair who rules. Each agent has a lane:
- GREED: is there real money in the price? Size of the gap after costs.
- FOMO: smart-money flow — whale bets, how the price is moving.
- PANIC: what can go wrong — chasing a moved price, thin markets, a bad day for the book.
- DOUBT: is it real or noise — sample size, how far apart the price sources are, no track record yet.
- QUANT: the numbers — fair probability vs the price paid, expected value.
- RISK: the book — exposure, correlation (same game, same slate), daily caps.
Each agent's opening position (from the rule-based scoring) is given; agents may change their minds when another agent makes a better point. Write a real exchange: 6 to 10 short turns where agents answer each other by name and cite the actual numbers given. No invented injuries, news, weather, or stats — if something isn't in the data, an agent may say it's unknown. The CHAIR speaks last.

Then the chair rules on EVERY Polymarket candidate listed: APPROVE (full paper bet), TRIM (half size), or VETO, with a one-sentence reason. Only candidates whose edge meets the order's min edge can be placed at all; ruling on the rest still matters for the record. Be skeptical: a few points of gap between two efficient markets is usually noise or timing, and the crew's lane has no settled track record yet.

Finally the summary: 2-3 plain-English sentences for the operator — what the crew would play (paper) and, if a DraftKings board is provided, whether any DraftKings line is worth a slip, naming teams and the "per $100" figure. Polymarket's 1-cent price steps make the fair price good to only about +/-1%, so a DraftKings line under +$1.50 per $100 is noise, not a play. If nothing clears that bar, say so directly — the goal is profit, not action.`;

export async function debate(env, { candidates, dkBoard, context }) {
  const payload = { context, candidates, dkBoard: dkBoard || null };
  return callClaude(env, {
    system: DEBATE_SYSTEM,
    messages: [{ role: 'user', content: `<sweep>\n${JSON.stringify(payload)}\n</sweep>` }],
    schema: DEBATE_SCHEMA,
    effort: 'high',
    maxTokens: 16000,
    timeoutMs: 90000,
  });
}
