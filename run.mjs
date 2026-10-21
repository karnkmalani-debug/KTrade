// KTrade runner for GitHub Actions. Paper trading only — never places real orders.
// Usage: node run.mjs ai | auto | check | reset      (env: ANTHROPIC_API_KEY, FORCE=true to trade on a closed day)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

const MODE = (process.argv[2] || 'ai').toLowerCase();
const FORCE = process.env.FORCE === 'true';
const STATE = 'data/state.json';
const B = 'NIFTYBEES.NS', MX = 30;

const TZ = { timeZone: 'Asia/Kolkata' };
const day = () => new Date().toLocaleDateString('en-CA', TZ);
const dayOf = t => new Date(t * 1e3).toLocaleDateString('en-CA', TZ);
const now = () => new Date().toLocaleString('en-GB', { ...TZ, hour12: false, weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const sh = s => s.replace('.NS', ''), r2 = x => +x.toFixed(2);

/* ---------- settings & state ---------- */
const DEFAULTS = { model: 'claude-sonnet-5-5', startCapital: 20000, maxPerTrade: 5000, maxHoldings: 5, stopLossPct: 8,
  maxTradesPerDay: 3, minCashPct: 5, minConfidence: 0.6, chargesPct: 0.15, paused: false,
  watchlist: 'NIFTYBEES BANKBEES GOLDBEES JUNIORBEES RELIANCE HDFCBANK ICICIBANK INFY TCS ITC LT SBIN BHARTIARTL HINDUNILVR SUNPHARMA'.split(' ') };

function cleanSettings(inp, prev) {
  const st = { ...DEFAULTS, ...prev };
  const N = (v, lo, hi) => { v = +v; return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null; };
  if (['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5'].includes(inp.model)) st.model = inp.model;
  for (const [k, lo, hi] of [['startCapital', 1e3, 1e8], ['maxPerTrade', 100, 1e7], ['maxHoldings', 1, 30], ['stopLossPct', 1, 50],
    ['maxTradesPerDay', 0, 20], ['minCashPct', 0, 90], ['minConfidence', 0, 1], ['chargesPct', 0, 2]]) {
    const v = N(inp[k], lo, hi); if (v !== null) st[k] = v;
  }
  if (typeof inp.paused === 'boolean') st.paused = inp.paused;
  const wl = Array.isArray(inp.watchlist) ? inp.watchlist : st.watchlist;
  st.watchlist = [...new Set(wl.map(s => String(s).trim().toUpperCase()).filter(s => /^[A-Z0-9&-]+(\.NS|\.BO)?$/.test(s))
    .map(s => /\.(NS|BO)$/.test(s) ? s : s + '.NS'))].slice(0, MX - 6);
  return st;
}
function readJSON(path) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } }
const fresh = st => ({ settings: st, cash: st.startCapital, holdings: {}, trades: [], runs: [], snapshots: [], prices: {},
  bench: null, startedOn: day(), lastRunDate: null, lastCheck: null });

/* ---------- prices (Yahoo Finance) ---------- */
async function quote(s) {
  for (const h of ['query1', 'query2']) {
    try {
      const r = await fetch(`https://${h}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?range=3mo&interval=1d`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) continue;
      const x = (await r.json())?.chart?.result?.[0]; if (!x) return null;
      const m = x.meta, c = (x.indicators?.quote?.[0]?.close || []).filter(v => v != null);
      return { price: m.regularMarketPrice, prevClose: c[c.length - 2] ?? m.chartPreviousClose, time: m.regularMarketTime, closes: c };
    } catch { /* try next host */ }
  }
  return null;
}
async function prices(S, list) {
  const F = {};
  for (const s of list.slice(0, MX)) { // one at a time is gentler on Yahoo
    const q = await quote(s);
    if (q && q.price) { F[s] = q; S.prices[s] = { price: q.price, prevClose: q.prevClose, time: q.time }; }
  }
  return F;
}
function ind(q) {
  if (!q || q.closes.length < 15) return null;
  const c = q.closes, n = c.length, p = q.price, sma = c.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, n);
  let g = 0, l = 0; for (let i = n - 14; i < n; i++) { const d = c[i] - c[i - 1]; d > 0 ? g += d : l -= d; }
  return { price: r2(p), dayChg: r2((p / q.prevClose - 1) * 100), ret1m: r2((p / c[Math.max(0, n - 22)] - 1) * 100),
    ret3m: r2((p / c[0] - 1) * 100), vsSma20: r2((p / sma - 1) * 100), rsi14: +(l ? 100 - 100 / (1 + g / l) : 100).toFixed(1) };
}

