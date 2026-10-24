// KTrade runner for GitHub Actions. Paper trading only — never places real orders.
// Three AI-managed portfolios: Commodities, Long-term (5 years, moderate) and Aggressive (12–18 months).
// Usage: node run.mjs ai | auto | check | reset      (env: ANTHROPIC_API_KEY, FORCE=true to trade on a closed day)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

const MODE = (process.argv[2] || 'ai').toLowerCase();
const FORCE = process.env.FORCE === 'true';
const STATE = 'data/state.json';
const MARKET = 'NIFTYBEES.NS';           // tells us whether India traded today
const FX = 'USDINR=X';                    // US prices are converted to rupees with this
const MAX_QUOTES = 90;

const TZ = { timeZone: 'Asia/Kolkata' };
const day = () => new Date().toLocaleDateString('en-CA', TZ);
const dayOf = t => new Date(t * 1e3).toLocaleDateString('en-CA', TZ);
const now = () => new Date().toLocaleString('en-GB', { ...TZ, hour12: false, weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const weekOf = d => { const t = new Date(d + 'T00:00:00Z'), w = (t.getUTCDay() + 6) % 7; t.setUTCDate(t.getUTCDate() - w); return t.toISOString().slice(0, 10); };
const sh = s => s.replace(/\.(NS|BO)$/, ''), r2 = x => +(+x).toFixed(2);
const isIN = s => /\.(NS|BO)$/.test(s);

/* ---------- the three portfolios ---------- */
const PF = {
  commodities: {
    name: 'Commodities', cadence: 'daily', capital: 20000,
    maxHoldings: 6, maxPosPct: 35, stopLossPct: 10, maxTradesPerDay: 3, minCashPct: 5, minConfidence: 0.6,
    bench: { DBC: 1 }, benchName: 'Broad commodity index (DBC)',
    profile: 'Commodities portfolio. Gain from moves in gold, silver, crude oil, natural gas, industrial metals, agriculture and uranium, using commodity ETFs and, where useful, commodity producer ETFs. Long only. Rotate towards commodities with strong supply/demand, inflation, currency and geopolitical tailwinds; cut losers quickly.',
    seeds: 'GLD SLV USO BNO UNG CPER DBA DBC PDBC GDX XLE URA GOLDBEES.NS SILVERBEES.NS'
  },
  longterm: {
    name: 'Long-term · 5 years', cadence: 'weekly', capital: 20000,
    maxHoldings: 12, maxPosPct: 15, stopLossPct: 25, maxTradesPerDay: 4, minCashPct: 3, minConfidence: 0.6,
    bench: { 'NIFTYBEES.NS': 0.5, VOO: 0.5 }, benchName: '50% Nifty 50 + 50% S&P 500',
    profile: 'Long-term growth portfolio for a moderate-risk investor with a 5-year horizon. Own 8–12 high-quality compounders and broad index ETFs across India and the US (and other regions via ETFs), with 5–15% in gold or bonds for balance. Low turnover: buy and hold, add on weakness, sell only when the long-term thesis breaks or a position grows far above its limit. Spread risk across countries and sectors.',
    seeds: 'NIFTYBEES.NS JUNIORBEES.NS HDFCBANK.NS ICICIBANK.NS RELIANCE.NS TCS.NS INFY.NS BHARTIARTL.NS LT.NS BAJFINANCE.NS TITAN.NS SUNPHARMA.NS VOO QQQ VXUS MSFT AAPL GOOGL AMZN NVDA BRK-B JPM V GLD GOLDBEES.NS BND'
  },
  aggressive: {
    name: 'Aggressive · 12–18 months', cadence: 'daily', capital: 20000,
    maxHoldings: 8, maxPosPct: 25, stopLossPct: 12, maxTradesPerDay: 3, minCashPct: 3, minConfidence: 0.6,
    bench: { 'NIFTYBEES.NS': 0.5, QQQ: 0.5 }, benchName: '50% Nifty 50 + 50% Nasdaq 100',
    profile: 'Aggressive growth portfolio for a 12–18 month horizon. Concentrate in the strongest growth themes in India and the US: AI and semiconductors, digital platforms, defence, capital goods, high-growth mid and small caps, and thematic ETFs. Favour strong earnings growth and price momentum; cut losers fast and let winners run.',
    seeds: 'MID150BEES.NS TRENT.NS DIXON.NS PERSISTENT.NS POLYCAB.NS BEL.NS HAL.NS ETERNAL.NS CDSL.NS KPITTECH.NS BSE.NS NVDA AVGO META TSLA AMD PLTR SMH QQQ ARKK CRWD NFLX'
  }
};
const IDS = Object.keys(PF);
const CHARGES = { IN: 0.15, US: 0.75 };   // % per trade side: India brokerage+taxes; US adds about 0.5% currency conversion

/* ---------- settings & state ---------- */
const MODELS = ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5'];
function readJSON(path) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } }
function settings() {
  const u = readJSON('settings.json') || {};
  const s = { model: MODELS.includes(u.model) ? u.model : 'claude-sonnet-5-5', paused: u.paused === true, portfolios: {} };
  for (const id of IDS) s.portfolios[id] = { paused: u.portfolios?.[id]?.paused === true };
  return s;
}
const freshP = id => ({ id, cash: PF[id].capital, holdings: {}, trades: [], runs: [], snapshots: [], bench: null, risk: null,
  startedOn: day(), lastRunDate: null, lastRunWeek: null });
