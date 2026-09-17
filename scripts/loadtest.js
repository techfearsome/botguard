#!/usr/bin/env node
/**
 * loadtest.js — BotGuard stress + detection-accuracy harness.
 *
 * Drives synthetic traffic at YOUR OWN BotGuard-protected domain through one or
 * more proxy pools (residential / datacenter), so you can measure two things at
 * once:
 *
 *   1. Throughput / latency under load (p50/p95/p99, error rate).
 *   2. Detection accuracy — does each pool get the decision it should?
 *        residential  -> expected mostly allow  (false-positive test)
 *        datacenter   -> expected mostly block  (true-positive test)
 *
 * Every request carries the secret LOADTEST_TOKEN header, so on the server side
 * these clicks are scored/decided normally but EXCLUDED from CIDR intelligence
 * and the Google Ads sync. Nothing you run here can poison production.
 *
 * ── SAFETY ─────────────────────────────────────────────────────────────────
 *   • Point this ONLY at domains you own. Driving proxy traffic at third parties
 *     is abuse and will get your IPs/pool burned.
 *   • Pause the Google Ads exclusion sync for the run window (belt-and-braces;
 *     the synthetic flag already excludes this traffic).
 *   • Prefer a staging deploy, or a window with real ad traffic paused, so the
 *     dashboard's conversion/ghost metrics aren't muddied by synthetic clicks.
 *
 * ── USAGE ──────────────────────────────────────────────────────────────────
 *   npm i undici           # if not already present
 *   node scripts/loadtest.js --config loadtest.config.json
 *
 * See loadtest.config.example.json for the shape. Requires Node 18+.
 */

'use strict';

const { ProxyAgent, request } = require('undici');
const fs = require('fs');
const path = require('path');

