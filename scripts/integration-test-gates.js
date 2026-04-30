// Integration test: country and proxy gates routing through /go with stubbed network filter.

process.env.SESSION_SECRET = 'test-secret-must-be-at-least-16-chars';

const assert = require('assert');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const http = require('http');

// Stub Mongoose models
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

// Stub ProxyCheck so we control the country/proxy verdict per test
const proxycheckPath = path.resolve(__dirname, '../src/lib/proxycheck');
require.cache[proxycheckPath + '.js'] = {
  id: proxycheckPath, filename: proxycheckPath, loaded: true,
  exports: {
    lookup: async (ip) => stubState.proxyCheckResult,
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

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));

  const offerHtml = '<html><body>OFFER</body></html>';
  const safeHtml  = '<html><body>SAFE</body></html>';

  function makeState(filterConfig, proxyCheckResult) {
    cache.clearAll();    // ensure each test sees fresh campaign config
    return {
      workspace: { _id: 'ws1', slug: 'techfirio' },
      campaign: {
        _id: 'c1', workspace_id: 'ws1', slug: 'demo', name: 'Demo',
        status: 'active', source_profile: 'mixed',
        landing_page_id: 'page-offer', safe_page_id: 'page-safe',
        filter_config: { threshold: 70, mode: 'log_only', ...filterConfig },
      },
      pages: {
        'page-offer': { _id: 'page-offer', html_template: offerHtml, variants: [] },
        'page-safe':  { _id: 'page-safe',  html_template: safeHtml,  variants: [] },
      },
      clicks: [],
      proxyCheckResult,
    };
  }

  console.log('Country gate routing:');

  await test('US visitor + US whitelist → offer', async () => {
    stubState = makeState(
      { country_gate: { enabled: true, mode: 'whitelist', countries: ['US', 'CA'], on_unknown: 'allow' } },
      { ip: '1.2.3.4', asn: 7922, asn_org: 'Comcast', country: 'US', is_proxy: false, risk_score: 0, type: 'residential' }
    );
    const r = await fetch(server, '/go/demo?utm_source=fb&utm_medium=cpc&utm_campaign=q4');
    assert.ok(r.body.includes('OFFER'), r.body.slice(0,100));
    const click = stubState.clicks[0];
    assert.ok(click.scores.flags.includes('country_allowed_US'));
  });

  await test('CN visitor + US whitelist → safe page', async () => {
    stubState = makeState(
      { country_gate: { enabled: true, mode: 'whitelist', countries: ['US'], on_unknown: 'allow' } },
      { ip: '1.2.3.4', asn: 4134, asn_org: 'CHINANET', country: 'CN', is_proxy: false, risk_score: 0, type: 'residential' }
    );
    const r = await fetch(server, '/go/demo?utm_source=fb&utm_medium=cpc&utm_campaign=q4');
    assert.ok(r.body.includes('SAFE'), r.body.slice(0,100));
    const click = stubState.clicks[0];
    assert.strictEqual(click.decision, 'block');
    assert.match(click.decision_reason, /^country_gate:whitelist_block_CN$/);
    assert.ok(click.scores.flags.includes('country_blocked_CN'));
  });

  await test('CN visitor + CN/RU blacklist → safe page', async () => {
    stubState = makeState(
      { country_gate: { enabled: true, mode: 'blacklist', countries: ['CN', 'RU', 'KP'], on_unknown: 'allow' } },
      { ip: '1.2.3.4', country: 'CN', is_proxy: false, risk_score: 0, type: 'residential' }
    );
    const r = await fetch(server, '/go/demo?utm_source=fb&utm_medium=cpc&utm_campaign=q4');
    assert.ok(r.body.includes('SAFE'));
    const click = stubState.clicks[0];
    assert.match(click.decision_reason, /blacklist_block_CN/);
  });

  await test('US visitor + CN blacklist → offer (US not in list)', async () => {
    stubState = makeState(
      { country_gate: { enabled: true, mode: 'blacklist', countries: ['CN', 'RU'], on_unknown: 'allow' } },
      { ip: '1.2.3.4', country: 'US', is_proxy: false, risk_score: 0, type: 'residential' }
    );
    const r = await fetch(server, '/go/demo?utm_source=fb&utm_medium=cpc&utm_campaign=q4');
    assert.ok(r.body.includes('OFFER'));
  });

  await test('Unknown country + on_unknown=allow → offer', async () => {
    stubState = makeState(
      { country_gate: { enabled: true, mode: 'whitelist', countries: ['US'], on_unknown: 'allow' } },
      null   // ProxyCheck unavailable → null → no country
    );
    const r = await fetch(server, '/go/demo?utm_source=fb&utm_medium=cpc&utm_campaign=q4');
    assert.ok(r.body.includes('OFFER'));
  });

  await test('Unknown country + on_unknown=block → safe page', async () => {
    stubState = makeState(
      { country_gate: { enabled: true, mode: 'whitelist', countries: ['US'], on_unknown: 'block' } },
      null
    );
    const r = await fetch(server, '/go/demo?utm_source=fb&utm_medium=cpc&utm_campaign=q4');
    assert.ok(r.body.includes('SAFE'));
    const click = stubState.clicks[0];
    assert.match(click.decision_reason, /country_gate:whitelist_unknown/);
  });

  console.log('\nProxy gate routing:');

  await test('VPN detected + block_vpn=true → safe page', async () => {
    stubState = makeState(
      { proxy_gate: { enabled: true, block_vpn: true, block_tor: true, block_public_proxy: true, block_compromised: true, max_risk_score: 100 } },
      { ip: '1.2.3.4', country: 'US', is_proxy: true, proxy_type: 'VPN', risk_score: 75, type: 'hosting' }
    );
    const r = await fetch(server, '/go/demo?utm_source=fb&utm_medium=cpc&utm_campaign=q4');
    assert.ok(r.body.includes('SAFE'));
    const click = stubState.clicks[0];
    assert.match(click.decision_reason, /proxy_gate:vpn/);
  });

  await test('Tor detected + block_tor=true → safe page', async () => {
    stubState = makeState(
      { proxy_gate: { enabled: true, block_vpn: true, block_tor: true, block_public_proxy: true, block_compromised: true, max_risk_score: 100 } },
      { ip: '1.2.3.4', country: 'US', is_proxy: true, proxy_type: 'TOR', risk_score: 100, type: 'hosting' }
    );
    const r = await fetch(server, '/go/demo?utm_source=fb&utm_medium=cpc&utm_campaign=q4');
    assert.ok(r.body.includes('SAFE'));
    const click = stubState.clicks[0];
    assert.match(click.decision_reason, /proxy_gate:tor/);
  });

  await test('Clean IP, gate enabled → offer', async () => {
    stubState = makeState(
      { proxy_gate: { enabled: true, block_vpn: true, block_tor: true, block_public_proxy: true, block_compromised: true, max_risk_score: 100 } },
      { ip: '1.2.3.4', country: 'US', is_proxy: false, risk_score: 5, type: 'residential' }
    );
    const r = await fetch(server, '/go/demo?utm_source=fb&utm_medium=cpc&utm_campaign=q4');
    assert.ok(r.body.includes('OFFER'));
    const click = stubState.clicks[0];
    assert.ok(click.scores.flags.includes('proxy_gate_pass'));
  });

  await test('Hosting IP + block_hosting=false → offer', async () => {
    stubState = makeState(
      { proxy_gate: { enabled: true, block_vpn: true, block_tor: true, block_public_proxy: true, block_compromised: true, block_hosting: false, max_risk_score: 100 } },
      { ip: '1.2.3.4', country: 'US', is_proxy: false, risk_score: 30, type: 'hosting' }
    );
    const r = await fetch(server, '/go/demo?utm_source=fb&utm_medium=cpc&utm_campaign=q4');
    assert.ok(r.body.includes('OFFER'));
  });

  await test('Hosting IP + block_hosting=true → safe page', async () => {
    stubState = makeState(
      { proxy_gate: { enabled: true, block_vpn: true, block_tor: true, block_public_proxy: true, block_compromised: true, block_hosting: true, max_risk_score: 100 } },
      { ip: '1.2.3.4', country: 'US', is_proxy: false, risk_score: 30, type: 'hosting' }
    );
    const r = await fetch(server, '/go/demo?utm_source=fb&utm_medium=cpc&utm_campaign=q4');
    assert.ok(r.body.includes('SAFE'));
  });

  await test('Risk score 80 over max=70 → safe page', async () => {
    stubState = makeState(
      { proxy_gate: { enabled: true, block_vpn: true, block_tor: true, block_public_proxy: true, block_compromised: true, max_risk_score: 70 } },
      { ip: '1.2.3.4', country: 'US', is_proxy: false, risk_score: 80, type: 'residential' }
    );
    const r = await fetch(server, '/go/demo?utm_source=fb&utm_medium=cpc&utm_campaign=q4');
    assert.ok(r.body.includes('SAFE'));
    const click = stubState.clicks[0];
    assert.match(click.decision_reason, /proxy_gate:risk_score/);
  });

  console.log('\nGate ordering:');

  await test('UTM gate fires BEFORE country gate (no ProxyCheck call needed)', async () => {
    stubState = makeState(
      {
        utm_gate: { enabled: true, required_keys: ['source', 'medium', 'campaign'] },
        country_gate: { enabled: true, mode: 'whitelist', countries: ['US'], on_unknown: 'allow' },
      },
      { ip: '1.2.3.4', country: 'US', is_proxy: false }
    );
    // No UTMs
    const r = await fetch(server, '/go/demo');
    assert.ok(r.body.includes('SAFE'));
    const click = stubState.clicks[0];
    // UTM gate fired - decision_reason should mention utm_gate, not country_gate
    assert.match(click.decision_reason, /^utm_gate:/);
    // Country gate flags should NOT be present (we short-circuited before reaching it)
    assert.ok(!click.scores.flags.some((f) => f.startsWith('country_')));
  });

  await test('Country gate fires before proxy gate', async () => {
    stubState = makeState(
      {
        country_gate: { enabled: true, mode: 'whitelist', countries: ['US'] },
        proxy_gate: { enabled: true, block_vpn: true, block_tor: true, block_public_proxy: true, block_compromised: true, max_risk_score: 100 },
      },
      // VPN + non-whitelisted country - country fires first
      { ip: '1.2.3.4', country: 'CN', is_proxy: true, proxy_type: 'VPN', risk_score: 100 }
    );
    const r = await fetch(server, '/go/demo?utm_source=fb&utm_medium=cpc&utm_campaign=q4');
    assert.ok(r.body.includes('SAFE'));
    const click = stubState.clicks[0];
    assert.match(click.decision_reason, /^country_gate:/);
    assert.ok(!click.scores.flags.some((f) => f.startsWith('proxy_gate_')));
  });

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