const fresh = () => ({ version: 2, startedOn: day(), portfolios: Object.fromEntries(IDS.map(id => [id, freshP(id)])), prices: {}, fx: null, lastCheck: null });

/* ---------- prices (Yahoo Finance) ---------- */
const QC = {};
async function quote(s) {
  if (s in QC) return QC[s];
  for (const h of ['query1', 'query2']) {
    try {
      const r = await fetch(`https://${h}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?range=6mo&interval=1d`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (r.status === 404) return QC[s] = null;
      if (!r.ok) continue;
      const x = (await r.json())?.chart?.result?.[0]; if (!x) return QC[s] = null;
      const m = x.meta, q = x.indicators?.quote?.[0] || {}, c = [], v = [];
      (q.close || []).forEach((p, i) => { if (p != null) { c.push(p); v.push(q.volume?.[i] || 0); } });
      return QC[s] = { price: m.regularMarketPrice, cur: m.currency, prevClose: c[c.length - 2] ?? m.chartPreviousClose, time: m.regularMarketTime, closes: c, vols: v };
    } catch { /* try next host */ }
  }
  return QC[s] = null;
}
let fxRate = null;
const toINR = q => q.cur === 'INR' ? 1 : q.cur === 'USD' ? fxRate : null;
async function prices(S, list) {
  const F = {};
  for (const s of [...new Set(list)].slice(0, MAX_QUOTES)) { // one at a time is gentler on Yahoo
    const q = await quote(s), k = q && toINR(q);
    if (q && q.price && k) { F[s] = q; S.prices[s] = { price: r2(q.price), cur: q.cur, inr: r2(q.price * k), prevClose: q.prevClose, time: q.time }; }
  }
  return F;
}
// Must be a real, liquid NSE/BSE or US-listed stock or ETF priced in INR or USD.
function liquid(q) {
  if (!q || !q.price || !['INR', 'USD'].includes(q.cur) || q.closes.length < 20) return false;
  const n = q.closes.length, val = q.closes.slice(-20).reduce((a, p, i) => a + p * q.vols[n - 20 + i], 0) / 20;
  return q.cur === 'INR' ? val >= 2e7 : val >= 5e6;   // ₹2 crore or $5 million traded a day
}
function ind(q) {
  if (!q || q.closes.length < 22) return null;
  const c = q.closes, n = c.length, p = q.price, sma = c.slice(-50).reduce((a, b) => a + b, 0) / Math.min(50, n);
  let g = 0, l = 0; for (let i = n - 14; i < n; i++) { const d = c[i] - c[i - 1]; d > 0 ? g += d : l -= d; }
  const rets = c.slice(1).map((x, i) => x / c[i] - 1), mu = rets.reduce((a, b) => a + b, 0) / rets.length;
  const vol = Math.sqrt(rets.reduce((a, b) => a + (b - mu) ** 2, 0) / rets.length * 252);
  return { price: r2(p), currency: q.cur, dayChg: r2((p / q.prevClose - 1) * 100), ret1m: r2((p / c[Math.max(0, n - 22)] - 1) * 100),
    ret6m: r2((p / c[0] - 1) * 100), vsSma50: r2((p / sma - 1) * 100), rsi14: +(l ? 100 - 100 / (1 + g / l) : 100).toFixed(1), volPct: r2(vol * 100),
    high6m: r2((p / Math.max(...c) - 1) * 100) };
}

/* ---------- portfolio maths ---------- */
const pin = (S, s) => S.prices[s]?.inr;
const hv = (S, P) => Object.entries(P.holdings).reduce((v, [s, h]) => v + h.qty * (pin(S, s) ?? h.avg), 0);
const tv = (S, P) => P.cash + hv(S, P);
const bv = (S, P) => P.bench ? Object.entries(P.bench.units).reduce((v, [s, u]) => v + u * (pin(S, s) ?? P.bench.start[s]), 0) : PF[P.id].capital;
const fee = s => (isIN(s) ? CHARGES.IN : CHARGES.US) / 100;
function buy(S, P, s, amt, reason, conf) {
  const p = pin(S, s); if (!p) return 'no price ' + sh(s);
  // US brokers sell fractional shares; Indian shares are whole numbers.
  const raw = amt / (p * (1 + fee(s))), q = isIN(s) ? Math.floor(raw) : Math.floor(raw * 1e4) / 1e4;
  if (isIN(s) ? q < 1 : q * p < 500) return sh(s) + (isIN(s) ? ': too small for 1 share' : ': below ₹500');
  const c = q * p, f = c * fee(s); P.cash -= c + f;
  const h = P.holdings[s] || { qty: 0, avg: 0, since: day() };
  h.avg = (h.avg * h.qty + c + f) / (h.qty + q); h.qty = +(h.qty + q).toFixed(4); P.holdings[s] = h;
  P.trades.unshift({ date: day(), side: 'BUY', sym: s, qty: q, price: r2(p), fee: r2(f), reason, conf });
}
function sell(S, P, s, q, reason, conf) {
  const h = P.holdings[s], p = pin(S, s); if (!h) return sh(s) + ': not held'; if (!p) return 'no price ' + sh(s);
  q = Math.min(q, h.qty); if (!(isIN(s) ? q >= 1 : q > 0)) return sh(s) + ': nothing to sell';
  const g = q * p, f = g * fee(s); P.cash += g - f;
  const pnl = g - f - h.avg * q; h.qty = +(h.qty - q).toFixed(4); if (h.qty <= 0) delete P.holdings[s];
  P.trades.unshift({ date: day(), side: 'SELL', sym: s, qty: q, price: r2(p), fee: r2(f), pnl: r2(pnl), reason, conf });
}
function snap(S, P) { const d = day(), x = { date: d, value: r2(tv(S, P)), bench: r2(bv(S, P)) }, i = P.snapshots.findIndex(z => z.date === d); i >= 0 ? P.snapshots[i] = x : P.snapshots.push(x); }
function stops(S, P, log) {
  const sl = PF[P.id].stopLossPct;
  for (const [s, h] of Object.entries({ ...P.holdings })) {
    const p = pin(S, s);
    if (p && p <= h.avg * (1 - sl / 100)) { sell(S, P, s, h.qty, `Stop-loss hit (−${sl}%)`, 1); log.push('Stop-loss: sold ' + sh(s)); }
  }
}
function startBench(S, P) {
  if (P.bench) return;
  const B = PF[P.id].bench, cap = PF[P.id].capital, units = {}, start = {};
  for (const [s, w] of Object.entries(B)) { const p = pin(S, s); if (!p) return; units[s] = cap * w / p; start[s] = p; }
  P.bench = { units, start, date: day() };
}

/* ---------- risk check (Aladdin-style: what could go wrong, how spread out is it) ---------- */
function riskCheck(S, P, F) {
  const v = tv(S, P), pos = Object.entries(P.holdings).map(([s, h]) => ({ s, w: h.qty * (pin(S, s) ?? h.avg) / v }));
  const out = { date: day(), value: Math.round(v), cashPct: r2(P.cash / v * 100), largest: null, volPct: 0, worstDayPct: 0, worstMonthPct: 0, avgCorr: null, byMarket: { India: 0, US: 0 } };
  pos.forEach(p => out.byMarket[isIN(p.s) ? 'India' : 'US'] += p.w * 100); for (const k in out.byMarket) out.byMarket[k] = r2(out.byMarket[k]);
  if (!pos.length) return out;
  pos.sort((a, b) => b.w - a.w); out.largest = { symbol: sh(pos[0].s), pct: r2(pos[0].w * 100) };
  const R = pos.map(p => { const c = F[p.s]?.closes || []; return c.slice(1).map((x, i) => x / c[i] - 1); });
  const n = Math.min(...R.map(r => r.length)); if (n < 20) return out;
  const T = R.map(r => r.slice(-n)), port = Array.from({ length: n }, (_, t) => pos.reduce((a, p, i) => a + p.w * T[i][t], 0));
  const mu = port.reduce((a, b) => a + b, 0) / n;
  out.volPct = r2(Math.sqrt(port.reduce((a, b) => a + (b - mu) ** 2, 0) / n * 252) * 100);
  out.worstDayPct = r2(Math.min(...port) * 100);
  let wm = 0; for (let t = 21; t <= n; t++) wm = Math.min(wm, port.slice(t - 21, t).reduce((a, b) => (1 + a) * (1 + b) - 1, 0)); out.worstMonthPct = r2(wm * 100);
  out.worstMonthLossINR = Math.round(v * wm);
  if (T.length > 1) {
    const corr = (a, b) => { const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n; let c = 0, va = 0, vb = 0;
      for (let t = 0; t < n; t++) { c += (a[t] - ma) * (b[t] - mb); va += (a[t] - ma) ** 2; vb += (b[t] - mb) ** 2; } return va && vb ? c / Math.sqrt(va * vb) : 0; };
    let s = 0, k = 0; for (let i = 0; i < T.length; i++) for (let j = i + 1; j < T.length; j++) { s += corr(T[i], T[j]); k++; }
    out.avgCorr = r2(s / k);
  }
  return out;
}

/* ---------- Claude ---------- */
const SYS = (id, open) => { const c = PF[id]; return `You are the AI portfolio manager of a PAPER portfolio for an Indian investor.
${c.profile}
Allowed: stocks and ETFs listed on NSE (symbol ending .NS) or on major US exchanges (plain ticker like VOO, BRK-B), bought for delivery. US symbols can be bought in fractional shares (as on Indian apps for US investing); Indian shares are whole numbers. No leverage, shorting, options, futures, crypto or penny stocks. You may pick any liquid symbol that fits this portfolio, not only the candidates listed; new symbols are checked for liquidity before buying.
Benchmark to beat after costs: ${c.benchName}. Costs: about ${CHARGES.IN}% per side in India and ${CHARGES.US}% per side for US symbols (currency conversion), so avoid needless trading.
Rules (enforced by code): at most ${c.maxHoldings} holdings, at most ${c.maxPosPct}% of the portfolio in one position, stop-loss ${c.stopLossPct}% below average cost, at most ${c.maxTradesPerDay} trades per run, keep ${c.minCashPct}% cash. ${c.cadence === 'weekly' ? 'You review this portfolio once a week.' : 'You review this portfolio every trading day.'}
Use the risk check in the data (volatility, worst day/month, concentration, correlation) like a risk desk would: keep the portfolio diversified and within a sensible risk level for this investor.
${open ? '' : 'Note: the Indian market is closed today; prices are the latest available.'}
Use web search (max 5) for the latest news on holdings, your best candidates and the macro picture.
End with ONLY a JSON object, no markdown fence:
{"market_view":"2-3 sentences","actions":[{"action":"BUY","symbol":"VOO","amount_inr":4000,"confidence":0.7,"reason":"short"},{"action":"SELL","symbol":"ITC.NS","qty":"ALL","confidence":0.65,"reason":"short"}]}
actions may be empty; confidence 0-1; amount_inr is in rupees; SELL qty is a number or "ALL". Use the exact symbol strings.`; };
async function claude(model, sys, msg) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw Error('ANTHROPIC_API_KEY secret is not set in the GitHub repo.');
  const M = [{ role: 'user', content: msg }], u = { input: 0, output: 0, searches: 0 };
  for (let i = 0; i < 5; i++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 4000, system: sys, messages: M,
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
const due = (P, d) => PF[P.id].cadence === 'weekly' ? P.lastRunWeek !== weekOf(d) : P.lastRunDate !== d;
async function runAI(S, P, model, manual, open) {
  const c = PF[P.id], log = [], d = day();
  const F = await prices(S, [MARKET, ...Object.keys(c.bench), ...Object.keys(P.holdings), ...c.seeds.split(' ')]);
  startBench(S, P); stops(S, P, log);
  P.risk = riskCheck(S, P, F);
  const v = tv(S, P);
  const brief = { date: d, time_ist: now(), usd_inr: r2(fxRate), cash_inr: Math.round(P.cash), total_value_inr: Math.round(v),
    return_since_start_pct: r2((v / c.capital - 1) * 100), benchmark_return_pct: r2((bv(S, P) / c.capital - 1) * 100),
    holdings: Object.entries(P.holdings).map(([s, h]) => ({ symbol: s, qty: h.qty, avg_cost_inr: r2(h.avg), since: h.since,
      weight_pct: r2(h.qty * (pin(S, s) ?? h.avg) / v * 100), pnl_pct: r2(((pin(S, s) ?? h.avg) / h.avg - 1) * 100), ...ind(F[s]) })),
    risk_check: P.risk,
    candidates: c.seeds.split(' ').filter(s => !P.holdings[s] && F[s]).map(s => ({ symbol: s, ...ind(F[s]) })),
    recent_trades: P.trades.slice(0, 10).map(t => ({ date: t.date, side: t.side, symbol: t.sym, qty: t.qty, price_inr: t.price })) };
  const { text, u } = await claude(model, SYS(P.id, open), 'Portfolio, risk check and market data (indicators in %, prices in each symbol\'s own currency):\n' + JSON.stringify(brief));
  const D = decide(text);
  let n = 0;
  const acts = (D.actions || []).filter(a => a && a.symbol).sort((x, y) => (x.action === 'SELL' ? 0 : 1) - (y.action === 'SELL' ? 0 : 1));
  for (const a of acts) {
    const s = String(a.symbol).trim().toUpperCase(), cf = +a.confidence || 0; let err;
    if (n >= c.maxTradesPerDay) { log.push(`Skipped ${sh(s)}: trade limit`); continue; }
    if (cf < c.minConfidence) { log.push(`Skipped ${a.action} ${sh(s)}: confidence ${cf}`); continue; }
    if (a.action === 'SELL') {
      const h = P.holdings[s]; if (!h) { log.push(`Skipped SELL ${sh(s)}: not held`); continue; }
      err = sell(S, P, s, a.qty === 'ALL' ? h.qty : isIN(s) ? Math.floor(+a.qty) : +a.qty, a.reason, cf);
    } else if (a.action === 'BUY') {
      if (!/^[A-Z0-9&-]+(\.NS|\.BO)?$/.test(s)) { log.push(`Skipped BUY ${s}: not a stock or ETF symbol`); continue; }
      if (!P.holdings[s] && Object.keys(P.holdings).length >= c.maxHoldings) { log.push(`Skipped BUY ${sh(s)}: max holdings`); continue; }
      if (!F[s]) { const q = await quote(s); if (liquid(q)) await prices(S, [s]); F[s] = S.prices[s] ? q : null; }
      if (!F[s] || !liquid(F[s])) { log.push(`Skipped BUY ${sh(s)}: not found or not liquid enough`); continue; }
      const room = tv(S, P) * c.maxPosPct / 100 - (P.holdings[s] ? P.holdings[s].qty * pin(S, s) : 0);
      const amt = Math.min(+a.amount_inr || 0, room, P.cash - tv(S, P) * c.minCashPct / 100);
      if (amt <= 0) { log.push(`Skipped BUY ${sh(s)}: no room (cash or ${c.maxPosPct}% limit)`); continue; }
      err = buy(S, P, s, amt, a.reason, cf);
    } else continue;
    if (err) log.push('Skipped: ' + err); else { n++; log.push((a.action === 'BUY' ? 'Bought ' : 'Sold ') + sh(s)); }
  }
  P.risk = riskCheck(S, P, F);
  const k = cost(model, u);
  P.runs.unshift({ date: d, time: now(), view: D.market_view, actions: D.actions || [], log, estCostUSD: k, manual });
  P.lastRunDate = d; P.lastRunWeek = weekOf(d); snap(S, P);
  return `${c.name}: ` + (log.length ? log.join(' · ') : 'held — no trades') + ` ($${k})`;
}
async function check(S) {
  const log = [], all = [MARKET];
  for (const P of Object.values(S.portfolios)) all.push(...Object.keys(P.holdings), ...(P.bench ? Object.keys(P.bench.units) : []));
  const F = await prices(S, all), open = S.prices[MARKET] && dayOf(S.prices[MARKET].time) === day();
  for (const P of Object.values(S.portfolios)) {
    if (!open || !P.bench) continue;
    stops(S, P, log); snap(S, P);
    const need = Object.keys(P.holdings).filter(s => !F[s]); if (need.length) Object.assign(F, await prices(S, need));
    P.risk = riskCheck(S, P, F);
  }
  S.lastCheck = now() + (log.length ? ' — ' + log.join(', ') : '');
  return 'Price check done.' + (log.length ? ' ' + log.join(', ') : '');
}
async function run(S, cfg, manual) {
  const d = day(), out = [];
  const m = await quote(MARKET); if (!m) throw Error('Could not get prices (Yahoo busy). Try again later.');
  const open = dayOf(m.time) === d;
  for (const id of IDS) {
    const P = S.portfolios[id];
    if (!manual && (cfg.paused || cfg.portfolios[id].paused)) { out.push(`${PF[id].name}: paused`); continue; }
    if (!manual && !due(P, d)) continue;
    if (!open && !FORCE) {
      if (PF[id].cadence === 'daily') { P.lastRunDate = d; P.runs.unshift({ date: d, time: now(), view: 'Market closed today (holiday/weekend) — no trades.', actions: [], log: [], estCostUSD: 0, manual }); }
      out.push(`${PF[id].name}: market closed`); continue;
    }
    try { out.push(await runAI(S, P, cfg.model, manual, open)); }
    catch (e) { const msg = '⚠ Run failed: ' + e.message; P.runs.unshift({ date: d, time: now(), view: msg, actions: [], log: [], estCostUSD: 0, manual }); out.push(`${PF[id].name}: ${msg}`); }
  }
  return out.length ? out.join('\n') : await check(S);
}

/* ---------- main ---------- */
const cfg = settings();
let S = readJSON(STATE);
if (!S || S.version !== 2 || MODE === 'reset') S = fresh();
for (const id of IDS) S.portfolios[id] ||= freshP(id);
S.settings = cfg; S.config = Object.fromEntries(IDS.map(id => { const { seeds, profile, ...c } = PF[id]; return [id, c]; })); S.charges = CHARGES;
const manual = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';
let msg;
try {
  const fq = await quote(FX); fxRate = fq?.price || S.fx; if (!fxRate) throw Error('Could not get the USD-INR rate. Try again later.');
  S.fx = r2(fxRate);
  if (MODE === 'reset') msg = 'All portfolios reset.';
  else if (MODE === 'check') msg = await check(S);
  else msg = await run(S, cfg, MODE === 'ai' && manual);
} catch (e) { msg = '⚠ ' + e.message; S.lastCheck = now() + ' — ' + msg; }
for (const P of Object.values(S.portfolios)) { P.runs = P.runs.slice(0, 120); P.trades = P.trades.slice(0, 500); }
S.updatedAt = now();
if (!existsSync('data')) mkdirSync('data');
writeFileSync(STATE, JSON.stringify(S, null, 1));
console.log(msg);