/* ---------- portfolio ---------- */
const px = (S, s) => S.prices[s]?.price;
const tv = S => S.cash + Object.entries(S.holdings).reduce((v, [s, h]) => v + h.qty * (px(S, s) ?? h.avg), 0);
const bv = S => S.bench ? S.bench.units * (px(S, B) ?? S.bench.startPrice) : S.settings.startCapital;
const fee = S => S.settings.chargesPct / 100;
function buy(S, s, amt, reason, conf) {
  const p = px(S, s); if (!p) return 'no price ' + sh(s);
  const q = Math.floor(amt / (p * (1 + fee(S)))); if (q < 1) return sh(s) + ': too small for 1 share';
  const c = q * p, f = c * fee(S); S.cash -= c + f;
  const h = S.holdings[s] || { qty: 0, avg: 0, since: day() };
  h.avg = (h.avg * h.qty + c + f) / (h.qty + q); h.qty += q; S.holdings[s] = h;
  S.trades.unshift({ date: day(), side: 'BUY', sym: s, qty: q, price: p, fee: r2(f), reason, conf });
}
function sell(S, s, q, reason, conf) {
  const h = S.holdings[s], p = px(S, s); if (!h) return sh(s) + ': not held'; if (!p) return 'no price ' + sh(s);
  q = Math.min(q, h.qty); if (!(q >= 1)) return sh(s) + ': nothing to sell';
  const g = q * p, f = g * fee(S); S.cash += g - f;
  const pnl = g - f - h.avg * q; h.qty -= q; if (h.qty <= 0) delete S.holdings[s];
  S.trades.unshift({ date: day(), side: 'SELL', sym: s, qty: q, price: p, fee: r2(f), pnl: r2(pnl), reason, conf });
}
function snap(S) { const d = day(), x = { date: d, value: r2(tv(S)), bench: r2(bv(S)) }, i = S.snapshots.findIndex(z => z.date === d); i >= 0 ? S.snapshots[i] = x : S.snapshots.push(x); }
function stops(S, log) {
  const sl = S.settings.stopLossPct;
  for (const [s, h] of Object.entries({ ...S.holdings })) {
    const p = px(S, s);
    if (p && p <= h.avg * (1 - sl / 100)) { sell(S, s, h.qty, `Stop-loss hit (−${sl}%)`, 1); log.push('Stop-loss: sold ' + sh(s)); }
  }
}

