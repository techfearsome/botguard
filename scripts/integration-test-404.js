// Integration tests for /admin/conversions and the configurable 404 page

process.env.SESSION_SECRET = 'test-secret-must-be-at-least-16-chars';

const assert = require('assert');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const http = require('http');

// ----- Stub models -----
const modelsPath = path.resolve(__dirname, '../src/models');
let stubState;

const queryLike = (value) => {
  const p = Promise.resolve(value);
  p.lean = () => p;
  p.populate = () => p;
  p.select = () => p;
  p.sort = () => p;
  p.limit = () => p;
  return p;
};

require.cache[modelsPath + '.js'] = require.cache[modelsPath + '/index.js'] = {
  id: modelsPath, filename: modelsPath, loaded: true,
  exports: {
    Workspace: { findOne: () => queryLike(stubState.workspace) },
    Campaign: {
      find: () => queryLike(stubState.campaigns || []),
    },
    LandingPage: {},
    Click: {
      find: (q) => {
        // The conversions route does Click.find({ click_id: { $in: ... } })
        // We just return all stub clicks
        return queryLike(stubState.clicks || []);
      },
    },
    Conversion: {
      find: () => queryLike(stubState.conversions || []),
    },
    SitePage: {
      findOne: (q) => queryLike(stubState.sitePages?.find(p =>
        p.slug === q.slug && (q.enabled === undefined || p.enabled === q.enabled)
      ) || null),
    },
    AsnBlacklist: {},
  },
};

const siteRouter = require(path.resolve(__dirname, '../src/routes/site'));

const app = express();
app.use(cookieParser());
app.use('/', siteRouter);
// Mimic server.js: app-wide 404 falls through to siteRouter.render404 for HTML clients
app.use((req, res) => {
  if (req.accepts('html')) return siteRouter.render404(req, res);
  res.status(404).json({ error: 'not_found' });
});

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

  console.log('Configurable 404 page:');

  await test('Unknown URL with no 404 page configured → hardcoded fallback', async () => {
    stubState = { workspace: { _id: 'ws1' }, sitePages: [] };
    const r = await fetch(server, '/this-does-not-exist', { 'Accept': 'text/html' });
    assert.strictEqual(r.status, 404);
    assert.ok(r.body.includes('not found') || r.body.includes('not configured'));
    // Should not be JSON
    assert.ok(!r.body.startsWith('{'));
  });

  await test('Unknown URL with custom 404 page → custom HTML served', async () => {
    stubState = {
      workspace: { _id: 'ws1' },
      sitePages: [{
        workspace_id: 'ws1', slug: '404',
        title: 'Lost?',
        html: '<h1>Brand Lost Page</h1><p>Try the <a href="/">homepage</a>.</p>',
        enabled: true,
      }],
    };
    const r = await fetch(server, '/whatever', { 'Accept': 'text/html' });
    assert.strictEqual(r.status, 404);
    assert.ok(r.body.includes('Brand Lost Page'), `body: ${r.body.slice(0,200)}`);
  });

  await test('404 page sets X-Robots-Tag noindex by default', async () => {
    stubState = {
      workspace: { _id: 'ws1' },
      sitePages: [{ workspace_id: 'ws1', slug: '404', html: '<p>404</p>', enabled: true }],
    };
    const r = await fetch(server, '/anywhere', { 'Accept': 'text/html' });
    assert.match(r.headers['x-robots-tag'] || '', /noindex/);
  });

  await test('404 page never cached', async () => {
    stubState = {
      workspace: { _id: 'ws1' },
      sitePages: [{ workspace_id: 'ws1', slug: '404', html: '<p>404</p>', enabled: true }],
    };
    const r = await fetch(server, '/anywhere', { 'Accept': 'text/html' });
    assert.match(r.headers['cache-control'] || '', /no-store/);
  });

  await test('Disabled 404 page → falls back to hardcoded HTML', async () => {
    stubState = {
      workspace: { _id: 'ws1' },
      sitePages: [{ workspace_id: 'ws1', slug: '404', html: '<p>Should not appear</p>', enabled: false }],
    };
    const r = await fetch(server, '/anywhere', { 'Accept': 'text/html' });
    assert.strictEqual(r.status, 404);
    assert.ok(!r.body.includes('Should not appear'));
  });

  await test('GET /privacy when not configured → falls through to 404 page (not redirect)', async () => {
    stubState = {
      workspace: { _id: 'ws1' },
      sitePages: [{ workspace_id: 'ws1', slug: '404', html: '<p>Custom 404</p>', enabled: true }],
    };
    const r = await fetch(server, '/privacy', { 'Accept': 'text/html' });
    assert.strictEqual(r.status, 404);
    assert.ok(r.body.includes('Custom 404'));
    assert.ok(!r.headers.location, 'should not redirect');
  });

  await test('Configured /privacy is served normally even with 404 page set', async () => {
    stubState = {
      workspace: { _id: 'ws1' },
      sitePages: [
        { workspace_id: 'ws1', slug: 'privacy', html: '<p>Privacy</p>', enabled: true },
        { workspace_id: 'ws1', slug: '404', html: '<p>404</p>', enabled: true },
      ],
    };
    const r = await fetch(server, '/privacy', { 'Accept': 'text/html' });
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes('Privacy'));
    assert.ok(!r.body.includes('404'));
  });

  await test('JSON client (Accept: application/json) gets JSON 404, not HTML', async () => {
    stubState = {
      workspace: { _id: 'ws1' },
      sitePages: [{ workspace_id: 'ws1', slug: '404', html: '<p>HTML 404</p>', enabled: true }],
    };
    const r = await fetch(server, '/api/whatever', { 'Accept': 'application/json' });
    assert.strictEqual(r.status, 404);
    assert.match(r.body, /^\s*\{/);
    assert.ok(!r.body.includes('HTML 404'));
  });

  await test('No infinite loop when /404 itself is requested with no config', async () => {
    stubState = { workspace: { _id: 'ws1' }, sitePages: [] };
    const r = await fetch(server, '/p/404', { 'Accept': 'text/html' });
    // Should return 404 with hardcoded HTML, not crash or loop
    assert.strictEqual(r.status, 404);
  });

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
