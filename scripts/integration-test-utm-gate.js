// Integration test: verify UTM gate causes safe-page rendering without going through filter chain.
// Uses Express directly with stubbed Mongoose models.

process.env.SESSION_SECRET = 'test-secret-must-be-at-least-16-chars';

const assert = require('assert');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const http = require('http');

// Stub the Mongoose models BEFORE the route file requires them
const modelsPath = path.resolve(__dirname, '../src/models');
require.cache[modelsPath + '.js'] = require.cache[modelsPath + '/index.js'] = {
  id: modelsPath,
  filename: modelsPath,
  loaded: true,
  exports: makeStubModels(),
};

let stubState;
function makeStubModels() {
  // Helper: Mongoose Query objects support .lean(). Our stubs need to too.
  // Return a thenable that also has .lean() returning the same thenable.
  const queryLike = (value) => {
    const p = Promise.resolve(value);
    p.lean = () => p;
    return p;
  };
  return {
    Workspace: {
      findOne: (q) => queryLike(stubState.workspace),
    },
    Campaign: {
      findOne: (q) => queryLike(stubState.campaign),
    },
    LandingPage: {
      findById: async (id) => stubState.pages?.[id] || null,
    },
    Click: {
      findOne: async () => null,
      create: async (doc) => { stubState.clicks.push(doc); return doc; },
    },
  };
}

