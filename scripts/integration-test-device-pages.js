// Integration test: /go serves the right page per device class.

process.env.SESSION_SECRET = 'test-secret-must-be-at-least-16-chars';

const assert = require('assert');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const http = require('http');

// Stub models
const modelsPath = path.resolve(__dirname, '../src/models');
let stubState;
const queryLike = (value) => { const p = Promise.resolve(value); p.lean = () => p; return p; };
require.cache[modelsPath + '.js'] = require.cache[modelsPath + '/index.js'] = {
  id: modelsPath, filename: modelsPath, loaded: true,
  exports: {
    Workspace: { findOne: () => queryLike(stubState.workspace) },
    Campaign: {
      findOne: () => queryLike(stubState.campaign),
      findById: async () => stubState.campaign,
    },
    LandingPage: { findById: async (id) => stubState.pages?.[id] || null },
    Click: {
      findOne: async () => null,
      create: async (doc) => { stubState.clicks.push(doc); return doc; },
    },
    AsnBlacklist: { find: () => ({ lean: async () => [] }) },
  },
};

// Stub ProxyCheck so we don't hit the network
const proxycheckPath = path.resolve(__dirname, '../src/lib/proxycheck');
require.cache[proxycheckPath + '.js'] = {
  id: proxycheckPath, filename: proxycheckPath, loaded: true,
  exports: { lookup: async () => null, clearCache: () => {}, normalize: () => null },
};

const goRouter = require(path.resolve(__dirname, '../src/routes/go'));
const cache = require(path.resolve(__dirname, '../src/lib/cache'));
const app = express();
app.set('trust proxy', true);
app.use(cookieParser());
app.use('/go', goRouter);

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

function fetchWithUA(server, urlPath, ua) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    http.get({ host: '127.0.0.1', port, path: urlPath, headers: { 'User-Agent': ua } }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    }).on('error', reject);
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));

  console.log('Per-device page routing:');

  function makeState({ devicePages = {}, defaultOffer = 'p_default_offer', defaultSafe = 'p_default_safe' } = {}) {
    cache.clearAll();    // ensure each test sees fresh campaign config
    return {
      workspace: { _id: 'ws1', slug: 'techfirio' },
      campaign: {
        _id: 'c1', workspace_id: 'ws1', slug: 'demo', name: 'Demo',
        status: 'active', source_profile: 'mixed',
        landing_page_id: defaultOffer,
        safe_page_id: defaultSafe,
        device_pages: devicePages,
        filter_config: { threshold: 70, mode: 'log_only' },
      },
      pages: {
        p_default_offer: { _id: 'p_default_offer', html_template: '<html><body>DEFAULT_OFFER</body></html>', variants: [] },
        p_default_safe:  { _id: 'p_default_safe',  html_template: '<html><body>DEFAULT_SAFE</body></html>',  variants: [] },
        p_iphone_offer:  { _id: 'p_iphone_offer',  html_template: '<html><body>IPHONE_OFFER</body></html>',  variants: [] },
        p_android_offer: { _id: 'p_android_offer', html_template: '<html><body>ANDROID_OFFER</body></html>', variants: [] },
        p_windows_offer: { _id: 'p_windows_offer', html_template: '<html><body>WINDOWS_OFFER</body></html>', variants: [] },
      },
      clicks: [],
    };
  }

  const IPHONE_UA  = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
  const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36';
  const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';
  const MAC_UA     = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';

  await test('iPhone visitor with iphone override → iPhone offer', async () => {
    stubState = makeState({ devicePages: { iphone: { offer: 'p_iphone_offer' } } });
    const r = await fetchWithUA(server, '/go/demo', IPHONE_UA);
    assert.ok(r.body.includes('IPHONE_OFFER'), `body: ${r.body.slice(0,200)}`);
    assert.ok(!r.body.includes('DEFAULT_OFFER'));
  });

  await test('Android visitor with android override → Android offer', async () => {
    stubState = makeState({ devicePages: { android: { offer: 'p_android_offer' } } });
    const r = await fetchWithUA(server, '/go/demo', ANDROID_UA);
    assert.ok(r.body.includes('ANDROID_OFFER'));
  });

  await test('Mac visitor + only iPhone override → falls back to default', async () => {
    stubState = makeState({ devicePages: { iphone: { offer: 'p_iphone_offer' } } });
    const r = await fetchWithUA(server, '/go/demo', MAC_UA);
    assert.ok(r.body.includes('DEFAULT_OFFER'));
    assert.ok(!r.body.includes('IPHONE_OFFER'));
  });

  await test('Windows visitor with multiple device overrides → Windows offer', async () => {
    stubState = makeState({
      devicePages: {
        iphone:  { offer: 'p_iphone_offer' },
        android: { offer: 'p_android_offer' },
        windows: { offer: 'p_windows_offer' },
      },
    });
    const r = await fetchWithUA(server, '/go/demo', WINDOWS_UA);
    assert.ok(r.body.includes('WINDOWS_OFFER'));
  });

  await test('No overrides at all → default offer for everyone', async () => {
    stubState = makeState({ devicePages: {} });
    for (const ua of [IPHONE_UA, ANDROID_UA, MAC_UA, WINDOWS_UA]) {
      const r = await fetchWithUA(server, '/go/demo', ua);
      assert.ok(r.body.includes('DEFAULT_OFFER'), `default expected for UA: ${ua.slice(0,30)}`);
    }
  });

  await test('Click record stores device_class for iPhone visitor', async () => {
    stubState = makeState({});
    await fetchWithUA(server, '/go/demo', IPHONE_UA);
    const click = stubState.clicks[0];
    assert.strictEqual(click.ua_parsed.device_class, 'iphone');
  });

  await test('Click record stores device_class=android for Android visitor', async () => {
    stubState = makeState({});
    await fetchWithUA(server, '/go/demo', ANDROID_UA);
    const click = stubState.clicks[0];
    assert.strictEqual(click.ua_parsed.device_class, 'android');
  });

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
