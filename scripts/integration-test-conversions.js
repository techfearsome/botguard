// Integration test for /admin/conversions route

process.env.SESSION_SECRET = 'test-secret-must-be-at-least-16-chars';

const assert = require('assert');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const http = require('http');

// Stub the auth helper file BEFORE requiring admin (to bypass login)
const authPath = path.resolve(__dirname, '../src/middleware/auth');
const authReal = require(authPath);
require.cache[authPath + '.js'] = {
  id: authPath, filename: authPath, loaded: true,
  exports: {
    ...authReal,
    requireAdmin: (req, res, next) => next(),     // bypass auth in tests
  },
};

// Stub models
const modelsPath = path.resolve(__dirname, '../src/models');
let stubState;
const queryLike = (value) => {
  const p = Promise.resolve(value);
  // Common Mongoose query methods
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
      findOne: () => queryLike(null),
      exists: async () => false,
    },
    LandingPage: {
      find: () => queryLike([]),
      findOne: () => queryLike(null),
      findById: async () => null,
      exists: async () => false,
    },
    Click: {
      find: (q) => queryLike(stubState.clicks || []),
      findOne: () => queryLike(null),
      countDocuments: async () => 0,
      aggregate: async () => [],
    },
    Conversion: {
      find: (q) => {
        // Apply some basic filtering so the route's filters can be tested
        let results = stubState.conversions || [];
        if (q.campaign_id) results = results.filter(c => String(c.campaign_id?._id || c.campaign_id) === q.campaign_id);
        if (q.source) results = results.filter(c => c.source === q.source);
        if (q.event_name) results = results.filter(c => c.event_name === q.event_name);
        if (q.auto_detected === true) results = results.filter(c => c.auto_detected === true);
        return queryLike(results);
      },
      countDocuments: async () => (stubState.conversions || []).length,
    },
    AsnBlacklist: { find: () => queryLike([]) },
    SitePage: { find: () => queryLike([]), findOne: () => queryLike(null) },
  },
};

