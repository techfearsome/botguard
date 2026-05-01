// Integration test: /go injects the auto-conversion script when the offer page has it enabled.

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
    http.get(`http://127.0.0.1:${port}${urlPath}`, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    }).on('error', reject);
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));

  function makeState({ autoConv } = {}) {
    cache.clearAll();
    return {
      workspace: { _id: 'ws1', slug: 'techfirio' },
      campaign: {
        _id: 'c1', workspace_id: 'ws1', slug: 'demo', name: 'Demo',
        status: 'active', source_profile: 'mixed',
        landing_page_id: 'p_offer', safe_page_id: 'p_safe',
        filter_config: { threshold: 70, mode: 'log_only' },
      },
      pages: {
        p_offer: {
          _id: 'p_offer',
          html_template: '<html><body><h1>Offer</h1><button>Download App</button></body></html>',
          variants: [],
          auto_conversion: autoConv,
        },
        p_safe: {
          _id: 'p_safe',
          html_template: '<html><body>SAFE PAGE</body></html>',
          variants: [],
          auto_conversion: autoConv,    // even if set, safe pages should NOT inject
        },
      },
      clicks: [],
    };
  }

  console.log('Auto-conversion injection in /go:');

  await test('No auto_conversion config → no injection', async () => {
    stubState = makeState({ autoConv: undefined });
    const r = await fetch(server, '/go/demo?utm_source=fb&utm_medium=cpc&utm_campaign=q4');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes('Download App'));
    assert.ok(!r.body.includes('bg-auto-conv-config'), 'should not inject when disabled');
  });

  await test('Disabled auto_conversion → no injection', async () => {
    stubState = makeState({ autoConv: { enabled: false, terms: ['Download'] } });
    const r = await fetch(server, '/go/demo?utm_source=fb&utm_medium=cpc&utm_campaign=q4');
    assert.ok(!r.body.includes('bg-auto-conv-config'));
  });

  await test('Enabled with terms → injection appears in HTML', async () => {
    stubState = makeState({ autoConv: { enabled: true, terms: ['Download', 'Subscribe'], event_name: 'install' } });
    const r = await fetch(server, '/go/demo?utm_source=fb&utm_medium=cpc&utm_campaign=q4');
    assert.ok(r.body.includes('bg-auto-conv-config'), 'config script tag missing');
    assert.ok(r.body.includes('"download"'), 'lowercased term not in JSON config');
    assert.ok(r.body.includes('"install"'), 'event_name not in JSON config');
  });

  await test('Injection placed before </body>', async () => {
    stubState = makeState({ autoConv: { enabled: true, terms: ['Download'], event_name: 'auto_click' } });
    const r = await fetch(server, '/go/demo?utm_source=fb&utm_medium=cpc&utm_campaign=q4');
    const bodyEndIdx = r.body.indexOf('</body>');
    const injectionIdx = r.body.indexOf('bg-auto-conv-config');
    assert.ok(injectionIdx > 0 && injectionIdx < bodyEndIdx, 'injection should be before </body>');
  });

  await test('Click record stores click_id usable by /cb/auto-conv', async () => {
    stubState = makeState({ autoConv: { enabled: true, terms: ['Download'], event_name: 'install' } });
    const r = await fetch(server, '/go/demo?utm_source=fb&utm_medium=cpc&utm_campaign=q4');
    assert.strictEqual(r.status, 200);
    const click = stubState.clicks[0];
    assert.ok(click.click_id);
    assert.match(click.click_id, /^[A-Za-z0-9_-]+$/);
  });

  // The CRITICAL test: never inject on safe pages, even if the page has auto_conversion enabled.
  // Otherwise blocked traffic could fire fake conversions.
  await test('Safe page never gets injection, even when blocked traffic hits it', async () => {
    stubState = makeState({ autoConv: { enabled: true, terms: ['Download'], event_name: 'auto_click' } });
    // Force the campaign to block by enabling UTM gate and not providing UTMs
    stubState.campaign.filter_config = {
      threshold: 70,
      mode: 'log_only',
      utm_gate: { enabled: true, required_keys: ['source', 'medium', 'campaign'] },
    };
    const r = await fetch(server, '/go/demo');     // no UTMs - gate fires
    assert.ok(r.body.includes('SAFE PAGE'), 'should be on safe page');
    assert.ok(!r.body.includes('bg-auto-conv-config'), 'CRITICAL: must not inject on safe page');
    const click = stubState.clicks[0];
    assert.strictEqual(click.decision, 'block');
  });

  // Critical for cross-campaign attribution: each new ad click must reset the dedup
  // cookie, otherwise visitors who converted on a previous ad are blocked from
  // converting on subsequent ads for up to 30 days.
  await test('Each /go visit clears the bg_conv dedup cookie on the response', async () => {
    stubState = makeState({ autoConv: { enabled: true, terms: ['Buy'], event_name: 'auto_click' } });
    const r = await fetch(server, '/go/demo?utm_source=fb&utm_medium=cpc&utm_campaign=q4');
    assert.strictEqual(r.status, 200);
    const setCookies = r.headers['set-cookie'] || [];
    // Should have set bg_cid (the click_id) AND bg_conv (cleared)
    const hasClickId = setCookies.some((c) => /^bg_cid=/.test(c));
    const clearsBgConv = setCookies.some((c) => /^bg_conv=;/.test(c) || /^bg_conv=$/.test(c.split(';')[0]));
    assert.ok(hasClickId, `bg_cid not set: ${setCookies.join(' | ')}`);
    assert.ok(clearsBgConv, `bg_conv not cleared: ${setCookies.join(' | ')}`);
  });

  await test('bg_conv clear is set on safe-page renders too (so new ad campaign can convert)', async () => {
    stubState = makeState({ autoConv: undefined });
    stubState.campaign.filter_config = {
      threshold: 70, mode: 'log_only',
      utm_gate: { enabled: true, required_keys: ['source', 'medium', 'campaign'] },
    };
    const r = await fetch(server, '/go/demo');     // no UTMs - safe page
    const setCookies = r.headers['set-cookie'] || [];
    const clearsBgConv = setCookies.some((c) => /^bg_conv=;/.test(c) || /^bg_conv=$/.test(c.split(';')[0]));
    // Even on safe page, the click cookie is set - so bg_conv should be cleared too
    // for consistency. Visitors hitting safe pages might come back via another ad click later.
    if (setCookies.some((c) => /^bg_cid=/.test(c))) {
      assert.ok(clearsBgConv, `bg_conv should be cleared even on safe-page renders: ${setCookies.join(' | ')}`);
    }
  });

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
