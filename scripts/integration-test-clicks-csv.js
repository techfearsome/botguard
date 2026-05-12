// Integration tests for the /admin/clicks.csv export route.
//
// The most important thing being tested here: filter parity. The export
// route must apply identical filters to the list view. If a future refactor
// adds a filter to /clicks but forgets /clicks.csv, admins get confused
// ("I'm filtering to today's blocked clicks and my CSV has 10K rows of
// random stuff"). The tests below explicitly hit a route that exercises
// each filter, then verify the export's row count matches.
//
// We mock the Click + Campaign models with in-memory arrays so the tests
// don't need a live Mongo instance.

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

// --- In-memory model stubs --------------------------------------------------
//
// The clicks list + CSV both call Click.find(filter).sort().limit().populate().lean()
// We implement just enough of that chain to filter our fixture array and
// return populated results.

let stubState;

function makeState() {
  // Two campaigns. Three clicks per filter scenario - one match, one
  // non-match by some filter, one in a different campaign.
  const baseTs = new Date('2026-05-10T12:00:00Z');
  return {
    workspace: { _id: 'ws1', slug: 'default', settings: {} },
    campaigns: [
      { _id: 'camp_a', name: 'Campaign A', slug: 'camp-a' },
      { _id: 'camp_b', name: 'Campaign B', slug: 'camp-b' },
    ],
    clicks: [
      {
        _id: 'c1', click_id: 'click-1',
        workspace_id: 'ws1', campaign_id: 'camp_a',
        ts: baseTs,
        decision: 'allow', decision_reason: 'allow',
        page_rendered: 'offer', variant_shown: 'main',
        ip: '1.2.3.4', country: 'US', asn: 13335, asn_org: 'Cloudflare',
        device_class: 'iphone', ua_parsed: { device_label: 'iPhone', os: 'iOS', browser: 'Safari', browser_version: '17' },
        utm: { source: 'google', medium: 'cpc', campaign: 'spring' },
        external_ids: { gclid: 'GCL-mixedCASE123', wbraid: '' },
        user_agent: 'Mozilla/5.0',
        scores: { total: 12 },
        conversion_count: 1,
      },
      {
        _id: 'c2', click_id: 'click-2',
        workspace_id: 'ws1', campaign_id: 'camp_a',
        ts: baseTs,
        decision: 'block', decision_reason: 'proxy_gate:vpn',
        ip: '5.6.7.8', country: 'IN', asn: 4837, asn_org: 'ChinaNet',
        device_class: 'android',
        utm: { source: 'facebook', medium: 'social' },
        external_ids: { fbclid: 'FB-xyz' },
      },
      {
        _id: 'c3', click_id: 'click-3',
        workspace_id: 'ws1', campaign_id: 'camp_b',
        ts: baseTs,
        decision: 'allow', decision_reason: 'allow',
        utm: { source: 'google', medium: 'cpc' },
        external_ids: { wbraid: 'WB-aBc123' },
      },
      {
        _id: 'c4', click_id: 'click-4',
        workspace_id: 'ws1', campaign_id: 'camp_a',
        // This one is OLD (out of any recent date range)
        ts: new Date('2025-01-01T00:00:00Z'),
        decision: 'allow', decision_reason: 'allow',
        utm: { source: 'organic' },
        external_ids: {},
      },
      {
        // Has a value that needs CSV escaping (comma, quote, newline)
        _id: 'c5', click_id: 'click-5',
        workspace_id: 'ws1', campaign_id: 'camp_a',
        ts: baseTs,
        decision: 'block', decision_reason: 'hard_block:headless',
        user_agent: 'Mozilla/5.0, "weird" UA\nwith newline',
        utm: { source: 'google' },
        external_ids: {},
      },
    ],
  };
}

function makeFindChain(docs) {
  // Mimic the .find().sort().limit().populate().lean() chain
  const state = { docs: docs.slice(), populate: null };
  const chain = {
    sort: (s) => {
      const key = Object.keys(s)[0]; const dir = s[key];
      state.docs.sort((a, b) => {
        const av = a[key]; const bv = b[key];
        if (av < bv) return -dir;
        if (av > bv) return dir;
        return 0;
      });
      return chain;
    },
    limit: (n) => { state.docs = state.docs.slice(0, n); return chain; },
    populate: (field, select) => { state.populate = field; return chain; },
    select: () => chain,
    lean: async () => {
      if (state.populate === 'campaign_id') {
        return state.docs.map((d) => ({
          ...d,
          campaign_id: stubState.campaigns.find((c) => String(c._id) === String(d.campaign_id)) || null,
        }));
      }
      return state.docs;
    },
  };
  return chain;
}

