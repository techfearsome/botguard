// Integration tests for the visitor-rendered preview routes:
//
//   GET /admin/pages/:id/preview
//   GET /admin/site/:slug/preview
//   GET /admin/campaigns/:id/preview/page/:kind
//
// The existing /admin/campaigns/:id/preview source-view route is left alone;
// these tests only cover the new visitor-rendered routes that don't trigger
// tracking, conversions, or write a Click row.

process.env.SESSION_SECRET = 'test-secret-must-be-at-least-16-chars';

const assert = require('assert');
const path = require('path');
const http = require('http');
const express = require('express');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

function fetchOnce(server, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      host: '127.0.0.1', port: server.address().port, path: urlPath,
      method: 'GET', headers,
    };
    const req = http.request(opts, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, body: buf, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Mock data layer - the admin route handlers expect Workspace, LandingPage,
// SitePage, and Campaign models. We provide a tiny in-memory fake.
// ---------------------------------------------------------------------------

let stubState;

function makeState() {
  return {
    workspace: { _id: 'ws1', slug: 'default', settings: {} },
    landingPages: [
      {
        _id: 'lp_offer',
        workspace_id: 'ws1',
        name: 'Offer',
        slug: 'main-offer',
        html_template: '<!DOCTYPE html><html><head><title>Offer</title></head><body>Hello {{utm_source}} from {{click_id}}</body></html>',
        kind: 'offer',
        auto_conversion: { enabled: true, terms: ['Buy'], event_name: 'purchase' },
      },
      {
        _id: 'lp_safe',
        workspace_id: 'ws1',
        name: 'Safe',
        slug: 'safe',
        html_template: '<!DOCTYPE html><html><head><title>Safe</title></head><body>SAFE</body></html>',
        kind: 'safe',
      },
    ],
    sitePages: [
      {
        _id: 'sp_home',
        workspace_id: 'ws1',
        slug: 'home',
        html: '<!DOCTYPE html><html><head><title>Home</title></head><body>HOME</body></html>',
        enabled: true,
        meta: {},
      },
    ],
    campaigns: [
      {
        _id: 'c1',
        workspace_id: 'ws1',
        name: 'Main Campaign',
        slug: 'main',
        landing_page_id: 'lp_offer',
        safe_page_id: 'lp_safe',
        device_pages: {},
        status: 'active',
      },
    ],
  };
}

// Mock the model layer used by admin/index.js. We do this by inserting our
// stubs into require.cache BEFORE requiring the admin router.
const modelsPath = require.resolve(path.resolve(__dirname, '../src/models'));
const stubModels = {
  Workspace: { findOne: async (q) => stubState.workspace },
  LandingPage: {
    findOne: (q) => ({
      lean: async () => stubState.landingPages.find((p) =>
        String(p._id) === String(q._id) && p.workspace_id === q.workspace_id) || null,
    }),
    find: () => ({ sort: () => ({ lean: async () => stubState.landingPages }) }),
    deleteOne: async () => ({ deletedCount: 1 }),
  },
  SitePage: {
    findOne: (q) => ({ lean: async () => stubState.sitePages.find((p) =>
      p.workspace_id === q.workspace_id && p.slug === q.slug && (q.enabled === undefined || p.enabled === q.enabled)) || null }),
    find: () => ({ select: () => ({ lean: async () => stubState.sitePages }) }),
    updateOne: async () => ({ matchedCount: 1 }),
    deleteOne: async () => ({ deletedCount: 1 }),
  },
  Campaign: {
    findOne: (q) => {
      const result = stubState.campaigns.find((c) => String(c._id) === String(q._id) && c.workspace_id === q.workspace_id) || null;
      return { lean: async () => result };
    },
    find: () => ({ sort: () => ({ lean: async () => stubState.campaigns }) }),
    deleteOne: async () => ({ deletedCount: 1 }),
  },
  Click: { find: () => ({ lean: async () => [] }) },
  Conversion: { find: () => ({ lean: async () => [] }) },
  AsnBlacklist: { find: () => ({ lean: async () => [] }) },
};
require.cache[modelsPath] = { exports: stubModels, loaded: true, id: modelsPath, filename: modelsPath };

// Stub the page resolver so campaign preview can find the right page
const pageResolverPath = require.resolve(path.resolve(__dirname, '../src/lib/pageResolver'));
require.cache[pageResolverPath] = {
  exports: {
    resolvePageForDevice: async (campaign, device, kind) => {
      const id = kind === 'safe' ? campaign.safe_page_id : campaign.landing_page_id;
      return stubState.landingPages.find((p) => String(p._id) === String(id)) || null;
    },
  },
  loaded: true, id: pageResolverPath, filename: pageResolverPath,
};

// Stub auth middleware - tests bypass auth
const authPath = require.resolve(path.resolve(__dirname, '../src/middleware/auth'));
require.cache[authPath] = {
  exports: {
    requireAdmin: (req, res, next) => next(),
    loginPage: (req, res) => res.send('login'),
    loginSubmit: (req, res) => res.send('login'),
    logout: (req, res) => res.send('logout'),
  },
  loaded: true, id: authPath, filename: authPath,
};

// Now require the admin router
const adminRouter = require(path.resolve(__dirname, '../src/routes/admin/index'));

const app = express();
app.set('trust proxy', true);
app.set('view engine', 'ejs');
app.set('views', path.resolve(__dirname, '../src/views'));
app.locals.localTime = require(path.resolve(__dirname, '../src/lib/localTime')).localTime;
app.locals.assetUrl = (p) => p;
app.use(express.urlencoded({ extended: true }));
app.use('/admin', adminRouter);

async function run() {
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));

  console.log('Landing page preview - GET /admin/pages/:id/preview:');

  await test('Returns 200 with rendered HTML', async () => {
    stubState = makeState();
    const r = await fetchOnce(server, '/admin/pages/lp_offer/preview');
    assert.strictEqual(r.status, 200);
    assert.ok(/text\/html/.test(r.headers['content-type']));
  });

  await test('Substitutes placeholders with friendly preview values', async () => {
    stubState = makeState();
    const r = await fetchOnce(server, '/admin/pages/lp_offer/preview');
    assert.ok(r.body.includes('Hello preview from preview-click-id'),
      `expected substituted text, got: ${r.body.slice(0, 400)}`);
  });

  await test('Custom UTM via query string overrides default placeholder', async () => {
    stubState = makeState();
    const r = await fetchOnce(server, '/admin/pages/lp_offer/preview?utm_source=facebook');
    assert.ok(r.body.includes('Hello facebook from'),
      `expected custom UTM, got: ${r.body.slice(0, 400)}`);
  });

  await test('Has WP fingerprint meta in output', async () => {
    stubState = makeState();
    const r = await fetchOnce(server, '/admin/pages/lp_offer/preview');
    assert.ok(/<meta name="generator" content="WordPress/.test(r.body));
  });

  await test('Does NOT inject auto-conversion script even when page has it enabled', async () => {
    stubState = makeState();
    // The fixture page has auto_conversion.enabled = true. Preview must skip it.
    const r = await fetchOnce(server, '/admin/pages/lp_offer/preview');
    assert.ok(!r.body.includes('bg-auto-conv-config'),
      'auto-conversion injected into preview - should be skipped');
  });

  await test('Does NOT inject heartbeat script', async () => {
    stubState = makeState();
    const r = await fetchOnce(server, '/admin/pages/lp_offer/preview');
    assert.ok(!r.body.includes('bg-heartbeat'),
      'heartbeat injected into preview - should be skipped');
  });

  await test('Sets X-Robots-Tag noindex (preview URLs must never be indexed)', async () => {
    stubState = makeState();
    const r = await fetchOnce(server, '/admin/pages/lp_offer/preview');
    assert.ok(/noindex/.test(r.headers['x-robots-tag']));
  });

  await test('Sets no-store cache headers', async () => {
    stubState = makeState();
    const r = await fetchOnce(server, '/admin/pages/lp_offer/preview');
    assert.ok(/no-store/.test(r.headers['cache-control']));
  });

  await test('Returns 404 for non-existent page id', async () => {
    stubState = makeState();
    const r = await fetchOnce(server, '/admin/pages/does_not_exist/preview');
    assert.strictEqual(r.status, 404);
  });

  console.log('\nSite page preview - GET /admin/site/:slug/preview:');

  await test('Returns 200 with rendered HTML for existing site page', async () => {
    stubState = makeState();
    const r = await fetchOnce(server, '/admin/site/home/preview');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes('HOME'));
  });

  await test('WP fingerprint injected on site page preview', async () => {
    stubState = makeState();
    const r = await fetchOnce(server, '/admin/site/home/preview');
    assert.ok(/<meta name="generator" content="WordPress/.test(r.body));
  });

  await test('Returns 404 for non-existent site slug', async () => {
    stubState = makeState();
    const r = await fetchOnce(server, '/admin/site/nonexistent/preview');
    assert.strictEqual(r.status, 404);
  });

  console.log('\nCampaign offer/safe preview - GET /admin/campaigns/:id/preview/page/:kind:');

  await test('Renders offer page for the campaign', async () => {
    stubState = makeState();
    const r = await fetchOnce(server, '/admin/campaigns/c1/preview/page/offer');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes('Hello preview from preview-click-id'));
  });

  await test('Renders safe page for the campaign', async () => {
    stubState = makeState();
    const r = await fetchOnce(server, '/admin/campaigns/c1/preview/page/safe');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes('SAFE'));
  });

  await test('Defaults to offer when kind is something unexpected', async () => {
    stubState = makeState();
    const r = await fetchOnce(server, '/admin/campaigns/c1/preview/page/garbage');
    assert.strictEqual(r.status, 200);
    // Should treat unknown kind as offer
    assert.ok(r.body.includes('Hello preview'));
  });

  await test('Returns 404 for non-existent campaign id', async () => {
    stubState = makeState();
    const r = await fetchOnce(server, '/admin/campaigns/nope/preview/page/offer');
    assert.strictEqual(r.status, 404);
  });

  await test('Source-view /admin/campaigns/:id/preview is unaffected', async () => {
    // Smoke check: the existing source-view route still returns text/plain
    // and is NOT shadowed by the new visitor-rendered route.
    stubState = makeState();
    const r = await fetchOnce(server, '/admin/campaigns/c1/preview');
    assert.strictEqual(r.status, 200);
    assert.ok(/text\/plain/.test(r.headers['content-type']),
      `expected text/plain for source view, got: ${r.headers['content-type']}`);
  });

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
