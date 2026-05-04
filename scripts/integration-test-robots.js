// Integration tests for the /robots.txt and /sitemap.xml routes.
//
// What this proves:
//   1. /robots.txt returns text/plain with the right policy
//   2. /sitemap.xml returns application/xml with the right URLs
//   3. The routes are reachable BEFORE the catch-all route (otherwise they'd
//      404 because of the dot in their filenames not matching the regex
//      anyway, but we want explicit 200 responses)
//   4. Custom campaign root_paths show up as Disallow lines
//   5. The routes survive when the workspace has 0 site pages
//   6. BG_NO_INDEX=1 produces the staging-mode policy

process.env.SESSION_SECRET = 'test-secret-must-be-at-least-16-chars';

const assert = require('assert');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const http = require('http');

let stubState;
const queryLike = (value) => { const p = Promise.resolve(value); p.lean = () => p; return p; };
const findLike = (value) => ({
  select: () => ({ lean: async () => value }),
  lean: async () => value,
});

// Stub models BEFORE site.js requires them
const modelsPath = path.resolve(__dirname, '../src/models');
require.cache[modelsPath + '.js'] = require.cache[modelsPath + '/index.js'] = {
  id: modelsPath, filename: modelsPath, loaded: true,
  exports: {
    Workspace: { findOne: () => queryLike(stubState.workspace) },
    Campaign: { find: () => findLike(stubState.campaigns || []) },
    SitePage: {
      findOne: () => queryLike(null),
      find: () => findLike(stubState.sitePages || []),
    },
  },
};

const siteRouter = require(path.resolve(__dirname, '../src/routes/site'));

function makeApp() {
  const app = express();
  app.set('trust proxy', true);
  app.use(cookieParser());
  app.use('/', siteRouter);
  app.use((req, res) => res.status(404).send('NOT_FOUND'));
  return app;
}

