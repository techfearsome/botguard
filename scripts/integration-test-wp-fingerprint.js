// Tests for the WordPress fingerprint surface.
//
// What this proves:
//   1. /wp-login.php returns WP-shaped HTML (login form, body class, error block)
//   2. /wp-admin/ redirects to /wp-login.php
//   3. /wp-admin/admin-ajax.php returns "0" with status 200
//   4. /xmlrpc.php returns the canonical text and fault response
//   5. /wp-json/ returns plausible REST API JSON
//   6. /readme.html returns version-disclosure HTML
//   7. setPingbackHeader and injectWpMeta helpers behave correctly
//   8. Real /admin/* and / and /privacy are NOT shadowed by the honeypot

process.env.SESSION_SECRET = 'test-secret-must-be-at-least-16-chars';

const assert = require('assert');
const path = require('path');
const express = require('express');
const http = require('http');

const wp = require(path.resolve(__dirname, '../src/lib/wpFingerprint'));
const { router: wpRouter, setPingbackHeader, injectWpMeta, WP_VERSION } = wp;

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

// ---------------------------------------------------------------------------
// Unit tests for the pure helpers
// ---------------------------------------------------------------------------

console.log('injectWpMeta:');

test('Inserts <meta generator>, REST link, EditURI before </head>', () => {
  const html = '<!DOCTYPE html><html><head><title>X</title></head><body>hi</body></html>';
  const out = injectWpMeta(html);
  assert.ok(out.includes(`<meta name="generator" content="WordPress ${WP_VERSION}">`));
  assert.ok(out.includes('<link rel="https://api.w.org/" href="/wp-json/">'));
  assert.ok(out.includes('rel="EditURI"'));
  // Insertion point: must be before </head>
  const idxMeta = out.indexOf('<meta name="generator"');
  const idxHead = out.indexOf('</head>');
  assert.ok(idxMeta < idxHead, 'meta inserted after </head>');
});

test('Inserts after <head> if no closing </head> tag (malformed HTML)', () => {
  const html = '<html><head><title>X</title><body>hi</body></html>';
  const out = injectWpMeta(html);
  assert.ok(out.includes('<meta name="generator"'));
});

test('Returns input unchanged for null/empty/non-string', () => {
  assert.strictEqual(injectWpMeta(null), null);
  assert.strictEqual(injectWpMeta(''), '');
  assert.strictEqual(injectWpMeta(undefined), undefined);
  assert.strictEqual(injectWpMeta(123), 123);
});

test('Pinned WP version string is in expected format', () => {
  // 6.X.Y - matches stock WP versioning. Bump test if WP_VERSION is rotated.
  assert.ok(/^6\.\d+\.\d+$/.test(WP_VERSION), `WP_VERSION shape unexpected: ${WP_VERSION}`);
});

console.log('\nsetPingbackHeader:');

test('Sets X-Pingback header pointing to /xmlrpc.php on the request host', async () => {
  // Mini express harness so we have real req/res objects
  const app = express();
  app.set('trust proxy', true);
  app.get('/test', (req, res) => {
    setPingbackHeader(req, res);
    res.send('ok');
  });
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const r = await fetchOnce(server, '/test', { Host: 'example.com' });
  server.close();
  assert.ok(r.headers['x-pingback']);
  assert.ok(r.headers['x-pingback'].endsWith('/xmlrpc.php'));
  assert.ok(r.headers['x-pingback'].includes('example.com'));
});

// ---------------------------------------------------------------------------
// Integration tests against the actual router
// ---------------------------------------------------------------------------

const app = express();
app.set('trust proxy', true);
app.use(express.urlencoded({ extended: true }));
// Simulate /admin BEFORE the WP router so we can verify it's not shadowed
app.use('/admin', (req, res) => res.send('REAL_ADMIN'));
app.use('/', wpRouter);
// Simulate a real /wp-admin-ish path that would be a campaign root, AFTER the
// honeypot, to confirm honeypot wins for the WP paths.
app.use((req, res) => res.status(404).send('NOT_FOUND'));