function applyFilter(doc, filter) {
  for (const [k, v] of Object.entries(filter)) {
    if (k === 'workspace_id') {
      if (String(doc.workspace_id) !== String(v)) return false;
    } else if (k === 'campaign_id') {
      if (String(doc.campaign_id) !== String(v)) return false;
    } else if (k === 'decision') {
      if (doc.decision !== v) return false;
    } else if (k === 'utm.source') {
      if (doc.utm?.source !== v) return false;
    } else if (k === '$or') {
      const ok = v.some((sub) => {
        return Object.entries(sub).every(([sk, sv]) => {
          // Handle dotted path 'external_ids.gclid' etc.
          const parts = sk.split('.');
          let cur = doc;
          for (const p of parts) cur = cur?.[p];
          return cur === sv;
        });
      });
      if (!ok) return false;
    } else if (k === 'ts') {
      // {$gte, $lte}
      if (v.$gte && doc.ts < v.$gte) return false;
      if (v.$lte && doc.ts > v.$lte) return false;
    }
  }
  return true;
}

const stubModels = {
  Workspace: { findOne: async () => stubState.workspace },
  Click: {
    find: (filter) => makeFindChain(stubState.clicks.filter((c) => applyFilter(c, filter))),
  },
  Campaign: {
    find: () => ({ select: () => ({ lean: async () => stubState.campaigns }) }),
  },
  LandingPage: { find: () => ({ sort: () => ({ lean: async () => [] }) }) },
  SitePage: {
    find: () => ({ select: () => ({ lean: async () => [] }) }),
    findOne: () => ({ lean: async () => null }),
  },
  Conversion: { find: () => ({ sort: () => ({ limit: () => ({ populate: () => ({ lean: async () => [] }) }) }) }) },
  AsnBlacklist: { find: () => ({ lean: async () => [] }) },
  FirewallEntry: {
    find: () => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) }),
    aggregate: async () => [],
    classify: () => null,
    REASON_CLASSES: ['proxy', 'datacenter', 'bot', 'asn', 'hard_block', 'source', 'other'],
  },
};

// Inject stubs into require.cache BEFORE requiring admin routes
const modelsPath = require.resolve(path.resolve(__dirname, '../src/models'));
require.cache[modelsPath] = { exports: stubModels, loaded: true, id: modelsPath, filename: modelsPath };

