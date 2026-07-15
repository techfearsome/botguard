// Integration test: redirect campaign end-to-end.
//
// A redirect campaign runs the same filtering as a normal campaign; the only
// difference is the clean-traffic branch. Asserts:
//   1. Clean traffic + delay>0 → "redirecting…" interstitial with the dest URL,
//      page_rendered='redirect', and a RedirectLog written. No offer page.
//   2. Clean traffic + delay=0 → 302 to the destination.
//   3. Bad traffic (fails a gate) → SAFE page, NOT a redirect, no RedirectLog.
//   4. Invalid redirect_url → fails safe to the safe page.
//   5. A normal offer campaign is unaffected (still renders the offer).

process.env.SESSION_SECRET = 'test-secret-must-be-at-least-16-chars';

const assert = require('assert');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const http = require('http');

const modelsPath = path.resolve(__dirname, '../src/models');
require.cache[modelsPath + '.js'] = require.cache[modelsPath + '/index.js'] = {
  id: modelsPath, filename: modelsPath, loaded: true, exports: makeStubModels(),
};

let stubState;
function makeStubModels() {
  const queryLike = (value) => {
    const p = Promise.resolve(value);
    p.lean = () => p; p.select = () => p;
    return p;
  };
  return {
    Workspace: { findOne: () => queryLike(stubState.workspace) },
    Campaign: { findOne: () => queryLike(stubState.campaign), findById: () => queryLike(stubState.campaign) },
    LandingPage: { findById: (id) => queryLike(stubState.pages?.[id] || null) },
    Click: {
      findOne: (q) => queryLike([...stubState.clicks].reverse().find((c) => c.click_id === q?.click_id) || null),
      create: async (doc) => { stubState.clicks.push(doc); return doc; },
    },
    RedirectLog: { create: async (doc) => { stubState.redirectLogs.push(doc); return doc; } },
  };
}

const goRouter = require(path.resolve(__dirname, '../src/routes/go'));
const cache = require(path.resolve(__dirname, '../src/lib/cache'));

const app = express();
app.set('trust proxy', true);
app.use(cookieParser());
app.use('/go', goRouter);

const WIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

function request(server, { urlPath, headers = {} }) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const h = { 'User-Agent': WIN_UA, ...headers };
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET', headers: h }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

