#!/usr/bin/env node
/**
 * loadtestRunner.js — CMS-spawned stress-test runner.
 *
 * The admin UI (Tools -> Stress Test) spawns this as a CHILD PROCESS:
 *     node scripts/loadtestRunner.js --run-id <LoadTestRun _id>
 *
 * Running in its own process keeps traffic generation off the web server's
 * event loop, so latency numbers stay honest. It loads the run config + its
 * saved proxies from Mongo, fires synthetic Google/Facebook/X traffic through
 * the proxies (http OR socks5, both implemented natively — no dependencies),
 * then writes a result summary back onto the LoadTestRun document.
 *
 * Every request carries a unique "demo_"-prefixed id and is tagged
 * utm_content=synthtest-<run_tag>-<source> so the run's clicks are filterable
 * in the Click Log (and, if loadtest_token is set, flagged is_synthetic).
 */

'use strict';

const net = require('net');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const crypto = require('crypto');
const mongoose = require('mongoose');

function arg(name) { const i = process.argv.indexOf(`--${name}`); return i !== -1 ? process.argv[i + 1] : null; }
const RUN_ID = arg('run-id');
if (!RUN_ID) { console.error('missing --run-id'); process.exit(1); }

const BUILTIN_UAS = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
];
const SOURCES = [
  { name: 'google',   referer: 'https://www.googleadservices.com/', clickParam: 'gclid',  utm: { utm_source: 'google', utm_medium: 'cpc' },          clickId: () => 'Cj0K' + crypto.randomBytes(24).toString('base64url') },
  { name: 'facebook', referer: 'https://l.facebook.com/',           clickParam: 'fbclid', utm: { utm_source: 'facebook', utm_medium: 'paid_social' }, clickId: () => 'IwAR' + crypto.randomBytes(20).toString('base64url') },
  { name: 'x',        referer: 'https://t.co/',                     clickParam: 'twclid', utm: { utm_source: 'twitter', utm_medium: 'paid_social' },  clickId: () => crypto.randomBytes(16).toString('hex') },
];
const pick = (a) => a[Math.floor(Math.random() * a.length)];

// ── Native SOCKS5 CONNECT → returns a connected socket tunnelled to dest ────
function socks5Connect(proxy, destHost, destPort) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxy.port, proxy.host);
    let stage = 'greet';
    const fail = (m) => { socket.destroy(); reject(new Error(m)); };
    socket.setTimeout(15000, () => fail('socks5 timeout'));
    socket.once('error', (e) => reject(e));
    socket.once('connect', () => {
      socket.write(proxy.username ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]));
    });
    const onData = (chunk) => {
      if (stage === 'greet') {
        if (chunk[0] !== 0x05) return fail('bad socks version');
        if (chunk[1] === 0x00) { stage = 'connect'; sendConnect(); }
        else if (chunk[1] === 0x02) { stage = 'auth'; sendAuth(); }
        else return fail('socks5 no acceptable auth');
      } else if (stage === 'auth') {
        if (chunk[1] !== 0x00) return fail('socks5 auth failed');
        stage = 'connect'; sendConnect();
      } else if (stage === 'connect') {
        if (chunk[1] !== 0x00) return fail('socks5 connect rep=' + chunk[1]);
        socket.removeListener('data', onData);
        socket.setTimeout(0);
        resolve(socket);
      }
    };
    socket.on('data', onData);
    function sendAuth() {
      const u = Buffer.from(proxy.username || ''); const p = Buffer.from(proxy.password || '');
      socket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
    }
    function sendConnect() {
      const h = Buffer.from(destHost);
      socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, h.length]), h, Buffer.from([(destPort >> 8) & 0xff, destPort & 0xff])]));
    }
  });
}

// ── HTTP CONNECT → returns a connected socket ───────────────────────────────
function httpConnect(proxy, destHost, destPort) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (proxy.username) headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64');
    const req = http.request({ host: proxy.host, port: proxy.port, method: 'CONNECT', path: `${destHost}:${destPort}`, headers });
    req.on('connect', (res, socket) => { if (res.statusCode !== 200) return reject(new Error('PROXY_' + res.statusCode)); resolve(socket); });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('PROXY_TIMEOUT')); });
    req.end();
  });
}