// Stub auth so requests bypass admin login
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

  console.log('GET /admin/clicks.csv - response shape:');

  await test('Returns 200 with CSV content-type', async () => {
    stubState = makeState();
    const r = await fetchOnce(server, '/admin/clicks.csv?range=all');
    assert.strictEqual(r.status, 200);
    assert.ok(/text\/csv/.test(r.headers['content-type']));
  });

  await test('Sets Content-Disposition attachment with date in filename', async () => {
    stubState = makeState();
    const r = await fetchOnce(server, '/admin/clicks.csv?range=all');
    const cd = r.headers['content-disposition'] || '';
    assert.ok(/attachment/.test(cd));
    assert.ok(/clicks-\d{4}-\d{2}-\d{2}\.csv/.test(cd));
  });

  await test('First row is the header with expected columns', async () => {
    stubState = makeState();
    const r = await fetchOnce(server, '/admin/clicks.csv?range=all');
    const firstLine = r.body.split('\r\n')[0];
    // Check key columns are present - the full list is in admin/index.js
    for (const col of ['ts', 'click_id', 'campaign', 'decision', 'decision_reason',
                       'ip', 'country', 'gclid', 'wbraid', 'gbraid', 'fbclid', 'msclkid']) {
      assert.ok(firstLine.split(',').includes(col),
        `expected column ${col} in header, got: ${firstLine}`);
    }
  });

  await test('Lines end with CRLF', async () => {
    stubState = makeState();
    const r = await fetchOnce(server, '/admin/clicks.csv?range=all');
    assert.ok(r.body.includes('\r\n'), 'CRLF line ending missing');
  });

  console.log('\nFilter parity with /admin/clicks list view:');

  await test('No filters: exports all clicks in range', async () => {
    stubState = makeState();
    const r = await fetchOnce(server, '/admin/clicks.csv?range=all');
    const lines = r.body.split('\r\n').filter(Boolean);
    // 5 fixture clicks + 1 header
    assert.strictEqual(lines.length, 6, `expected 6 lines (1 header + 5 clicks), got ${lines.length}`);
  });

  await test('?decision=block filter limits CSV rows', async () => {
    stubState = makeState();
    const r = await fetchOnce(server, '/admin/clicks.csv?range=all&decision=block');
    const lines = r.body.split('\r\n').filter(Boolean);
    // c2 (proxy_gate:vpn) and c5 (hard_block) - 2 blocks + 1 header
    assert.strictEqual(lines.length, 3, `expected 1 header + 2 blocks, got ${lines.length}`);
  });

  await test('?campaign=camp_a limits to one campaign', async () => {
    stubState = makeState();
    const r = await fetchOnce(server, '/admin/clicks.csv?range=all&campaign=camp_a');
    const lines = r.body.split('\r\n').filter(Boolean);
    // c1, c2, c4, c5 are camp_a - 4 + 1 header
    assert.strictEqual(lines.length, 5);
  });

  await test('?source=google filters by utm_source', async () => {
    stubState = makeState();
    const r = await fetchOnce(server, '/admin/clicks.csv?range=all&source=google');
    const lines = r.body.split('\r\n').filter(Boolean);
    // c1, c3, c5 have utm.source=google - 3 + 1 header
    assert.strictEqual(lines.length, 4);
  });

  console.log('\nClick-ID search across all five identifiers:');

  await test('?click_id=GCL-mixedCASE123 finds the click by gclid', async () => {
    stubState = makeState();
    const r = await fetchOnce(server, '/admin/clicks.csv?range=all&click_id=GCL-mixedCASE123');
    const lines = r.body.split('\r\n').filter(Boolean);
    assert.strictEqual(lines.length, 2, `expected 1 header + 1 match, got ${lines.length}`);
    assert.ok(lines[1].includes('GCL-mixedCASE123'), `expected gclid in row, got: ${lines[1]}`);
  });

  await test('?click_id is case-sensitive (Google contract)', async () => {
    // GCL-mixedCASE123 exists but gcl-mixedcase123 (lowercased) should NOT match
    stubState = makeState();
    const r = await fetchOnce(server, '/admin/clicks.csv?range=all&click_id=gcl-mixedcase123');
    const lines = r.body.split('\r\n').filter(Boolean);
    assert.strictEqual(lines.length, 1,
      `case-sensitive search should not match lowercased input; got ${lines.length - 1} match(es)`);
  });

  await test('?click_id=WB-aBc123 finds the click by wbraid', async () => {
    stubState = makeState();
    const r = await fetchOnce(server, '/admin/clicks.csv?range=all&click_id=WB-aBc123');
    const lines = r.body.split('\r\n').filter(Boolean);
    assert.strictEqual(lines.length, 2);
    assert.ok(lines[1].includes('WB-aBc123'));
  });

  await test('?click_id=FB-xyz finds the click by fbclid', async () => {
    stubState = makeState();
    const r = await fetchOnce(server, '/admin/clicks.csv?range=all&click_id=FB-xyz');
    const lines = r.body.split('\r\n').filter(Boolean);
    assert.strictEqual(lines.length, 2);
    assert.ok(lines[1].includes('FB-xyz'));
  });

  console.log('\nCSV escaping:');

  await test('Quotes/commas/newlines in user_agent are properly escaped', async () => {
    // c5 has a user_agent with: comma, double-quote, and newline. Per RFC 4180:
    //   - the cell must be wrapped in double quotes
    //   - embedded quotes must be doubled
    stubState = makeState();
    const r = await fetchOnce(server, '/admin/clicks.csv?range=all&decision=block&click_id=&campaign=camp_a');
    // Look for the c5 row in the body
    assert.ok(/"Mozilla\/5\.0, ""weird"" UA\nwith newline"/.test(r.body),
      `expected RFC-4180 escaped user_agent, got body: ${r.body.slice(0, 800)}`);
  });

  console.log('\nDate range filtering:');

  await test('?range=today excludes the old (2025) click', async () => {
    stubState = makeState();
    // c4 is at 2025-01-01, all others at 2026-05-10. Range "all" includes it,
    // but the current date is sometime in May 2026 so "today" or "7d" exclude it.
    // We use a custom range covering only May 2026 to make this deterministic.
    const r = await fetchOnce(server, '/admin/clicks.csv?range=custom&date_from=2026-05-01&date_to=2026-05-31');
    const lines = r.body.split('\r\n').filter(Boolean);
    // c4 (2025-01-01) should be excluded
    assert.ok(!r.body.includes('click-4'), 'old 2025 click should be excluded from May 2026 range');
    // All four 2026 clicks should be present
    assert.strictEqual(lines.length, 5, `expected 1 header + 4 in-range clicks, got ${lines.length}`);
  });

  console.log('\nThe list view UI exposes an Export CSV link:');

  await test('GET /admin/clicks renders an Export CSV link to /admin/clicks.csv', async () => {
    stubState = makeState();
    const r = await fetchOnce(server, '/admin/clicks?range=all');
    assert.strictEqual(r.status, 200);
    assert.ok(/href="\/admin\/clicks\.csv\?/.test(r.body),
      'Export CSV link missing from /admin/clicks view');
  });

  await test('Export CSV link propagates current filters as query string', async () => {
    stubState = makeState();
    const r = await fetchOnce(server, '/admin/clicks?range=all&decision=block&source=google');
    // The link should include the same range, decision, and source params
    const match = r.body.match(/href="(\/admin\/clicks\.csv\?[^"]+)"/);
    assert.ok(match, 'no Export CSV link found');
    const href = match[1];
    assert.ok(href.includes('range=all'));
    assert.ok(href.includes('decision=block'));
    assert.ok(href.includes('source=google'));
  });

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
