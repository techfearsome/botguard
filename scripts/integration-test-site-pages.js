// Integration tests for site pages: /, /privacy, /terms, /p/:slug

process.env.SESSION_SECRET = 'test-secret-must-be-at-least-16-chars';

const assert = require('assert');
const path = require('path');
const express = require('express');
const http = require('http');

// Stub the models BEFORE requiring the route
const modelsPath = path.resolve(__dirname, '../src/models');
let stubState;
require.cache[modelsPath + '.js'] = require.cache[modelsPath + '/index.js'] = {
  id: modelsPath, filename: modelsPath, loaded: true,
  exports: {
    Workspace: { findOne: async () => stubState.workspace },
    SitePage: {
      findOne: (q) => ({
        lean: async () => {
          return stubState.pages?.find(p =>
            p.workspace_id === q.workspace_id && p.slug === q.slug && (q.enabled === undefined || p.enabled === q.enabled)
          ) || null;
        }
      }),
    },
  },
};

const siteRouter = require(path.resolve(__dirname, '../src/routes/site'));
const app = express();
app.use('/', siteRouter);

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

  console.log('Site page routes:');

  await test('GET / serves home page when configured', async () => {
    stubState = {
      workspace: { _id: 'ws1', slug: 'techfirio' },
      pages: [{ workspace_id: 'ws1', slug: 'home', title: 'Welcome', html: '<h1>Hi</h1>', enabled: true }],
    };
    const r = await fetch(server, '/');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes('<h1>Hi</h1>'));
    assert.ok(r.body.includes('Welcome'));
    assert.match(r.headers['cache-control'] || '', /max-age=300/);
  });

  await test('GET / returns 404 when no home page configured (NOT a redirect to admin)', async () => {
    stubState = {
      workspace: { _id: 'ws1', slug: 'techfirio' },
      pages: [],
    };
    const r = await fetch(server, '/');
    assert.strictEqual(r.status, 404);
    // The whole point: not a redirect
    assert.ok(!r.headers.location, `should not redirect, got Location: ${r.headers.location}`);
    assert.ok(r.body.includes('not found') || r.body.includes('not configured'));
  });

  await test('GET /privacy serves privacy page', async () => {
    stubState = {
      workspace: { _id: 'ws1' },
      pages: [{ workspace_id: 'ws1', slug: 'privacy', title: 'Privacy Policy', html: '<p>Our policy</p>', enabled: true }],
    };
    const r = await fetch(server, '/privacy');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes('Our policy'));
  });

  await test('GET /terms serves terms page', async () => {
    stubState = {
      workspace: { _id: 'ws1' },
      pages: [{ workspace_id: 'ws1', slug: 'terms', title: 'Terms', html: '<p>ToS</p>', enabled: true }],
    };
    const r = await fetch(server, '/terms');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes('ToS'));
  });

  await test('GET /p/about serves arbitrary slug', async () => {
    stubState = {
      workspace: { _id: 'ws1' },
      pages: [{ workspace_id: 'ws1', slug: 'about', title: 'About', html: '<p>About us</p>', enabled: true }],
    };
    const r = await fetch(server, '/p/about');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes('About us'));
  });

  await test('Disabled page returns 404', async () => {
    stubState = {
      workspace: { _id: 'ws1' },
      pages: [{ workspace_id: 'ws1', slug: 'home', html: '<h1>Hi</h1>', enabled: false }],
    };
    const r = await fetch(server, '/');
    assert.strictEqual(r.status, 404);
  });

  await test('Page with full HTML doctype is served as-is', async () => {
    const fullHtml = '<!DOCTYPE html><html><head><title>X</title></head><body>X</body></html>';
    stubState = {
      workspace: { _id: 'ws1' },
      pages: [{ workspace_id: 'ws1', slug: 'home', html: fullHtml, enabled: true }],
    };
    const r = await fetch(server, '/');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body, fullHtml);   // exact match - no wrapping
  });

  await test('Page fragment is wrapped in HTML shell with title', async () => {
    stubState = {
      workspace: { _id: 'ws1' },
      pages: [{ workspace_id: 'ws1', slug: 'home', title: 'My Site', html: '<h1>Hi</h1>', enabled: true }],
    };
    const r = await fetch(server, '/');
    assert.ok(r.body.includes('<!DOCTYPE html>'));
    assert.ok(r.body.includes('<title>My Site</title>'));
    assert.ok(r.body.includes('<h1>Hi</h1>'));
  });

  await test('noindex page sets X-Robots-Tag header', async () => {
    stubState = {
      workspace: { _id: 'ws1' },
      pages: [{ workspace_id: 'ws1', slug: 'home', html: '<h1>Hi</h1>', enabled: true, meta: { noindex: true } }],
    };
    const r = await fetch(server, '/');
    assert.match(r.headers['x-robots-tag'] || '', /noindex/);
  });

  await test('Invalid /p/ slug returns 400', async () => {
    stubState = { workspace: { _id: 'ws1' }, pages: [] };
    const r = await fetch(server, '/p/bad..slug');
    assert.strictEqual(r.status, 400);
  });

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