function fetchOnce(server, urlPath, headers = {}, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const opts = {
      host: '127.0.0.1', port: server.address().port, path: urlPath, method, headers,
    };
    if (body) {
      opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      opts.headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = http.request(opts, (res) => {
      let buf = '';
      res.on('data', (chunk) => (buf += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: buf, headers: res.headers }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function run() {
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));

  console.log('\n/wp-login.php:');

  await test('GET /wp-login.php returns 200 + WP-shaped HTML', async () => {
    const r = await fetchOnce(server, '/wp-login.php');
    assert.strictEqual(r.status, 200);
    assert.ok(/text\/html/.test(r.headers['content-type']));
    assert.ok(r.body.includes('<body class="login'));
    assert.ok(r.body.includes('id="loginform"'));
    assert.ok(r.body.includes('name="log"'));
    assert.ok(r.body.includes('name="pwd"'));
    assert.ok(r.body.includes('name="wp-submit"'));
    assert.ok(r.body.includes('name="redirect_to"'));
  });

  await test('GET /wp-login.php sets wordpress_test_cookie', async () => {
    const r = await fetchOnce(server, '/wp-login.php');
    const setCookie = r.headers['set-cookie'] || [];
    assert.ok(setCookie.some((c) => c.includes('wordpress_test_cookie')), 'WP test cookie missing');
  });

  await test('POST /wp-login.php returns 200 with login_error block', async () => {
    const r = await fetchOnce(server, '/wp-login.php', {}, 'POST', 'log=admin&pwd=bad');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes('id="login_error"'));
    assert.ok(r.body.includes('username or password you entered is incorrect'));
  });

  console.log('\n/wp-admin/:');

  await test('GET /wp-admin redirects (302) to /wp-login.php with reauth params', async () => {
    const r = await fetchOnce(server, '/wp-admin');
    assert.strictEqual(r.status, 302);
    assert.ok(r.headers.location.startsWith('/wp-login.php'));
    assert.ok(r.headers.location.includes('reauth=1'));
  });

  await test('GET /wp-admin/ redirects (302) to /wp-login.php with reauth params', async () => {
    const r = await fetchOnce(server, '/wp-admin/');
    assert.strictEqual(r.status, 302);
    assert.ok(r.headers.location.startsWith('/wp-login.php'));
    assert.ok(r.headers.location.includes('redirect_to='));
    assert.ok(r.headers.location.includes('reauth=1'));
  });

  console.log('\n/wp-admin/admin-ajax.php:');

  await test('GET /wp-admin/admin-ajax.php returns plain "0" with 200', async () => {
    const r = await fetchOnce(server, '/wp-admin/admin-ajax.php');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body, '0');
  });

  await test('POST /wp-admin/admin-ajax.php with no action also returns "0"', async () => {
    const r = await fetchOnce(server, '/wp-admin/admin-ajax.php', {}, 'POST', 'action=foo');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body, '0');
  });

  console.log('\n/xmlrpc.php:');

  await test('GET /xmlrpc.php returns WP-canonical text', async () => {
    const r = await fetchOnce(server, '/xmlrpc.php');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body, 'XML-RPC server accepts POST requests only.');
    assert.ok(/text\/plain/.test(r.headers['content-type']));
  });

  await test('POST /xmlrpc.php returns XML-RPC fault response', async () => {
    const r = await fetchOnce(server, '/xmlrpc.php', {}, 'POST', '');
    assert.strictEqual(r.status, 200);
    assert.ok(/<methodResponse>/.test(r.body));
    assert.ok(/<fault>/.test(r.body));
    assert.ok(/faultCode/.test(r.body));
    assert.ok(/text\/xml/.test(r.headers['content-type']));
  });

  console.log('\n/wp-json/:');

  await test('GET /wp-json returns JSON (no redirect, real WP serves both)', async () => {
    const r = await fetchOnce(server, '/wp-json');
    assert.strictEqual(r.status, 200);
    assert.ok(/application\/json/.test(r.headers['content-type']));
  });

  await test('GET /wp-json/ returns JSON with WP namespaces', async () => {
    const r = await fetchOnce(server, '/wp-json/');
    assert.strictEqual(r.status, 200);
    assert.ok(/application\/json/.test(r.headers['content-type']));
    const json = JSON.parse(r.body);
    assert.ok(Array.isArray(json.namespaces));
    assert.ok(json.namespaces.includes('wp/v2'), `expected wp/v2 in namespaces, got: ${json.namespaces}`);
    assert.ok(json.namespaces.includes('oembed/1.0'));
  });

  await test('GET /wp-json/ sets Link header with api.w.org rel', async () => {
    const r = await fetchOnce(server, '/wp-json/');
    assert.ok(r.headers.link);
    assert.ok(/api\.w\.org/.test(r.headers.link));
  });

  console.log('\n/readme.html:');

  await test('GET /readme.html returns WP version disclosure', async () => {
    const r = await fetchOnce(server, '/readme.html');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes('WordPress'));
    assert.ok(r.body.includes(WP_VERSION));
  });

  console.log('\nReal routes are NOT shadowed:');

  await test('GET /admin still hits the real admin handler', async () => {
    const r = await fetchOnce(server, '/admin');
    assert.strictEqual(r.body, 'REAL_ADMIN');
  });

  await test('GET /admin/anything still hits the real admin handler', async () => {
    const r = await fetchOnce(server, '/admin/foo/bar');
    assert.strictEqual(r.body, 'REAL_ADMIN');
  });

  await test('GET /unknown-path still 404s (honeypot only matches WP paths)', async () => {
    const r = await fetchOnce(server, '/totally-unknown');
    assert.strictEqual(r.status, 404);
    assert.strictEqual(r.body, 'NOT_FOUND');
  });

  await test('GET / still 404s here (no real site root in this test app)', async () => {
    // Confirms honeypot doesn't claim "/" - that's the site router's job
    const r = await fetchOnce(server, '/');
    assert.strictEqual(r.status, 404);
  });

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
