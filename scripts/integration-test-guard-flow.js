// Integration test: Level 2 Bot Guard end-to-end round-trip.
//
// Drives the real Express handler with stubbed Mongoose models and asserts:
//   1. Guarded device via /go/<slug>: interstitial served → POST /go/guard-verify
//      (good signals) → pass cookie set → return request renders the OFFER.
//   2. Failing signals → guard-verify sets a FAIL cookie → return renders SAFE.
//   3. Device NOT in the campaign's device allowlist → guard is skipped, OFFER
//      served directly (the "not all devices go through Level 2" contract).
//   4. CUSTOM URL (root_path) round-trip: same guarded flow reached via /promo,
//      with the interstitial's return_url pointing back at the custom path and
//      guard-verify redirecting there (not to /go/...).

process.env.SESSION_SECRET = 'test-secret-must-be-at-least-16-chars';

const assert = require('assert');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const http = require('http');

// ── Stub the Mongoose models BEFORE the route file requires them ──────────
const modelsPath = path.resolve(__dirname, '../src/models');
require.cache[modelsPath + '.js'] = require.cache[modelsPath + '/index.js'] = {
  id: modelsPath,
  filename: modelsPath,
  loaded: true,
  exports: makeStubModels(),
};

let stubState;
function makeStubModels() {
  const queryLike = (value) => {
    const p = Promise.resolve(value);
    p.lean = () => p;
    p.select = () => p;
    return p;
  };
  return {
    Workspace: { findOne: () => queryLike(stubState.workspace) },
    Campaign: {
      findOne: () => queryLike(stubState.campaign),
      findById: () => queryLike(stubState.campaign),
    },
    LandingPage: {
      findById: (id) => queryLike(stubState.pages?.[id] || null),
    },
    Click: {
      // find the most recently stored click by click_id (guard-verify uses this)
      findOne: (q) => {
        const cid = q?.click_id;
        const found = [...stubState.clicks].reverse().find((c) => c.click_id === cid) || null;
        // guard-verify calls .save() on the returned doc, so hand back a live ref
        if (found && typeof found.save !== 'function') found.save = async () => found;
        return queryLike(found);
      },
      create: async (doc) => { stubState.clicks.push(doc); return doc; },
    },
  };
}

const goRouter = require(path.resolve(__dirname, '../src/routes/go'));
const cache = require(path.resolve(__dirname, '../src/lib/cache'));
const { isReservedPath } = require(path.resolve(__dirname, '../src/lib/reservedPaths'));

const app = express();
app.set('trust proxy', true);
app.use(cookieParser());
app.use('/go', goRouter);

// Replicate server.js custom root_path route so /promo reaches the same handler.
app.get(/^\/([a-z0-9][a-z0-9_-]{1,63})$/, async (req, res, next) => {
  const candidate = req.params[0];
  if (isReservedPath(candidate)) return next();
  return goRouter.handleClick(req, res, {
    workspaceSlug: 'techfirio',
    lookupKind: 'root_path',
    lookupValue: candidate,
  });
});

// ── HTTP helper: GET/POST with headers + cookie jar ───────────────────────
function request(server, { method = 'GET', urlPath, headers = {}, body = null, cookies = {} }) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const cookieHeader = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const h = { 'User-Agent': headers['User-Agent'] || WIN_UA, ...headers };
    if (cookieHeader) h['Cookie'] = cookieHeader;
    let payload = null;
    if (body != null) { payload = JSON.stringify(body); h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(payload); }
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers: h }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers, cookies: parseSetCookie(res.headers['set-cookie']) }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function parseSetCookie(arr) {
  const jar = {};
  (arr || []).forEach((line) => {
    const [pair] = line.split(';');
    const idx = pair.indexOf('=');
    jar[pair.slice(0, idx)] = pair.slice(idx + 1);
  });
  return jar;
}

