// Integration tests for campaign on/off status (active / paused / archived).
//
// What this tests:
//   1. Active campaigns run the full pipeline (smoke check)
//   2. Paused campaigns ALWAYS render the safe page, regardless of:
//      - UTM gate config
//      - Country/proxy gate config
//      - The visitor's IP, country, or proxy status
//   3. Paused campaigns SKIP the ProxyCheck call entirely (cost optimization)
//   4. Paused campaigns still LOG the click with reason='campaign_paused'
//   5. Archived campaigns return 404 at /go (the lookup filters them out)

process.env.SESSION_SECRET = 'test-secret-must-be-at-least-16-chars';

const assert = require('assert');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const http = require('http');

// Track ProxyCheck invocations so we can assert they DON'T happen for paused campaigns
let proxyCheckCalls = 0;

// Stub Mongoose models
const modelsPath = path.resolve(__dirname, '../src/models');
let stubState;
const queryLike = (value) => { const p = Promise.resolve(value); p.lean = () => p; return p; };
require.cache[modelsPath + '.js'] = require.cache[modelsPath + '/index.js'] = {
  id: modelsPath, filename: modelsPath, loaded: true,
  exports: {
    Workspace: { findOne: () => queryLike(stubState.workspace) },
    Campaign: {
      // findOne respects the status:{ $ne: 'archived' } filter the route uses,
      // so archived campaigns return null (which the route renders as 404).
      findOne: (filter) => {
        const c = stubState.campaign;
        if (!c) return queryLike(null);
        // Apply the route's archived-filter
        if (filter && filter.status && filter.status.$ne === 'archived' && c.status === 'archived') {
          return queryLike(null);
        }
        return queryLike(c);
      },
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

// Stub ProxyCheck and count calls
const proxycheckPath = path.resolve(__dirname, '../src/lib/proxycheck');
require.cache[proxycheckPath + '.js'] = {
  id: proxycheckPath, filename: proxycheckPath, loaded: true,
  exports: {
    lookup: async (ip) => {
      proxyCheckCalls += 1;
      return stubState.proxyCheckResult;
    },
    clearCache: () => {},
  },
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

function fetch(server, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    http.get({ host: '127.0.0.1', port, path: urlPath, headers }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    }).on('error', reject);
  });
}

const offerHtml = '<html><body>OFFER PAGE</body></html>';
const safeHtml = '<html><body>SAFE PAGE</body></html>';

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));

  function makeState({ status = 'active', filterConfig = {}, proxyCheckResult } = {}) {
    cache.clearAll();
    proxyCheckCalls = 0;
    return {
      workspace: { _id: 'ws1', slug: 'techfirio' },
      campaign: {
        _id: 'c1', workspace_id: 'ws1', slug: 'demo', name: 'Demo',
        status,
        source_profile: 'mixed',
        landing_page_id: 'page-offer',
        safe_page_id: 'page-safe',
        filter_config: { threshold: 70, mode: 'log_only', ...filterConfig },
      },
      pages: {
        'page-offer': { _id: 'page-offer', html_template: offerHtml, variants: [] },
        'page-safe':  { _id: 'page-safe',  html_template: safeHtml,  variants: [] },
      },
      clicks: [],
      proxyCheckResult: proxyCheckResult || {
        ip: '1.2.3.4', asn: 7922, asn_org: 'Comcast', country: 'US',
        is_proxy: false, risk_score: 0, type: 'residential',
      },
    };
  }

  console.log('Active campaign (control):');

  await test('Active campaign + valid UTMs → offer page (full pipeline runs)', async () => {
    stubState = makeState({ status: 'active' });
    const r = await fetch(server, '/go/demo?utm_source=fb&utm_medium=cpc&utm_campaign=q4');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes('OFFER'), 'expected offer page');
    assert.strictEqual(stubState.clicks.length, 1);
    assert.strictEqual(stubState.clicks[0].decision, 'allow');
    assert.ok(proxyCheckCalls >= 1, 'ProxyCheck should run for active campaigns');
  });

  console.log('\nPaused campaign:');

  await test('Paused campaign + valid UTMs → safe page (no offer)', async () => {
    stubState = makeState({ status: 'paused' });
    const r = await fetch(server, '/go/demo?utm_source=fb&utm_medium=cpc&utm_campaign=q4');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes('SAFE'), `expected safe page, got: ${r.body.slice(0, 80)}`);
    assert.ok(!r.body.includes('OFFER'), 'must not include offer content');
  });

  await test('Paused campaign STILL LOGS the click with reason=campaign_paused', async () => {
    stubState = makeState({ status: 'paused' });
    await fetch(server, '/go/demo?utm_source=fb&utm_medium=cpc&utm_campaign=q4');
    assert.strictEqual(stubState.clicks.length, 1, 'click must be logged for audit');
    const click = stubState.clicks[0];
    assert.strictEqual(click.decision, 'block');
    assert.strictEqual(click.decision_reason, 'campaign_paused');
    assert.strictEqual(click.page_rendered, 'safe');
    assert.ok(click.scores.flags.includes('campaign_paused'),
      `expected campaign_paused in flags, got: ${click.scores.flags}`);
  });

  await test('Paused campaign SKIPS the ProxyCheck call (cost optimization)', async () => {
    stubState = makeState({ status: 'paused' });
    await fetch(server, '/go/demo?utm_source=fb&utm_medium=cpc&utm_campaign=q4');
    assert.strictEqual(proxyCheckCalls, 0,
      'ProxyCheck must not be called for paused campaigns - they short-circuit before network enrichment');
  });

  await test('Paused campaign + missing UTMs → still safe page (UTM gate not even consulted)', async () => {
    // The test here is that the UTM gate is bypassed entirely - the campaign
    // gate fires first.
    stubState = makeState({
      status: 'paused',
      filterConfig: {
        utm_gate: { enabled: true, required_keys: ['source', 'medium', 'campaign'] },
      },
    });
    const r = await fetch(server, '/go/demo');     // no UTMs
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes('SAFE'));
    const click = stubState.clicks[0];
    assert.strictEqual(click.decision_reason, 'campaign_paused',
      'reason should be campaign_paused, NOT a utm_gate reason');
  });

  await test('Paused campaign + IP from blocked country → still safe page', async () => {
    // Verify that even traffic that WOULD have been blocked anyway is reported
    // with reason=campaign_paused, not country_gate. This matters for audit
    // clarity - admins want to know "this is paused" not "this would have
    // been blocked".
    stubState = makeState({
      status: 'paused',
      filterConfig: {
        country_gate: { enabled: true, mode: 'whitelist', countries: ['US'] },
      },
      proxyCheckResult: {
        ip: '1.2.3.4', asn: 4134, asn_org: 'CHINANET', country: 'CN',
        is_proxy: false, risk_score: 0, type: 'residential',
      },
    });
    const r = await fetch(server, '/go/demo?utm_source=fb&utm_medium=cpc&utm_campaign=q4');
    assert.ok(r.body.includes('SAFE'));
    const click = stubState.clicks[0];
    assert.strictEqual(click.decision_reason, 'campaign_paused');
    // Country code wasn't even resolved because we never called ProxyCheck
    assert.strictEqual(proxyCheckCalls, 0);
  });

  await test('Paused campaign sets bg_cid cookie like normal /go visits', async () => {
    // The visitor still needs a click_id to be tracked in /admin/live and to
    // dedup conversions if they ever resume the campaign and visit again.
    stubState = makeState({ status: 'paused' });
    const r = await fetch(server, '/go/demo?utm_source=fb&utm_medium=cpc&utm_campaign=q4');
    const setCookies = r.headers['set-cookie'] || [];
    assert.ok(setCookies.some((c) => /^bg_cid=/.test(c)),
      `expected bg_cid cookie. Got: ${setCookies.join(' | ')}`);
  });

  await test('Paused campaign sets no-cache headers (so resume takes effect on next visit)', async () => {
    stubState = makeState({ status: 'paused' });
    const r = await fetch(server, '/go/demo?utm_source=fb&utm_medium=cpc&utm_campaign=q4');
    assert.match(r.headers['cache-control'] || '', /no-store|no-cache/);
  });

  console.log('\nArchived campaign:');

  await test('Archived campaign → 404 (URL is hidden)', async () => {
    stubState = makeState({ status: 'archived' });
    const r = await fetch(server, '/go/demo?utm_source=fb&utm_medium=cpc&utm_campaign=q4');
    assert.strictEqual(r.status, 404);
    // No click logged - the campaign isn't even found
    assert.strictEqual(stubState.clicks.length, 0);
  });

  console.log('\nState transitions (cache invalidation matters here in production):');

  await test('Toggling status active → paused changes routing on next request', async () => {
    // This simulates what happens after the admin clicks Pause: cache is
    // invalidated, next /go visit reflects the new status.
    stubState = makeState({ status: 'active' });
    const r1 = await fetch(server, '/go/demo?utm_source=fb&utm_medium=cpc&utm_campaign=q4');
    assert.ok(r1.body.includes('OFFER'));

    // Admin pauses the campaign
    stubState.campaign.status = 'paused';
    cache.clearAll();   // simulates cache.invalidateCampaign() running on toggle

    const r2 = await fetch(server, '/go/demo?utm_source=fb&utm_medium=cpc&utm_campaign=q4');
    assert.ok(r2.body.includes('SAFE'), 'after pause, traffic should switch to safe page');
  });

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