/* ---------- Claude ---------- */
const SYS = c => `You are a disciplined swing-trading research agent managing a PAPER portfolio of Indian NSE stocks and ETFs. Delivery trades only: no leverage, shorting or F&O. Only trade symbols in the watchlist or holdings, using the exact symbol strings given.
Goal: beat buying and holding NIFTYBEES.NS after costs. Each round trip costs about ${c}% x2 plus slippage, so overtrading destroys returns; doing nothing is often best. Act only with a clear, specific reason. Respect the user's limits.
Use web search (max 5) for recent news on holdings, your 2-3 best candidates, and the Indian market.
End with ONLY a JSON object, no markdown fence:
{"market_view":"2-3 sentences","actions":[{"action":"BUY","symbol":"TCS.NS","amount_inr":4000,"confidence":0.7,"reason":"short"},{"action":"SELL","symbol":"ITC.NS","qty":"ALL","confidence":0.65,"reason":"short"}]}
actions may be empty; confidence 0-1; SELL qty is a number or "ALL".`;
async function claude(S, msg) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw Error('ANTHROPIC_API_KEY secret is not set in the GitHub repo.');
  const M = [{ role: 'user', content: msg }], u = { input: 0, output: 0, searches: 0 };
  for (let i = 0; i < 5; i++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: S.settings.model, max_tokens: 4000, system: SYS(S.settings.chargesPct), messages: M,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5, user_location: { type: 'approximate', country: 'IN', timezone: 'Asia/Kolkata' } }] })
    });
    const j = await r.json();
    if (!r.ok) throw Error('Claude API: ' + (j.error?.message || r.status));
    u.input += j.usage?.input_tokens || 0; u.output += j.usage?.output_tokens || 0; u.searches += j.usage?.server_tool_use?.web_search_requests || 0;
    if (j.stop_reason === 'pause_turn') { M.push({ role: 'assistant', content: j.content }); continue; }
    return { text: j.content.filter(b => b.type === 'text').map(b => b.text).join(''), u };
  }
  throw Error('Claude did not finish.');
}
function decide(t) {
  const a = t.lastIndexOf('{"market_view"'), s = a >= 0 ? a : t.indexOf('{'), e = t.lastIndexOf('}');
  if (s < 0 || e <= s) throw Error('AI reply had no JSON decision.');
  return JSON.parse(t.slice(s, e + 1));
}
// USD per million tokens in/out: Haiku 5.5 0.10/0.50, Sonnet 5.5 2/10, Opus 5.5 4/20; web search $0.01 each
const cost = (m, u) => { const [a, b] = m.includes('haiku') ? [0.1, 0.5] : m.includes('opus') ? [4, 20] : [2, 10]; return +(u.searches * 0.01 + a * u.input / 1e6 + b * u.output / 1e6).toFixed(3); };