function fetch(server, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, path: urlPath, method: 'GET', headers,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

function makeState() {
  return {
    workspace: {
      _id: 'ws1', slug: 'default', name: 'Default',
      settings: { block_ai_crawlers: false },
    },
    campaigns: [
      { root_path: 'promo' },
      { root_path: 'black-friday-2026' },
    ],
    sitePages: [
      { slug: 'home', updated_at: new Date('2026-04-01T00:00:00Z') },
      { slug: 'privacy', updated_at: new Date('2026-04-15T00:00:00Z') },
      { slug: 'terms', updated_at: new Date('2026-04-15T00:00:00Z') },
      { slug: 'about', updated_at: new Date('2026-04-20T00:00:00Z') },
    ],
  };
}

async function run() {
  const app = makeApp();
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));

  console.log('robots.txt:');

  await test('Returns text/plain content-type', async () => {
    stubState = makeState();
    siteRouter.clearAllCaches();
    const r = await fetch(server, '/robots.txt');
    assert.strictEqual(r.status, 200);
    assert.ok(r.headers['content-type'].startsWith('text/plain'));
  });

  await test('Does NOT set Cache-Control (matches stock WordPress response)', async () => {
    stubState = makeState();
    siteRouter.clearAllCaches();
    const r = await fetch(server, '/robots.txt');
    assert.strictEqual(r.headers['cache-control'], undefined);
  });

  await test('Does NOT set X-Robots-Tag (matches stock WordPress response)', async () => {
    stubState = makeState();
    siteRouter.clearAllCaches();
    const r = await fetch(server, '/robots.txt');
    assert.strictEqual(r.headers['x-robots-tag'], undefined);
  });

  await test('Body has WordPress-shaped opener (User-agent then wp-admin rules)', async () => {
    stubState = makeState();
    siteRouter.clearAllCaches();
    const r = await fetch(server, '/robots.txt');
    // First three non-empty lines should match WP's canonical opener.
    const lines = r.body.split('\n').filter(Boolean);
    assert.strictEqual(lines[0], 'User-agent: *');
    assert.strictEqual(lines[1], 'Disallow: /wp-admin/');
    assert.strictEqual(lines[2], 'Allow: /wp-admin/admin-ajax.php');
  });

  await test('Body has NO BotGuard comment lines (no fingerprint)', async () => {
    stubState = makeState();
    siteRouter.clearAllCaches();
    const r = await fetch(server, '/robots.txt');
    assert.ok(!/BotGuard/i.test(r.body), 'body mentions BotGuard');
    assert.ok(!/Generated dynamically/i.test(r.body));
  });

  await test('Disallows /admin/, /go/, /cb/, /lv/, /px/, /healthz', async () => {
    stubState = makeState();
    siteRouter.clearAllCaches();
    const r = await fetch(server, '/robots.txt');
    for (const p of ['/admin/', '/go/', '/cb/', '/lv/', '/px/', '/healthz']) {
      assert.ok(r.body.includes(`Disallow: ${p}`), `missing ${p}`);
    }
  });

  await test('Disallows custom campaign root_paths', async () => {
    stubState = makeState();
    siteRouter.clearAllCaches();
    const r = await fetch(server, '/robots.txt');
    assert.ok(r.body.includes('Disallow: /promo'));
    assert.ok(r.body.includes('Disallow: /black-friday-2026'));
  });

  await test('Allows /static/ explicitly', async () => {
    stubState = makeState();
    siteRouter.clearAllCaches();
    const r = await fetch(server, '/robots.txt');
    assert.ok(r.body.includes('Allow: /static/'));
  });

  await test('Sitemap reference uses request host', async () => {
    stubState = makeState();
    siteRouter.clearAllCaches();
    const r = await fetch(server, '/robots.txt', { Host: 'botguard.pagedrop.site' });
    assert.ok(r.body.includes('Sitemap:'));
    assert.ok(r.body.includes('botguard.pagedrop.site'));
  });

  await test('AI crawlers NOT blocked when block_ai_crawlers=false', async () => {
    stubState = makeState();
    siteRouter.clearAllCaches();
    const r = await fetch(server, '/robots.txt');
    assert.ok(!r.body.includes('GPTBot'));
  });

  await test('AI crawlers blocked when block_ai_crawlers=true', async () => {
    stubState = makeState();
    stubState.workspace.settings.block_ai_crawlers = true;
    siteRouter.clearAllCaches();
    const r = await fetch(server, '/robots.txt');
    assert.ok(r.body.includes('User-agent: GPTBot'));
    assert.ok(r.body.includes('User-agent: ClaudeBot'));
    assert.ok(r.body.includes('User-agent: Google-Extended'));
  });

  await test('BG_NO_INDEX=1 disallows everything', async () => {
    stubState = makeState();
    siteRouter.clearAllCaches();
    process.env.BG_NO_INDEX = '1';
    try {
      const r = await fetch(server, '/robots.txt');
      assert.ok(/Disallow: \/$/m.test(r.body));
      assert.ok(!r.body.includes('Disallow: /admin/'));
    } finally {
      delete process.env.BG_NO_INDEX;
      siteRouter.clearAllCaches();
    }
  });

  await test('Cache returns same body on second request', async () => {
    stubState = makeState();
    siteRouter.clearAllCaches();
    const r1 = await fetch(server, '/robots.txt');
    stubState.campaigns.push({ root_path: 'this-should-not-appear' });
    const r2 = await fetch(server, '/robots.txt');
    assert.strictEqual(r1.body, r2.body);
    assert.ok(!r2.body.includes('this-should-not-appear'));
  });

  await test('clearRobotsCache forces a rebuild', async () => {
    stubState = makeState();
    siteRouter.clearAllCaches();
    await fetch(server, '/robots.txt');
    stubState.campaigns.push({ root_path: 'fresh-promo' });
    siteRouter.clearRobotsCache();
    const r = await fetch(server, '/robots.txt');
    assert.ok(r.body.includes('fresh-promo'));
  });

  console.log('\nsitemap.xml:');

  await test('Returns application/xml content-type', async () => {
    stubState = makeState();
    siteRouter.clearAllCaches();
    const r = await fetch(server, '/sitemap.xml');
    assert.strictEqual(r.status, 200);
    assert.ok(/xml/.test(r.headers['content-type']));
  });

  await test('Does NOT set Cache-Control (consistent with robots.txt)', async () => {
    stubState = makeState();
    siteRouter.clearAllCaches();
    const r = await fetch(server, '/sitemap.xml');
    assert.strictEqual(r.headers['cache-control'], undefined);
  });

  await test('Lists site pages with correct URL structure', async () => {
    stubState = makeState();
    siteRouter.clearAllCaches();
    const r = await fetch(server, '/sitemap.xml', { Host: 'example.com' });
    assert.ok(/<loc>https?:\/\/example\.com\/<\/loc>/.test(r.body), `home url missing: ${r.body.slice(0, 300)}`);
    assert.ok(/<loc>https?:\/\/example\.com\/privacy<\/loc>/.test(r.body));
    assert.ok(/<loc>https?:\/\/example\.com\/terms<\/loc>/.test(r.body));
    assert.ok(/<loc>https?:\/\/example\.com\/p\/about<\/loc>/.test(r.body));
  });

  await test('Does NOT list any campaign URLs', async () => {
    stubState = makeState();
    siteRouter.clearAllCaches();
    const r = await fetch(server, '/sitemap.xml');
    assert.ok(!r.body.includes('/go/'));
    assert.ok(!r.body.includes('/promo'));
    assert.ok(!r.body.includes('/black-friday'));
  });

  await test('Includes <lastmod> for pages with updated_at', async () => {
    stubState = makeState();
    siteRouter.clearAllCaches();
    const r = await fetch(server, '/sitemap.xml');
    assert.ok(/<lastmod>2026-04-/.test(r.body));
  });

  await test('Excludes pages with meta.noindex=true', async () => {
    stubState = makeState();
    // Mark "about" as noindex - it should disappear from the sitemap.
    const aboutPage = stubState.sitePages.find((p) => p.slug === 'about');
    aboutPage.meta = { noindex: true };
    siteRouter.clearAllCaches();
    const r = await fetch(server, '/sitemap.xml');
    assert.ok(!r.body.includes('/p/about'), 'noindex page still in sitemap');
    // Other pages still present
    assert.ok(r.body.includes('/privacy'));
  });

  await test('New site pages appear after clearSitemapCache', async () => {
    // This proves the wiring: when admin saves a new SitePage, calling
    // clearSitemapCache() makes it visible on the next request.
    stubState = makeState();
    siteRouter.clearAllCaches();
    await fetch(server, '/sitemap.xml');     // populate cache
    stubState.sitePages.push({ slug: 'newly-added', updated_at: new Date('2026-05-01') });
    // Without cache clear, new page not visible:
    const cached = await fetch(server, '/sitemap.xml');
    assert.ok(!cached.body.includes('/p/newly-added'), 'cache should hide new page');
    // After clear:
    siteRouter.clearSitemapCache();
    const fresh = await fetch(server, '/sitemap.xml');
    assert.ok(fresh.body.includes('/p/newly-added'), 'new page should appear after cache clear');
  });

  await test('Returns valid empty sitemap when workspace has no pages', async () => {
    stubState = makeState();
    stubState.sitePages = [];
    siteRouter.clearAllCaches();
    const r = await fetch(server, '/sitemap.xml');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes('<urlset'));
    assert.ok(!r.body.includes('<url>'));
  });

  await test('Does NOT 500 when workspace is null', async () => {
    stubState = makeState();
    stubState.workspace = null;
    siteRouter.clearAllCaches();
    const r = await fetch(server, '/sitemap.xml');
    assert.strictEqual(r.status, 200);
  });

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