// Realistic UAs so uaParser classifies device_class correctly.
const WIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const GOOD_SIGNALS = {
  timezone: 'America/New_York', timezone_offset: 300,
  interacted: true, move_count: 5, scrolled: true,
  dwell_ms: 3000, screen: { w: 1920, h: 1080, avail_w: 1920, avail_h: 1040 },
  hardware_concurrency: 8, touch_support: false,
  language: 'en-US', platform: 'Win32',
};
const BAD_SIGNALS = {
  interacted: false, move_count: 0, scrolled: false,
  dwell_ms: 50, screen: { w: 0, h: 0 }, // zero screen → hard fail
  hardware_concurrency: 0, touch_support: false,
};

function baseState({ devices, slug = 'demo', rootPath = '' }) {
  const offerPageId = 'page-offer';
  const safePageId = 'page-safe';
  return {
    workspace: { _id: 'ws1', slug: 'techfirio' },
    campaign: {
      _id: 'c1', workspace_id: 'ws1', slug, root_path: rootPath, name: 'Demo',
      status: 'active', source_profile: 'mixed',
      landing_page_id: offerPageId, safe_page_id: safePageId,
      filter_config: {
        threshold: 70, mode: 'log_only',
        bot_guard: { enabled: true, devices, check_timezone: true, check_interaction: true, check_dwell: true, min_dwell_ms: 2000, check_webgl: false },
      },
    },
    pages: {
      [offerPageId]: { _id: offerPageId, kind: 'offer', html_template: '<html><body>OFFER_CONTENT</body></html>', variants: [] },
      [safePageId]:  { _id: safePageId,  kind: 'safe',  html_template: '<html><body>SAFE_CONTENT</body></html>',  variants: [] },
    },
    clicks: [],
  };
}