// ── One request through a proxy (or direct if proxy is null) ────────────────
function fire(run, proxy, source, ua, url) {
  return new Promise(async (resolve) => {
    const started = Date.now();
    const done = (ok, status) => resolve({ ok, status, ms: Date.now() - started });
    const headers = {
      'user-agent': ua, 'referer': source.referer,
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9', 'upgrade-insecure-requests': '1',
    };
    if (run.loadtest_token) headers['x-botguard-loadtest'] = run.loadtest_token;
    const port = url.port || (url.protocol === 'https:' ? 443 : 80);

    try {
      let socket = null;
      if (proxy) {
        socket = proxy.protocol === 'socks5'
          ? await socks5Connect(proxy, url.hostname, port)
          : await httpConnect(proxy, url.hostname, port);
      }
      const opts = {
        hostname: url.hostname, port, path: url.pathname + url.search, method: 'GET', headers,
        ...(socket ? { socket, agent: false, servername: url.hostname } : {}),
      };
      const lib = url.protocol === 'https:' ? https : http;
      const req = lib.request(opts, (res) => { res.on('data', () => {}); res.on('end', () => done(true, res.statusCode)); });
      req.on('error', (e) => done(false, e.code || e.message || 'ERR'));
      req.setTimeout(15000, () => { req.destroy(); done(false, 'TIMEOUT'); });
      req.end();
    } catch (e) {
      done(false, e.code || e.message || 'PROXY_ERR');
    }
  });
}

function buildUrl(run, source) {
  const u = new URL(run.target_url);
  u.searchParams.set(source.clickParam, source.clickId());
  if (run.include_utm_gate) {
    for (const [k, v] of Object.entries(source.utm)) u.searchParams.set(k, v);
    // utm_campaign is expected to already be on target_url; leave as-is.
  } else {
    // Omit utm_* so the UTM gate sees no attribution (tests the gate blocking).
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term'].forEach((k) => u.searchParams.delete(k));
  }
  u.searchParams.set('utm_content', `synthtest-${run.run_tag}-${source.name}`);
  u.searchParams.set('demo_cid', `demo_${run.run_tag}_${crypto.randomBytes(6).toString('hex')}`);
  return u;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function pctile(a, p) { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; }

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const LoadTestRun = require('../src/models/LoadTestRun');
  const SavedProxy = require('../src/models/SavedProxy');

  const run = await LoadTestRun.findById(RUN_ID);
  if (!run) { console.error('run not found'); process.exit(1); }

  await LoadTestRun.updateOne({ _id: run._id }, { $set: { status: 'running', started_at: new Date(), error: '' } });

  const proxies = run.proxy_ids && run.proxy_ids.length ? await SavedProxy.find({ _id: { $in: run.proxy_ids } }).lean() : [];
  const uas = run.ua_mode === 'custom' && run.custom_uas.length ? run.custom_uas : BUILTIN_UAS;
  const w = String(run.weights || '60,25,15').split(',').map((n) => parseInt(n, 10));
  const weighted = []; SOURCES.forEach((s, i) => { for (let k = 0; k < (w[i] || 1); k++) weighted.push(s); });

  const bySource = {}; SOURCES.forEach((s) => bySource[s.name] = { sent: 0, ok: 0, err: 0, status: {} });
  const byPool = {}; (proxies.length ? proxies.map((p) => p.name) : ['direct']).forEach((l) => byPool[l] = { sent: 0, ok: 0, err: 0, status: {} });
  const lat = [];
  let done = 0;

  const rec = (b, r) => { b.sent++; if (r.ok) b.ok++; else b.err++; b.status[r.status] = (b.status[r.status] || 0) + 1; };
  const interval = 1000 / Math.max(1, run.rps);

  for (let i = 0; i < run.count; i++) {
    const source = pick(weighted);
    const ua = pick(uas);
    const proxy = proxies.length ? pick(proxies) : null;
    const url = buildUrl(run, source);
    const t0 = Date.now();
    fire(run, proxy, source, ua, url).then((r) => {
      lat.push(r.ms); rec(bySource[source.name], r); rec(byPool[proxy ? proxy.name : 'direct'], r); done++;
    });
    await sleep(Math.max(0, interval - (Date.now() - t0)));
  }
  // Let in-flight settle.
  const until = Date.now() + 20000;
  while (done < run.count && Date.now() < until) await sleep(200);

  const ok = Object.values(bySource).reduce((a, s) => a + s.ok, 0);
  const err = Object.values(bySource).reduce((a, s) => a + s.err, 0);
  await LoadTestRun.updateOne({ _id: run._id }, {
    $set: {
      status: 'done', finished_at: new Date(),
      results: {
        total_sent: done, ok, errors: err,
        p50_ms: pctile(lat, 50), p95_ms: pctile(lat, 95), p99_ms: pctile(lat, 99),
        by_pool: byPool, by_source: bySource,
      },
    },
  });
  console.log(`run ${RUN_ID} done: sent=${done} ok=${ok} err=${err}`);
  await mongoose.disconnect();
  process.exit(0);
}

main().catch(async (e) => {
  try { const LoadTestRun = require('../src/models/LoadTestRun'); await LoadTestRun.updateOne({ _id: RUN_ID }, { $set: { status: 'error', error: e.message, finished_at: new Date() } }); } catch (_) {}
  console.error('RUNNER ERROR:', e.message);
  process.exit(1);
});
