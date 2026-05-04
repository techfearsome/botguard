// Integration tests for custom root-path campaign URLs.
//
// What this tests:
//   1. /<root_path> resolves to the correct campaign and serves the offer
//   2. /<root_path> for a paused campaign serves the safe page (status gate)
//   3. /<root_path> for an unknown path returns 404
//   4. Reserved paths (/admin, /privacy, /terms, /p/<x>) are NOT shadowed
//   5. Multi-segment paths fall through to 404 (don't accidentally match)
//   6. Uppercase / dot-paths / special chars don't match the catch-all
//   7. Campaign with root_path can ALSO still be reached at /go/<slug>
//
// Strategy: build a mini Express app that mirrors server.js's route order
// exactly (admin, site routes, custom root-path catch-all, 404).

process.env.SESSION_SECRET = 'test-secret-must-be-at-least-16-chars';

const assert = require('assert');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const http = require('http');

let stubState;
const queryLike = (value) => { const p = Promise.resolve(value); p.lean = () => p; return p; };

// Stub models BEFORE go.js / admin /etc require them
const modelsPath = path.resolve(__dirname, '../src/models');
require.cache[modelsPath + '.js'] = require.cache[modelsPath + '/index.js'] = {
  id: modelsPath, filename: modelsPath, loaded: true,
  exports: {
    Workspace: { findOne: () => queryLike(stubState.workspace) },
    Campaign: {
      findOne: (filter) => {
        const all = stubState.campaigns || [];
        // Match by either slug OR root_path depending on which the route asked for
        const found = all.find((c) => {
          if (filter.slug && c.slug !== filter.slug) return false;
          if (filter.root_path !== undefined && c.root_path !== filter.root_path) return false;
          if (filter.status && filter.status.$ne === 'archived' && c.status === 'archived') return false;
          if (filter.workspace_id && String(c.workspace_id) !== String(filter.workspace_id)) return false;
          // Need at least one filter to match by - either slug or root_path
          return filter.slug !== undefined || filter.root_path !== undefined;
        });
        return queryLike(found || null);
      },
    },
    LandingPage: { findById: async (id) => stubState.pages?.[id] || null },
    Click: {
      findOne: async () => null,
      create: async (doc) => { stubState.clicks.push(doc); return doc; },
    },
    AsnBlacklist: { find: () => ({ lean: async () => [] }) },
    SitePage: { findOne: () => queryLike(null) },   // default 404 fallback for site pages
  },
};

// Stub ProxyCheck so requests don't try to hit the live API
const proxycheckPath = path.resolve(__dirname, '../src/lib/proxycheck');
require.cache[proxycheckPath + '.js'] = {
  id: proxycheckPath, filename: proxycheckPath, loaded: true,
  exports: {
    lookup: async () => ({ ok: true, ip: '127.0.0.1', is_proxy: false, score: 0 }),
    clearCache: () => {},
  },
};

const goRouter = require(path.resolve(__dirname, '../src/routes/go'));
const { handleClick } = goRouter;
const { isReservedPath } = require(path.resolve(__dirname, '../src/lib/reservedPaths'));
const cache = require(path.resolve(__dirname, '../src/lib/cache'));

const app = express();
app.set('trust proxy', true);
app.use(cookieParser());

// Mirror server.js route order exactly:
// 1. /go (default)
app.use('/go', goRouter);

// 2. Stub admin (just confirm it gets a request - returns marker text)
app.use('/admin', (req, res) => res.status(200).send('ADMIN_HIT'));

// 3. Site routes (real ones for /privacy /terms /p/:slug /)
app.get('/', (req, res) => res.status(200).send('SITE_HOME'));
app.get('/privacy', (req, res) => res.status(200).send('SITE_PRIVACY'));
app.get('/terms', (req, res) => res.status(200).send('SITE_TERMS'));
app.get('/p/:slug', (req, res) => res.status(200).send('SITE_P_' + req.params.slug));
app.get('/healthz', (req, res) => res.json({ ok: true }));

// 4. Static (mounted via use to mimic real shape)
app.use('/static', (req, res) => res.status(200).send('STATIC_HIT'));

// 5. THE CATCH-ALL (the thing being tested)
app.get(/^\/([a-z0-9][a-z0-9_-]{1,63})$/, async (req, res, next) => {
  const candidate = req.params[0];
  if (isReservedPath(candidate)) return next();
  return handleClick(req, res, {
    workspaceSlug: 'default',
    lookupKind: 'root_path',
    lookupValue: candidate,
  });
});

// 6. 404
app.use((req, res) => res.status(404).send('NOT_FOUND'));

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

function makeState() {
  return {
    workspace: { _id: 'ws1', slug: 'default', settings: { default_threshold: 70, default_mode: 'log_only' } },
    campaigns: [
      {
        _id: 'c1',
        workspace_id: 'ws1',
        slug: 'main-promo',
        root_path: 'promo',
        name: 'Main Promo',
        status: 'active',
        landing_page_id: 'p_offer',
        safe_page_id: 'p_safe',
        device_pages: [],
        source_profile: 'mixed',
        filter_config: {
          threshold: 70, mode: 'log_only',
          utm_gate: { enabled: false, required_keys: [] },
          country_gate: { mode: 'off' },
          proxy_gate: { mode: 'off' },
        },
      },
      {
        _id: 'c2',
        workspace_id: 'ws1',
        slug: 'paused-campaign',
        root_path: 'paused-promo',
        name: 'Paused',
        status: 'paused',
        landing_page_id: 'p_offer',
        safe_page_id: 'p_safe',
        device_pages: [],
        source_profile: 'mixed',
        filter_config: {
          threshold: 70, mode: 'log_only',
          utm_gate: { enabled: false, required_keys: [] },
          country_gate: { mode: 'off' },
          proxy_gate: { mode: 'off' },
        },
      },
    ],
    pages: {
      p_offer: { _id: 'p_offer', name: 'Offer', slug: 'offer', html_template: '<html><body>OFFER_PAGE</body></html>', variants: [] },
      p_safe:  { _id: 'p_safe',  name: 'Safe',  slug: 'safe',  html_template: '<html><body>SAFE_PAGE</body></html>',  variants: [] },
    },
    clicks: [],
  };
}