// Now require the go route - it will use our stubs
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
  const server = app.listen(0);   // ephemeral port
  await new Promise((r) => server.once('listening', r));

  console.log('UTM gate routing:');

  // Common workspace/campaign setup
  const wsId = 'ws1';
  const offerPageId = 'page-offer';
  const safePageId = 'page-safe';

  await test('Gate disabled → offer page rendered even without UTMs', async () => {
    cache.clearAll();
    stubState = {
      workspace: { _id: wsId, slug: 'techfirio' },
      campaign: {
        _id: 'c1', workspace_id: wsId, slug: 'demo', name: 'Demo',
        status: 'active', source_profile: 'mixed',
        landing_page_id: offerPageId, safe_page_id: safePageId,
        filter_config: { threshold: 70, mode: 'log_only', utm_gate: { enabled: false } },
      },
      pages: {
        [offerPageId]: { _id: offerPageId, html_template: '<html><body>OFFER</body></html>', variants: [] },
        [safePageId]:  { _id: safePageId,  html_template: '<html><body>SAFE</body></html>',  variants: [] },
      },
      clicks: [],
    };
    const r = await fetch(server, '/go/demo');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes('OFFER'), `body did not contain OFFER, got: ${r.body.slice(0,200)}`);
    assert.ok(!r.body.includes('SAFE'));
    assert.strictEqual(stubState.clicks[0].decision, 'allow');
  });

  await test('Gate enabled, UTMs missing → safe page, click marked blocked, no filter scoring', async () => {
    cache.clearAll();
    stubState = {
      workspace: { _id: wsId, slug: 'techfirio' },
      campaign: {
        _id: 'c2', workspace_id: wsId, slug: 'demo2',
        status: 'active', source_profile: 'mixed',
        landing_page_id: offerPageId, safe_page_id: safePageId,
        filter_config: {
          threshold: 70, mode: 'log_only',
          utm_gate: { enabled: true, required_keys: ['source', 'medium', 'campaign'] },
        },
      },
      pages: {
        [offerPageId]: { _id: offerPageId, html_template: '<html><body>OFFER</body></html>', variants: [] },
        [safePageId]:  { _id: safePageId,  html_template: '<html><body>SAFE</body></html>',  variants: [] },
      },
      clicks: [],
    };
    const r = await fetch(server, '/go/demo2');     // no UTMs at all
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes('SAFE'), `body should contain SAFE, got: ${r.body.slice(0,200)}`);
    assert.ok(!r.body.includes('OFFER'));
    const click = stubState.clicks[0];
    assert.strictEqual(click.decision, 'block');
    assert.match(click.decision_reason, /^utm_gate:/);
    assert.strictEqual(click.page_rendered, 'safe');
    assert.ok(click.scores.flags.includes('utm_gate_fail'));
    assert.ok(click.scores.flags.includes('utm_missing_source'));
    assert.ok(click.scores.flags.includes('utm_missing_medium'));
    assert.ok(click.scores.flags.includes('utm_missing_campaign'));
  });

  await test('Gate enabled, partial UTMs → safe page, only missing keys flagged', async () => {
    cache.clearAll();
    stubState = {
      workspace: { _id: wsId, slug: 'techfirio' },
      campaign: {
        _id: 'c3', workspace_id: wsId, slug: 'demo3',
        status: 'active', source_profile: 'mixed',
        landing_page_id: offerPageId, safe_page_id: safePageId,
        filter_config: {
          threshold: 70, mode: 'log_only',
          utm_gate: { enabled: true, required_keys: ['source', 'medium', 'campaign'] },
        },
      },
      pages: {
        [offerPageId]: { _id: offerPageId, html_template: '<html><body>OFFER</body></html>', variants: [] },
        [safePageId]:  { _id: safePageId,  html_template: '<html><body>SAFE</body></html>',  variants: [] },
      },
      clicks: [],
    };
    // source + medium present, campaign missing
    const r = await fetch(server, '/go/demo3?utm_source=fb&utm_medium=cpc');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes('SAFE'));
    const click = stubState.clicks[0];
    assert.strictEqual(click.decision, 'block');
    assert.ok(click.scores.flags.includes('utm_missing_campaign'));
    assert.ok(!click.scores.flags.includes('utm_missing_source'));
    assert.ok(!click.scores.flags.includes('utm_missing_medium'));
  });

  await test('Gate enabled, all UTMs present → offer page rendered (gate passes)', async () => {
    cache.clearAll();
    stubState = {
      workspace: { _id: wsId, slug: 'techfirio' },
      campaign: {
        _id: 'c4', workspace_id: wsId, slug: 'demo4',
        status: 'active', source_profile: 'mixed',
        landing_page_id: offerPageId, safe_page_id: safePageId,
        filter_config: {
          threshold: 70, mode: 'log_only',
          utm_gate: { enabled: true, required_keys: ['source', 'medium', 'campaign'] },
        },
      },
      pages: {
        [offerPageId]: { _id: offerPageId, html_template: '<html><body>OFFER</body></html>', variants: [] },
        [safePageId]:  { _id: safePageId,  html_template: '<html><body>SAFE</body></html>',  variants: [] },
      },
      clicks: [],
    };
    const r = await fetch(server, '/go/demo4?utm_source=newsletter&utm_medium=email&utm_campaign=launch');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes('OFFER'));
    const click = stubState.clicks[0];
    assert.notStrictEqual(click.decision, 'block');
  });

  await test('Gate enabled, no safe_page_id configured → falls back to built-in safe message', async () => {
    cache.clearAll();
    stubState = {
      workspace: { _id: wsId, slug: 'techfirio' },
      campaign: {
        _id: 'c5', workspace_id: wsId, slug: 'demo5',
        status: 'active', source_profile: 'mixed',
        landing_page_id: offerPageId,
        safe_page_id: null,                  // no safe page configured!
        filter_config: {
          threshold: 70, mode: 'log_only',
          utm_gate: { enabled: true, required_keys: ['source', 'medium', 'campaign'] },
        },
      },
      pages: {
        [offerPageId]: { _id: offerPageId, html_template: '<html><body>OFFER</body></html>', variants: [] },
      },
      clicks: [],
    };
    const r = await fetch(server, '/go/demo5');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes('Page not available'), `built-in safe fallback expected`);
    assert.ok(!r.body.includes('OFFER'));
  });

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