/* ---------- jobs ---------- */
async function runAI(S, manual) {
  const st = S.settings, log = [], d = day();
  if (!manual && st.paused) return 'Paused in settings.json — skipped.';
  if (!manual && S.lastRunDate === d) return 'Already ran today.';
  const F = await prices(S, [...new Set([B, ...Object.keys(S.holdings), ...st.watchlist])]), bp = S.prices[B];
  if (!bp) throw Error('Could not get prices (Yahoo busy). Try again later.');
  const open = dayOf(bp.time) === d;
  if (!open && !FORCE) {
    S.lastRunDate = d; snap(S);
    S.runs.unshift({ date: d, time: now(), view: 'Market closed today (holiday/weekend) — no trades.', actions: [], log: [], estCostUSD: 0, manual });
    return 'Market closed today — no trades.';
  }
  if (!S.bench) S.bench = { units: st.startCapital / bp.price, startPrice: bp.price, date: d };
  stops(S, log);
  const brief = { date: d, time_ist: now(), market_open_today: open, cash_inr: Math.round(S.cash), total_value_inr: Math.round(tv(S)),
    limits: { max_per_trade_inr: st.maxPerTrade, max_holdings: st.maxHoldings, stop_loss_pct: st.stopLossPct, max_trades_today: st.maxTradesPerDay, min_cash_reserve_pct: st.minCashPct },
    holdings: Object.entries(S.holdings).map(([s, h]) => ({ symbol: s, qty: h.qty, avg_cost: r2(h.avg), since: h.since, pnl_pct: r2(((px(S, s) ?? h.avg) / h.avg - 1) * 100), ...ind(F[s]) })),
    watchlist: st.watchlist.map(s => ({ symbol: s, ...ind(F[s]) })).filter(x => x.price),
    recent_trades: S.trades.slice(0, 10).map(t => ({ date: t.date, side: t.side, symbol: t.sym, qty: t.qty, price: t.price })) };
  const { text, u } = await claude(S, "Today's portfolio and market data (indicators in %):\n" + JSON.stringify(brief));
  const D = decide(text);
  let n = S.trades.filter(t => t.date === d && !String(t.reason).startsWith('Stop-loss')).length;
  const acts = (D.actions || []).filter(a => a && a.symbol).sort((x, y) => (x.action === 'SELL' ? 0 : 1) - (y.action === 'SELL' ? 0 : 1));
  for (const a of acts) {
    const s = String(a.symbol).toUpperCase(), c = +a.confidence || 0; let err;
    if (n >= st.maxTradesPerDay) { log.push(`Skipped ${sh(s)}: daily trade cap`); continue; }
    if (c < st.minConfidence) { log.push(`Skipped ${a.action} ${sh(s)}: confidence ${c}`); continue; }
    if (a.action === 'SELL') {
      const h = S.holdings[s]; if (!h) { log.push(`Skipped SELL ${sh(s)}: not held`); continue; }
      err = sell(S, s, a.qty === 'ALL' ? h.qty : Math.floor(+a.qty), a.reason, c);
    } else if (a.action === 'BUY') {
      if (!st.watchlist.includes(s) && !S.holdings[s]) { log.push(`Skipped BUY ${sh(s)}: not in watchlist`); continue; }
      if (!S.holdings[s] && Object.keys(S.holdings).length >= st.maxHoldings) { log.push(`Skipped BUY ${sh(s)}: max holdings`); continue; }
      const amt = Math.min(+a.amount_inr || 0, st.maxPerTrade, S.cash - tv(S) * st.minCashPct / 100);
      if (amt <= 0) { log.push(`Skipped BUY ${sh(s)}: not enough cash`); continue; }
      err = buy(S, s, amt, a.reason, c);
    } else continue;
    if (err) log.push('Skipped: ' + err); else { n++; log.push((a.action === 'BUY' ? 'Bought ' : 'Sold ') + sh(s)); }
  }
  const k = cost(st.model, u);
  S.runs.unshift({ date: d, time: now(), view: D.market_view, actions: D.actions || [], log, estCostUSD: k, manual });
  S.lastRunDate = d; snap(S);
  return (log.length ? log.join(' · ') : 'AI decided to hold — no trades.') + ` (AI cost ≈ $${k})`;
}
async function closeCheck(S) {
  const log = [];
  await prices(S, [...new Set([B, ...Object.keys(S.holdings)])]);
  if (S.bench && S.prices[B] && dayOf(S.prices[B].time) === day()) { stops(S, log); snap(S); }
  S.lastCheck = now() + (log.length ? ' — ' + log.join(', ') : '');
  return 'Price check done.' + (log.length ? ' ' + log.join(', ') : '');
}

/* ---------- main ---------- */
const userSettings = readJSON('settings.json') || {};
let S = readJSON(STATE);
if (!S || MODE === 'reset') S = fresh(cleanSettings(userSettings, {}));
else {
  const capBefore = S.settings.startCapital;
  S.settings = cleanSettings(userSettings, S.settings);
  if (S.settings.startCapital !== capBefore) {
    if (!S.trades.length && !S.bench) S.cash = S.settings.startCapital;
    else S.settings.startCapital = capBefore; // can't change capital mid-test; use reset
  }
}
const manual = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';
let msg;
try {
  if (MODE === 'reset') msg = 'Portfolio reset.';
  else if (MODE === 'check') msg = await closeCheck(S);
  // auto = hourly backup runs: trade once per day, otherwise just refresh prices
  else if (MODE === 'auto' && (S.lastRunDate === day() || S.settings.paused)) msg = await closeCheck(S);
  else msg = await runAI(S, manual);
} catch (e) {
  msg = '⚠ Run failed: ' + e.message;
  S.runs.unshift({ date: day(), time: now(), view: msg, actions: [], log: [], estCostUSD: 0, manual });
}
S.runs = S.runs.slice(0, 120); S.trades = S.trades.slice(0, 500); S.updatedAt = now();
if (!existsSync('data')) mkdirSync('data');
writeFileSync(STATE, JSON.stringify(S, null, 1));
console.log(msg);