function fetch(server, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, path: urlPath, method: 'GET',
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function run() {
  cache.clearAll && cache.clearAll();
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));

  console.log('Custom root-path resolution:');

  await test('GET /promo serves the offer (campaign found by root_path)', async () => {
    stubState = makeState();
    const r = await fetch(server, '/promo');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes('OFFER_PAGE'), `expected OFFER_PAGE, got: ${r.body.slice(0, 200)}`);
  });

  await test('GET /paused-promo serves SAFE page (paused campaign)', async () => {
    stubState = makeState();
    const r = await fetch(server, '/paused-promo');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes('SAFE_PAGE'), `expected SAFE_PAGE, got: ${r.body.slice(0, 200)}`);
  });

  await test('GET /unknown-path returns 404', async () => {
    stubState = makeState();
    const r = await fetch(server, '/nonexistent-campaign');
    assert.strictEqual(r.status, 404);
  });

  await test('Campaign at custom path is ALSO reachable at /go/<slug>', async () => {
    stubState = makeState();
    const r = await fetch(server, '/go/main-promo');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes('OFFER_PAGE'));
  });

  console.log('\nReserved-path protection:');

  await test('GET /admin is NOT shadowed (still hits admin handler)', async () => {
    stubState = makeState();
    const r = await fetch(server, '/admin');
    assert.strictEqual(r.body, 'ADMIN_HIT');
  });

  await test('GET /admin/foo is NOT shadowed', async () => {
    stubState = makeState();
    const r = await fetch(server, '/admin/foo');
    assert.strictEqual(r.body, 'ADMIN_HIT');
  });

  await test('GET / returns home page (root not shadowed)', async () => {
    stubState = makeState();
    const r = await fetch(server, '/');
    assert.strictEqual(r.body, 'SITE_HOME');
  });

  await test('GET /privacy returns site privacy page', async () => {
    stubState = makeState();
    const r = await fetch(server, '/privacy');
    assert.strictEqual(r.body, 'SITE_PRIVACY');
  });

  await test('GET /terms returns site terms page', async () => {
    stubState = makeState();
    const r = await fetch(server, '/terms');
    assert.strictEqual(r.body, 'SITE_TERMS');
  });

  await test('GET /p/something serves the site /p/:slug page', async () => {
    stubState = makeState();
    const r = await fetch(server, '/p/about-us');
    assert.strictEqual(r.body, 'SITE_P_about-us');
  });

  await test('GET /healthz still returns OK JSON', async () => {
    stubState = makeState();
    const r = await fetch(server, '/healthz');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes('"ok":true'));
  });

  await test('GET /static/css/admin.css hits the static handler', async () => {
    stubState = makeState();
    const r = await fetch(server, '/static/css/admin.css');
    assert.strictEqual(r.body, 'STATIC_HIT');
  });

  await test('Even with a campaign root_path="admin", /admin still wins (defense-in-depth)', async () => {
    stubState = makeState();
    // Plant an evil campaign that somehow got past validation
    stubState.campaigns.push({
      _id: 'evil', workspace_id: 'ws1', slug: 'evil', root_path: 'admin',
      status: 'active', landing_page_id: 'p_offer',
      filter_config: { threshold: 70, mode: 'log_only', utm_gate: { enabled: false }, country_gate: { mode: 'off' }, proxy_gate: { mode: 'off' } },
    });
    const r = await fetch(server, '/admin');
    assert.strictEqual(r.body, 'ADMIN_HIT', 'admin route was shadowed by malicious campaign!');
  });

  console.log('\nMalformed paths fall through to 404:');

  await test('GET /Promo (uppercase) does NOT match catch-all', async () => {
    stubState = makeState();
    const r = await fetch(server, '/Promo');
    // Catch-all regex requires lowercase, so this falls through to 404
    assert.strictEqual(r.status, 404);
  });

  await test('GET /promo/sub (multi-segment) falls through to 404', async () => {
    stubState = makeState();
    const r = await fetch(server, '/promo/sub');
    assert.strictEqual(r.status, 404);
  });

  await test('GET /promo.html (dotted) falls through to 404', async () => {
    stubState = makeState();
    const r = await fetch(server, '/promo.html');
    assert.strictEqual(r.status, 404);
  });

  await test('GET /a (1 char) falls through to 404 - regex requires 2+', async () => {
    stubState = makeState();
    const r = await fetch(server, '/a');
    assert.strictEqual(r.status, 404);
  });

  await test('GET /-promo (leading hyphen) falls through to 404', async () => {
    stubState = makeState();
    const r = await fetch(server, '/-promo');
    assert.strictEqual(r.status, 404);
  });

  await test('GET /favicon.ico falls through to 404 (dot-path)', async () => {
    stubState = makeState();
    const r = await fetch(server, '/favicon.ico');
    assert.strictEqual(r.status, 404);
  });

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