function extractToken(html) {
  const m = html.match(/var TOKEN = "([^"]+)"/);
  return m ? m[1] : null;
}

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));

  console.log('Bot Guard L2 round-trip (/go/<slug>):');

  await test('Guarded device → interstitial served (not the offer)', async () => {
    cache.clearAll();
    stubState = baseState({ devices: ['windows'] });
    const r = await request(server, { urlPath: '/go/demo', headers: { 'User-Agent': WIN_UA } });
    assert.strictEqual(r.status, 200);
    assert.ok(!r.body.includes('OFFER_CONTENT'), 'offer must NOT be shown before guard passes');
    assert.ok(r.body.includes('var TOKEN'), 'interstitial should embed a guard token');
    const guardClick = stubState.clicks.find((c) => c.page_rendered === 'guard');
    assert.ok(guardClick, 'a click with page_rendered=guard should be persisted');
  });

  await test('Good signals → guard-verify passes, cookie set, return renders OFFER', async () => {
    cache.clearAll();
    stubState = baseState({ devices: ['windows'] });
    const r1 = await request(server, { urlPath: '/go/demo', headers: { 'User-Agent': WIN_UA } });
    const token = extractToken(r1.body);
    assert.ok(token, 'token extracted from interstitial');

    const verify = await request(server, {
      method: 'POST', urlPath: '/go/guard-verify',
      headers: { 'User-Agent': WIN_UA },
      body: { token, ...GOOD_SIGNALS },
    });
    assert.strictEqual(verify.status, 200);
    const vjson = JSON.parse(verify.body);
    assert.ok(vjson.redirect, 'verify should return a redirect on pass');
    const passCookieName = Object.keys(verify.cookies).find((k) => k.startsWith('bg_guard_'));
    assert.ok(passCookieName && !passCookieName.startsWith('bg_guardfail_'), 'a pass cookie should be set');

    // Return trip carrying the pass cookie → offer is served.
    const r2 = await request(server, {
      urlPath: '/go/demo', headers: { 'User-Agent': WIN_UA },
      cookies: { [passCookieName]: verify.cookies[passCookieName] },
    });
    assert.strictEqual(r2.status, 200);
    assert.ok(r2.body.includes('OFFER_CONTENT'), `offer should render after passing, got: ${r2.body.slice(0, 120)}`);
  });

  await test('Bad signals → guard-verify fails, FAIL cookie set, return renders SAFE', async () => {
    cache.clearAll();
    stubState = baseState({ devices: ['windows'] });
    const r1 = await request(server, { urlPath: '/go/demo', headers: { 'User-Agent': WIN_UA } });
    const token = extractToken(r1.body);

    const verify = await request(server, {
      method: 'POST', urlPath: '/go/guard-verify',
      headers: { 'User-Agent': WIN_UA },
      body: { token, ...BAD_SIGNALS },
    });
    assert.strictEqual(verify.status, 200);
    const failCookieName = Object.keys(verify.cookies).find((k) => k.startsWith('bg_guardfail_'));
    assert.ok(failCookieName, 'a FAIL cookie should be set on failure');

    const r2 = await request(server, {
      urlPath: '/go/demo', headers: { 'User-Agent': WIN_UA },
      cookies: { [failCookieName]: verify.cookies[failCookieName] },
    });
    assert.ok(r2.body.includes('SAFE_CONTENT'), 'safe page should render after a failed guard');
    assert.ok(!r2.body.includes('OFFER_CONTENT'));
  });

  console.log('\nDevice targeting (skip path):');

  await test('Device NOT in allowlist → guard skipped, OFFER served directly', async () => {
    cache.clearAll();
    // Only windows is challenged; an iPhone visitor should bypass Level 2.
    stubState = baseState({ devices: ['windows'] });
    const r = await request(server, { urlPath: '/go/demo', headers: { 'User-Agent': IPHONE_UA } });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes('OFFER_CONTENT'), 'non-targeted device should get the offer, no interstitial');
    assert.ok(!r.body.includes('var TOKEN'), 'no interstitial should be served for a skipped device');
    assert.ok(!stubState.clicks.some((c) => c.page_rendered === 'guard'), 'no guard click should be logged');
  });

  await test('Device IN allowlist among several → still guarded', async () => {
    cache.clearAll();
    stubState = baseState({ devices: ['iphone', 'windows'] });
    const r = await request(server, { urlPath: '/go/demo', headers: { 'User-Agent': IPHONE_UA } });
    assert.ok(r.body.includes('var TOKEN'), 'iphone listed → interstitial expected');
  });

  console.log('\nCustom URL (root_path) round-trip:');

  await test('Guarded via /promo → interstitial return_url points back at /promo', async () => {
    cache.clearAll();
    stubState = baseState({ devices: ['windows'], rootPath: 'promo' });
    const r1 = await request(server, { urlPath: '/promo?gclid=abc123', headers: { 'User-Agent': WIN_UA } });
    assert.strictEqual(r1.status, 200);
    assert.ok(r1.body.includes('var TOKEN'), 'custom URL should serve the interstitial');
    assert.ok(!r1.body.includes('OFFER_CONTENT'));
    const token = extractToken(r1.body);

    const verify = await request(server, {
      method: 'POST', urlPath: '/go/guard-verify',
      headers: { 'User-Agent': WIN_UA },
      body: { token, ...GOOD_SIGNALS },
    });
    const vjson = JSON.parse(verify.body);
    assert.ok(/\/promo\?gclid=abc123$/.test(vjson.redirect), `redirect should return to the custom path, got: ${vjson.redirect}`);

    const passCookieName = Object.keys(verify.cookies).find((k) => k.startsWith('bg_guard_') && !k.startsWith('bg_guardfail_'));
    const r2 = await request(server, {
      urlPath: '/promo?gclid=abc123', headers: { 'User-Agent': WIN_UA },
      cookies: { [passCookieName]: verify.cookies[passCookieName] },
    });
    assert.ok(r2.body.includes('OFFER_CONTENT'), 'offer should render on the custom URL after passing');
  });

  await test('Custom URL, non-targeted device → offer served, no guard', async () => {
    cache.clearAll();
    stubState = baseState({ devices: ['windows'], rootPath: 'promo' });
    const r = await request(server, { urlPath: '/promo?gclid=xyz', headers: { 'User-Agent': IPHONE_UA } });
    assert.ok(r.body.includes('OFFER_CONTENT'));
    assert.ok(!r.body.includes('var TOKEN'));
  });

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