// ── Config ───────────────────────────────────────────────────────────────
function loadConfig() {
  const idx = process.argv.indexOf('--config');
  const cfgPath = idx !== -1 ? process.argv[idx + 1] : path.join(process.cwd(), 'loadtest.config.json');
  if (!fs.existsSync(cfgPath)) {
    console.error(`Config not found: ${cfgPath}\nCopy loadtest.config.example.json and fill it in.`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
}

const cfg = loadConfig();

// target_url: the FULL valid ad URL (utm + gclid + tm/ap) so traffic reaches the offer path.
// loadtest_token: must match the server's LOADTEST_TOKEN env var.
// pools: [{ label, proxy: "http://user:pass@host:port", expect: "allow"|"block" }]
// stages: [{ rps, seconds }]  — the ramp.
// max_requests: hard cap (kill switch).
const TARGET = cfg.target_url;
const TOKEN = cfg.loadtest_token;
const POOLS = cfg.pools || [];
const STAGES = cfg.stages || [{ rps: 1, seconds: 10 }, { rps: 5, seconds: 20 }, { rps: 20, seconds: 20 }, { rps: 50, seconds: 20 }];
const MAX_REQUESTS = cfg.max_requests || 5000;
const RUN_ID = cfg.run_id || `lt-${Date.now().toString(36)}`;

const USER_AGENTS = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
};
const UA_KEYS = Object.keys(USER_AGENTS);

// ── Per-pool stats ────────────────────────────────────────────────────────
function newStats() {
  return {
    sent: 0, ok: 0, errors: 0,
    status: {},            // http status -> count
    decision: {},          // inferred decision -> count (offer/safe/blocked/unknown)
    latencies: [],         // ms
  };
}
const stats = Object.fromEntries(POOLS.map((p) => [p.label, newStats()]));
const agents = Object.fromEntries(POOLS.map((p) => [p.label, new ProxyAgent(p.proxy)]));

let totalSent = 0;
let stopped = false;

// Build a per-request URL with a unique, filterable tag.
function buildUrl(pool) {
  const u = new URL(TARGET);
  // Tag every synthetic click so you can filter/delete them in the CMS afterward.
  u.searchParams.set('utm_content', `loadtest-${RUN_ID}-${pool.label}`);
  return u.toString();
}

// Infer what the server did from the response. The offer vs safe page differ;
// we can't see the DB, so we classify by status + a marker if present.
function classify(pool, statusCode, body) {
  const s = stats[pool.label];
  s.status[statusCode] = (s.status[statusCode] || 0) + 1;
  let decision = 'unknown';
  if (statusCode >= 500) decision = 'error';
  else if (statusCode >= 300 && statusCode < 400) decision = 'redirect';
  else if (statusCode === 200) {
    // Heuristic: safe pages and offer pages differ. If you add a hidden marker
    // to each page template (e.g. <!--bg:offer--> / <!--bg:safe-->), we read it.
    if (/bg:offer/.test(body)) decision = 'offer';
    else if (/bg:safe/.test(body)) decision = 'safe';
    else decision = 'served-200'; // couldn't tell which page; check Click Log
  }
  s.decision[decision] = (s.decision[decision] || 0) + 1;
}

async function fireOne(pool) {
  const s = stats[pool.label];
  const ua = USER_AGENTS[UA_KEYS[Math.floor(Math.random() * UA_KEYS.length)]];
  const url = buildUrl(pool);
  const started = process.hrtime.bigint();
  try {
    const res = await request(url, {
      dispatcher: agents[pool.label],
      method: 'GET',
      headers: {
        'user-agent': ua,
        'x-botguard-loadtest': TOKEN, // <- marks the click synthetic server-side
        'accept': 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.9',
      },
      bodyTimeout: 15000,
      headersTimeout: 15000,
    });
    const body = await res.body.text();
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    s.sent++; s.ok++; s.latencies.push(ms);
    classify(pool, res.statusCode, body);
  } catch (err) {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    s.sent++; s.errors++; s.latencies.push(ms);
    s.status[err.code || 'ERR'] = (s.status[err.code || 'ERR'] || 0) + 1;
    s.decision.error = (s.decision.error || 0) + 1;
  }
}

// ── Ramp driver ─────────────────────────────────────────────────────────
async function runStage(stage) {
  const perPoolRps = Math.max(1, Math.floor(stage.rps / POOLS.length));
  const intervalMs = 1000 / perPoolRps;
  const endAt = Date.now() + stage.seconds * 1000;
  console.log(`\n▶ Stage: ${stage.rps} RPS total (~${perPoolRps}/pool) for ${stage.seconds}s`);

  while (Date.now() < endAt && !stopped) {
    const tickStart = Date.now();
    for (const pool of POOLS) {
      if (totalSent >= MAX_REQUESTS) { stopped = true; break; }
      totalSent++;
      fireOne(pool); // fire-and-forget; we pace with the interval
    }
    const elapsed = Date.now() - tickStart;
    await sleep(Math.max(0, intervalMs - elapsed));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pct(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function report() {
  console.log(`\n════════ RESULTS  (run_id=${RUN_ID}) ════════`);
  for (const pool of POOLS) {
    const s = stats[pool.label];
    console.log(`\n── ${pool.label.toUpperCase()}  (expected: ${pool.expect || 'n/a'}) ──`);
    console.log(`   sent=${s.sent}  ok=${s.ok}  errors=${s.errors}`);
    console.log(`   latency ms:  p50=${pct(s.latencies, 50).toFixed(0)}  p95=${pct(s.latencies, 95).toFixed(0)}  p99=${pct(s.latencies, 99).toFixed(0)}`);
    console.log(`   status:   ${JSON.stringify(s.status)}`);
    console.log(`   decision: ${JSON.stringify(s.decision)}`);
  }
  console.log(`\nTotal requests: ${totalSent}`);
  console.log(`\nNote: "decision" is inferred from the HTTP response. For the exact`);
  console.log(`gate/score breakdown, filter the Click Log by utm_content=loadtest-${RUN_ID}-*`);
  console.log(`(these clicks are flagged is_synthetic and excluded from intelligence).`);
}

async function main() {
  if (!TARGET || !TOKEN || POOLS.length === 0) {
    console.error('Config must set target_url, loadtest_token, and at least one pool.');
    process.exit(1);
  }
  console.log(`BotGuard load test — run_id=${RUN_ID}`);
  console.log(`Target: ${TARGET}`);
  console.log(`Pools:  ${POOLS.map((p) => `${p.label}(${p.expect || '?'})`).join(', ')}`);
  console.log(`Cap:    ${MAX_REQUESTS} requests`);

  process.on('SIGINT', () => { console.log('\n⏹  Stopping…'); stopped = true; });

  for (const stage of STAGES) {
    if (stopped) break;
    await runStage(stage);
  }
  // Let in-flight requests settle.
  await sleep(2000);
  report();
  process.exit(0);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
