// Integration test: workspace-level Clarity tracking is injected on every page
// rendered by /go - offer pages, safe pages, AND pages from gate short-circuits.

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

function fetch(server, urlPath) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));

  function makeState({ clarityId = 'wjsr5hjt53', utmGate = false } = {}) {
    cache.clearAll();
    return {
      workspace: {
        _id: 'ws1', slug: 'techfirio',
        settings: {
          tracking: { clarity_project_id: clarityId },
        },
      },
      campaign: {
        _id: 'c1', workspace_id: 'ws1', slug: 'demo', name: 'Demo',
        status: 'active', source_profile: 'mixed',
        landing_page_id: 'p_offer', safe_page_id: 'p_safe',
        filter_config: {
          threshold: 70, mode: 'log_only',
          utm_gate: utmGate ? { enabled: true, required_keys: ['source', 'medium', 'campaign'] } : { enabled: false },
        },
      },
      pages: {
        p_offer: {
          _id: 'p_offer',
          html_template: '<html><body><h1>Offer</h1><button>Buy</button></body></html>',
          variants: [],
        },
        p_safe: {
          _id: 'p_safe',
          html_template: '<html><body><h1>Safe Page</h1></body></html>',
          variants: [],
        },
      },
      clicks: [],
    };
  }

  console.log('Clarity tracking injection in /go:');

  await test('Clarity injected into offer page when configured', async () => {
    stubState = makeState({ clarityId: 'wjsr5hjt53' });
    const r = await fetch(server, '/go/demo?utm_source=fb&utm_medium=cpc&utm_campaign=q4');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes('Offer'));
    assert.ok(r.body.includes('clarity.ms/tag'), 'Clarity script should be injected');
    assert.ok(r.body.includes('"wjsr5hjt53"'), 'project ID should appear in injection');
  });

  await test('Clarity injected into safe page (gate-blocked traffic)', async () => {
    // UTM gate enabled, no UTMs → safe page rendered
    stubState = makeState({ clarityId: 'wjsr5hjt53', utmGate: true });
    const r = await fetch(server, '/go/demo');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes('Safe Page'));
    assert.ok(r.body.includes('clarity.ms/tag'), 'Clarity should ALSO load on safe pages');
    assert.ok(r.body.includes('"wjsr5hjt53"'));
  });

  await test('No injection when clarity_project_id is empty', async () => {
    stubState = makeState({ clarityId: '' });
    const r = await fetch(server, '/go/demo?utm_source=fb&utm_medium=cpc&utm_campaign=q4');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes('Offer'));
    assert.ok(!r.body.includes('clarity.ms/tag'), 'no Clarity script when ID empty');
  });

  await test('No injection when tracking settings missing entirely', async () => {
    stubState = makeState();
    delete stubState.workspace.settings;
    const r = await fetch(server, '/go/demo?utm_source=fb&utm_medium=cpc&utm_campaign=q4');
    assert.strictEqual(r.status, 200);
    assert.ok(!r.body.includes('clarity.ms/tag'));
  });

  await test('Clarity injected before </body>', async () => {
    stubState = makeState({ clarityId: 'wjsr5hjt53' });
    const r = await fetch(server, '/go/demo?utm_source=fb&utm_medium=cpc&utm_campaign=q4');
    const bodyEnd = r.body.indexOf('</body>');
    const clarityIdx = r.body.indexOf('clarity.ms/tag');
    assert.ok(clarityIdx > 0 && clarityIdx < bodyEnd, 'Clarity should be injected before </body>');
  });

  await test('Clarity coexists with auto-conversion injection (both fire)', async () => {
    stubState = makeState({ clarityId: 'wjsr5hjt53' });
    // Enable auto-conv on the offer page
    stubState.pages.p_offer.auto_conversion = {
      enabled: true,
      terms: ['buy'],
      event_name: 'purchase',
    };
    const r = await fetch(server, '/go/demo?utm_source=fb&utm_medium=cpc&utm_campaign=q4');
    assert.ok(r.body.includes('clarity.ms/tag'), 'Clarity present');
    assert.ok(r.body.includes('bg-auto-conv-config'), 'Auto-conversion present');
  });

  await test('Cache invalidation: workspace cache invalidated on settings save', async () => {
    // First request populates the cache
    stubState = makeState({ clarityId: 'oldid12345' });
    const r1 = await fetch(server, '/go/demo?utm_source=fb&utm_medium=cpc&utm_campaign=q4');
    assert.ok(r1.body.includes('"oldid12345"'));

    // Simulate admin saving new tracking settings:
    // 1. The workspace doc gets updated in Mongo
    stubState.workspace.settings.tracking.clarity_project_id = 'newid99999';
    // 2. The admin route calls cache.invalidateWorkspace
    await cache.invalidateWorkspace('techfirio');

    // Next request should see the new ID
    const r2 = await fetch(server, '/go/demo?utm_source=fb&utm_medium=cpc&utm_campaign=q4');
    assert.ok(r2.body.includes('"newid99999"'), `expected newid99999, body has: ${r2.body.match(/script[^"]*"\w+"\)/)}`);
    assert.ok(!r2.body.includes('"oldid12345"'));
  });

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