function baseState({ type = 'redirect', redirectUrl = 'https://dest.example/landing', delay = 1500, utmGate = false, redirectUrls = null }) {
  const campaign = {
      _id: 'c1', workspace_id: 'ws1', slug: 'demo', root_path: '', name: 'Redir',
      status: 'active', source_profile: 'mixed',
      campaign_type: type, redirect_url: redirectUrl, redirect_delay_ms: delay,
      landing_page_id: 'page-offer', safe_page_id: 'page-safe',
      filter_config: {
        threshold: 70, mode: 'log_only',
        utm_gate: utmGate ? { enabled: true, required_keys: ['utm_source'], safe_page_id: 'page-safe' } : { enabled: false },
      },
  };
  if (redirectUrls) campaign.redirect_urls = redirectUrls;
  return {
    workspace: { _id: 'ws1', slug: 'techfirio' },
    campaign,
    pages: {
      'page-offer': { _id: 'page-offer', kind: 'offer', html_template: '<html><body>OFFER_CONTENT</body></html>', variants: [] },
      'page-safe':  { _id: 'page-safe',  kind: 'safe',  html_template: '<html><body>SAFE_CONTENT</body></html>',  variants: [] },
    },
    clicks: [], redirectLogs: [],
  };
}

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));

  console.log('Redirect campaign:');

  await test('clean traffic (delay>0) → interstitial with dest URL + RedirectLog', async () => {
    cache.clearAll();
    stubState = baseState({ delay: 1500 });
    const r = await request(server, { urlPath: '/go/demo?utm_source=google' });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes('Redirecting'), 'should serve the redirect interstitial');
    assert.ok(r.body.includes('dest.example/landing'), 'interstitial should contain the destination');
    assert.ok(!r.body.includes('OFFER_CONTENT'), 'must NOT render the offer page');
    const click = stubState.clicks[stubState.clicks.length - 1];
    assert.strictEqual(click.page_rendered, 'redirect');
    assert.strictEqual(stubState.redirectLogs.length, 1, 'a RedirectLog should be written');
    assert.strictEqual(stubState.redirectLogs[0].destination_url, 'https://dest.example/landing');
  });

  await test('clean traffic (delay=0) → 302 to destination', async () => {
    cache.clearAll();
    stubState = baseState({ delay: 0 });
    const r = await request(server, { urlPath: '/go/demo' });
    assert.strictEqual(r.status, 302);
    assert.strictEqual(r.headers.location, 'https://dest.example/landing');
    assert.strictEqual(stubState.redirectLogs.length, 1);
  });

  await test('bad traffic (UTM gate fails) → SAFE page, no redirect, no log', async () => {
    cache.clearAll();
    stubState = baseState({ delay: 1500, utmGate: true });
    // No utm_source → gate fails → safe page.
    const r = await request(server, { urlPath: '/go/demo' });
    assert.ok(r.body.includes('SAFE_CONTENT'), 'blocked traffic should see the safe page');
    assert.ok(!r.body.includes('Redirecting'), 'no redirect for filtered traffic');
    assert.strictEqual(stubState.redirectLogs.length, 0, 'no RedirectLog for filtered traffic');
  });

  await test('invalid redirect_url → fails safe, no redirect, no log', async () => {
    cache.clearAll();
    stubState = baseState({ redirectUrl: 'javascript:alert(1)', delay: 1500 });
    const r = await request(server, { urlPath: '/go/demo' });
    assert.strictEqual(r.status, 200);
    assert.ok(!r.body.includes('Redirecting'), 'must not redirect on an invalid URL');
    assert.ok(r.body.includes('Page not available') || r.body.includes('SAFE_CONTENT'), 'should fail safe');
    assert.strictEqual(stubState.redirectLogs.length, 0, 'no RedirectLog on invalid URL');
  });

  console.log('\nDevice-specific redirect destinations:');

  await test('Windows visitor → windows-specific URL (not default)', async () => {
    cache.clearAll();
    stubState = baseState({
      delay: 0,
      redirectUrls: { default: 'https://default.example/', windows: 'https://windows.example/win' },
    });
    const r = await request(server, { urlPath: '/go/demo' }); // WIN_UA
    assert.strictEqual(r.status, 302);
    assert.strictEqual(r.headers.location, 'https://windows.example/win', 'should use the windows override');
    assert.strictEqual(stubState.redirectLogs[0].destination_url, 'https://windows.example/win');
  });

  await test('Device with no override → falls back to default', async () => {
    cache.clearAll();
    stubState = baseState({
      delay: 0,
      redirectUrls: { default: 'https://default.example/', iphone: 'https://iphone.example/' },
    });
    const r = await request(server, { urlPath: '/go/demo' }); // WIN_UA, no windows override
    assert.strictEqual(r.headers.location, 'https://default.example/', 'windows falls back to default');
  });

  console.log('\nBug fixes — scheme-less URL + invalid fallback:');

  await test('scheme-less stored URL → normalized absolute 302 (no relative/duplicated domain)', async () => {
    cache.clearAll();
    stubState = baseState({ delay: 0, redirectUrls: { default: 'cookingshow.space/indian-cooking' } });
    const r = await request(server, { urlPath: '/go/demo' });
    assert.strictEqual(r.status, 302);
    assert.strictEqual(r.headers.location, 'https://cookingshow.space/indian-cooking', 'must be absolute, not relative');
    assert.strictEqual(stubState.redirectLogs[0].destination_url, 'https://cookingshow.space/indian-cooking');
  });

  await test('truly invalid URL → CONFIGURED safe page (not built-in fallback)', async () => {
    cache.clearAll();
    // '/relative' has no host → normalization leaves it → validation rejects → safe page.
    stubState = baseState({ redirectUrl: '', redirectUrls: { default: '/relative-only' }, delay: 1500 });
    const r = await request(server, { urlPath: '/go/demo' });
    assert.ok(r.body.includes('SAFE_CONTENT'), 'should show the configured safe page, not the generic fallback');
    assert.ok(!r.body.includes('not available in your region'), 'must NOT show the built-in fallback when a safe page exists');
    assert.strictEqual(stubState.redirectLogs.length, 0);
  });

  console.log('\nRegression — offer campaign unaffected:');

  await test('offer campaign still renders the offer', async () => {
    cache.clearAll();
    stubState = baseState({ type: 'offer' });
    const r = await request(server, { urlPath: '/go/demo' });
    assert.ok(r.body.includes('OFFER_CONTENT'), 'offer campaign renders offer as before');
    assert.ok(!r.body.includes('Redirecting'));
    assert.strictEqual(stubState.redirectLogs.length, 0, 'offer campaigns never write RedirectLog');
  });

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