const adminRouter = require(path.resolve(__dirname, '../src/routes/admin'));

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.resolve(__dirname, '../src/views'));
// Mirror the real server's app.locals so the localTime helper is available
// to templates rendered during integration tests.
app.locals.localTime = require(path.resolve(__dirname, '../src/lib/localTime')).localTime;
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/admin', adminRouter);

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

  function makeState() {
    return {
      workspace: { _id: 'ws1', slug: 'techfirio' },
      campaigns: [
        { _id: 'c1', name: 'Demo Campaign', slug: 'demo' },
      ],
      clicks: [
        {
          click_id: 'CLICK1', ip: '1.2.3.4', country: 'US', country_name: 'United States',
          asn_org: 'Comcast', organisation: 'Comcast Cable',
          ua_parsed: { device_label: 'iPhone', device_type: 'mobile' },
          in_app_browser: null, is_proxy: false, ip_type: 'residential',
          page_rendered: 'offer',
          landing_page_id: { _id: 'p1', name: 'Sales Page', slug: 'sales' },
          ts: new Date(Date.now() - 60000),
          utm: { source: 'fb', medium: 'cpc', campaign: 'q4' },
        },
        {
          click_id: 'CLICK2', ip: '5.6.7.8', country: 'IN', country_name: 'India',
          asn_org: 'Reliance Jio', is_proxy: false, ip_type: 'mobile',
          ua_parsed: { device_label: 'Android phone' },
          page_rendered: 'offer', ts: new Date(Date.now() - 30000),
          utm: { source: 'google', medium: 'organic', campaign: 'launch' },
        },
      ],
      conversions: [
        {
          _id: 'conv1', click_id: 'CLICK1',
          campaign_id: { _id: 'c1', name: 'Demo Campaign', slug: 'demo' },
          ts: new Date(),
          source: 'auto', event_name: 'install', value: 0, currency: 'USD',
          auto_detected: true,
          matched_term: 'download', matched_text: 'Download Now',
          matched_element: 'button#cta',
          page_url: 'https://example.com/offer/sales',
        },
        {
          _id: 'conv2', click_id: 'CLICK2',
          campaign_id: { _id: 'c1', name: 'Demo Campaign', slug: 'demo' },
          ts: new Date(),
          source: 'postback', event_name: 'lead', value: 5, currency: 'USD',
          auto_detected: false,
        },
      ],
    };
  }

  console.log('GET /admin/conversions:');

  await test('Renders the conversions page with all conversions', async () => {
    stubState = makeState();
    const r = await fetch(server, '/admin/conversions');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes('Conversions'));
    // Both conversions should appear
    assert.ok(r.body.includes('CLICK1'), 'CLICK1 should be rendered');
    assert.ok(r.body.includes('CLICK2'));
  });

  await test('Shows campaign name and slug for each conversion', async () => {
    stubState = makeState();
    const r = await fetch(server, '/admin/conversions');
    assert.ok(r.body.includes('Demo Campaign'));
    assert.ok(r.body.includes('/demo'));
  });

  await test('Shows IP, country, and provider from joined click data', async () => {
    stubState = makeState();
    const r = await fetch(server, '/admin/conversions');
    assert.ok(r.body.includes('1.2.3.4'));
    assert.ok(r.body.includes('Comcast'));
    assert.ok(r.body.includes('Reliance Jio'));
  });

  await test('Shows offer page name from joined landing_page_id', async () => {
    stubState = makeState();
    const r = await fetch(server, '/admin/conversions');
    assert.ok(r.body.includes('Sales Page'), 'should show landing page name');
  });

  await test('Shows page URL for auto-detected conversions', async () => {
    stubState = makeState();
    const r = await fetch(server, '/admin/conversions');
    assert.ok(r.body.includes('example.com/offer/sales'));
  });

  await test('Auto-detected conversions get the auto badge', async () => {
    stubState = makeState();
    const r = await fetch(server, '/admin/conversions');
    // Look for the badge near "auto"
    assert.match(r.body, /badge[^>]*>\s*auto\s*</);
  });

  await test('Shows matched term and matched text for auto conversions', async () => {
    stubState = makeState();
    const r = await fetch(server, '/admin/conversions');
    assert.ok(r.body.includes('download'));
    assert.ok(r.body.includes('Download Now'));
  });

  await test('Stat cards show total + auto count + total value', async () => {
    stubState = makeState();
    const r = await fetch(server, '/admin/conversions');
    // 2 total, 1 auto, $5 value
    assert.ok(r.body.includes('Total (filtered)'));
    assert.ok(r.body.includes('Auto-detected'));
    assert.ok(r.body.includes('Total value'));
  });

  await test('Filter by source=auto shows only auto conversions', async () => {
    stubState = makeState();
    const r = await fetch(server, '/admin/conversions?source=auto');
    assert.ok(r.body.includes('CLICK1'));
    assert.ok(!r.body.includes('CLICK2'));
  });

  await test('Filter by auto=1 shows only auto-detected', async () => {
    stubState = makeState();
    const r = await fetch(server, '/admin/conversions?auto=1');
    assert.ok(r.body.includes('CLICK1'));
    assert.ok(!r.body.includes('CLICK2'));
  });

  await test('Empty state shown when no conversions match filter', async () => {
    stubState = makeState();
    stubState.conversions = [];
    const r = await fetch(server, '/admin/conversions');
    assert.ok(r.body.includes('No conversions') || r.body.includes('empty'));
  });

  console.log('\nGET /admin/conversions.csv:');

  await test('CSV export returns text/csv with download header', async () => {
    stubState = makeState();
    const r = await fetch(server, '/admin/conversions.csv');
    assert.strictEqual(r.status, 200);
    assert.match(r.headers['content-type'] || '', /text\/csv/);
    assert.match(r.headers['content-disposition'] || '', /attachment.*\.csv/);
  });

  await test('CSV has expected headers and one row per conversion', async () => {
    stubState = makeState();
    const r = await fetch(server, '/admin/conversions.csv');
    const lines = r.body.split('\n');
    assert.ok(lines[0].includes('ts'));
    assert.ok(lines[0].includes('click_id'));
    assert.ok(lines[0].includes('matched_term'));
    assert.ok(lines[0].includes('ip'));
    assert.ok(lines[0].includes('country'));
    // Data rows: 1 header + 2 conversions
    const nonEmpty = lines.filter((l) => l.trim().length > 0);
    assert.strictEqual(nonEmpty.length, 3);
  });

  await test('CSV escapes commas and quotes in matched_text', async () => {
    stubState = makeState();
    stubState.conversions[0].matched_text = 'Hello, "world"';
    const r = await fetch(server, '/admin/conversions.csv');
    // The quoted-and-escaped form: "Hello, ""world"""
    assert.ok(r.body.includes('"Hello, ""world"""'), `body line: ${r.body.split('\n')[1]}`);
  });

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
