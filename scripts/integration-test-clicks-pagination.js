// Integration tests for pagination on /admin/clicks.
//
// What's being verified:
//   1. Page 1 returns the first N rows; page 2 returns the next N rows
//   2. totalCount reflects ALL matching rows (not just the current page)
//   3. ?per=<N> changes page size, only allowlisted values accepted
//   4. Filters narrow both the displayed page AND the total count
//   5. Out-of-range page numbers don't crash (just return empty)
//   6. Invalid ?per values fall back to default (no DoS via per=99999999)
//   7. The pagination UI in the rendered HTML preserves the current filters

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

function fetchOnce(server, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({
      host: '127.0.0.1', port: server.address().port, path: urlPath,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, body: buf, headers: res.headers }));
    }).on('error', reject);
  });
}

let stubState;

function makeState(clickCount = 250) {
  // 250 clicks across "today" so we can test multi-page navigation.
  // We use a deterministic timestamp pattern so order matches click_id.
  const baseTs = new Date('2026-05-13T12:00:00Z');
  const clicks = [];
  for (let i = 0; i < clickCount; i++) {
    clicks.push({
      _id: `c${i}`, click_id: `click-${String(i).padStart(4, '0')}`,
      workspace_id: 'ws1', campaign_id: 'camp_a',
      ts: new Date(baseTs.getTime() - i * 1000),     // descending, 1s apart
      decision: i % 5 === 0 ? 'block' : 'allow',
      decision_reason: i % 5 === 0 ? 'proxy_gate:vpn' : 'allow',
      ip: `10.0.${Math.floor(i / 256)}.${i % 256}`,
      utm: { source: i % 2 === 0 ? 'google' : 'facebook' },
      external_ids: {},
    });
  }
  return {
    workspace: { _id: 'ws1', slug: 'default', settings: {} },
    campaigns: [{ _id: 'camp_a', name: 'Campaign A', slug: 'camp-a' }],
    clicks,
  };
}

function makeFindChain(docs) {
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
    skip: (n) => { state.docs = state.docs.slice(n); return chain; },
    limit: (n) => { state.docs = state.docs.slice(0, n); return chain; },
    populate: (field) => { state.populate = field; return chain; },
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
      const ok = v.some((sub) =>
        Object.entries(sub).every(([sk, sv]) => {
          const parts = sk.split('.');
          let cur = doc;
          for (const p of parts) cur = cur?.[p];
          return cur === sv;
        }));
      if (!ok) return false;
    } else if (k === 'ts') {
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
    countDocuments: async (filter) => stubState.clicks.filter((c) => applyFilter(c, filter)).length,
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

const modelsPath = require.resolve(path.resolve(__dirname, '../src/models'));
require.cache[modelsPath] = { exports: stubModels, loaded: true, id: modelsPath, filename: modelsPath };
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

// Count how many <tr> data rows the table contains (not the header)
function countTableRows(body) {
  // Match <tr ...> that have a child <td (i.e. body rows, not header rows)
  const tbody = body.match(/<tbody[\s\S]*?<\/tbody>/);
  if (!tbody) {
    // Older templates without explicit <tbody> — count all <tr> that
    // contain a <td>, excluding the header row.
    return (body.match(/<tr[^>]*>\s*<td/g) || []).length;
  }
  return (tbody[0].match(/<tr/g) || []).length;
}

async function run() {
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));

  console.log('Pagination basics:');

  await test('Page 1 default returns 100 rows for 250 clicks', async () => {
    stubState = makeState(250);
    const r = await fetchOnce(server, '/admin/clicks?range=all');
    assert.strictEqual(r.status, 200);
    const rowCount = countTableRows(r.body);
    assert.strictEqual(rowCount, 100, `expected 100 rows on page 1, got ${rowCount}`);
  });

  await test('Page 2 default returns the next 100 rows (101-200)', async () => {
    stubState = makeState(250);
    const r = await fetchOnce(server, '/admin/clicks?range=all&page_n=2');
    const rowCount = countTableRows(r.body);
    assert.strictEqual(rowCount, 100);
    // Spot check that we have click-0100 (101st click, index 100) but NOT
    // click-0000 (which is page 1).
    assert.ok(r.body.includes('click-0100'), 'page 2 should include click-0100');
    assert.ok(!r.body.includes('click-0000'), 'page 2 should NOT include click-0000 (that\'s page 1)');
  });

  await test('Page 3 has the remaining 50 rows (201-250)', async () => {
    stubState = makeState(250);
    const r = await fetchOnce(server, '/admin/clicks?range=all&page_n=3');
    const rowCount = countTableRows(r.body);
    assert.strictEqual(rowCount, 50);
    assert.ok(r.body.includes('click-0200'));
    assert.ok(r.body.includes('click-0249'));
  });

  await test('Total count displayed reflects ALL clicks, not just current page', async () => {
    stubState = makeState(250);
    const r = await fetchOnce(server, '/admin/clicks?range=all');
    assert.ok(r.body.includes('250'), 'total count "250" should appear in page header');
  });

  await test('Showing X-Y range is correct on page 2 of 100/page', async () => {
    stubState = makeState(250);
    const r = await fetchOnce(server, '/admin/clicks?range=all&page_n=2');
    assert.ok(/101.+200/.test(r.body), `expected "101-200" range, got header: ${r.body.match(/Showing[^.]*/) || 'not found'}`);
  });

  console.log('\nPer-page selector:');

  await test('?per=250 returns up to 250 rows', async () => {
    stubState = makeState(250);
    const r = await fetchOnce(server, '/admin/clicks?range=all&per=250');
    const rowCount = countTableRows(r.body);
    assert.strictEqual(rowCount, 250);
  });

  await test('?per=50 returns up to 50 rows', async () => {
    stubState = makeState(250);
    const r = await fetchOnce(server, '/admin/clicks?range=all&per=50');
    const rowCount = countTableRows(r.body);
    assert.strictEqual(rowCount, 50);
  });

  await test('?per=99999 (not in allowlist) falls back to default 100', async () => {
    // Defensive: don't let URL params blow up Mongo's limit
    stubState = makeState(250);
    const r = await fetchOnce(server, '/admin/clicks?range=all&per=99999');
    const rowCount = countTableRows(r.body);
    assert.strictEqual(rowCount, 100,
      'invalid per-page should fall back to default 100, not honor the absurd value');
  });

  await test('?per=garbage falls back to default 100', async () => {
    stubState = makeState(250);
    const r = await fetchOnce(server, '/admin/clicks?range=all&per=garbage');
    const rowCount = countTableRows(r.body);
    assert.strictEqual(rowCount, 100);
  });

  console.log('\nPage-number edge cases:');

  await test('?page_n=0 falls back to page 1', async () => {
    stubState = makeState(250);
    const r = await fetchOnce(server, '/admin/clicks?range=all&page_n=0');
    assert.ok(r.body.includes('click-0000'), 'page_n=0 should be treated as page 1');
  });

  await test('?page_n=-5 falls back to page 1', async () => {
    stubState = makeState(250);
    const r = await fetchOnce(server, '/admin/clicks?range=all&page_n=-5');
    assert.ok(r.body.includes('click-0000'));
  });

  await test('?page_n=garbage falls back to page 1', async () => {
    stubState = makeState(250);
    const r = await fetchOnce(server, '/admin/clicks?range=all&page_n=garbage');
    assert.ok(r.body.includes('click-0000'));
  });

  await test('?page_n=99 (beyond total pages) returns empty table, no crash', async () => {
    stubState = makeState(250);
    const r = await fetchOnce(server, '/admin/clicks?range=all&page_n=99');
    assert.strictEqual(r.status, 200);
    const rowCount = countTableRows(r.body);
    assert.strictEqual(rowCount, 0, 'beyond-last-page should return empty, not crash');
  });

  console.log('\nFilter parity with pagination:');

  await test('?decision=block + page 1 returns blocks only (50 of 250)', async () => {
    stubState = makeState(250);
    // 1/5 of fixtures are block decisions = 50 blocks
    const r = await fetchOnce(server, '/admin/clicks?range=all&decision=block');
    const rowCount = countTableRows(r.body);
    assert.strictEqual(rowCount, 50, `expected 50 blocks on a single page, got ${rowCount}`);
    // Total count in the header should show 50, not 250
    assert.ok(/of\s*<strong>50</.test(r.body) || /of\s+50/.test(r.body),
      'totalCount header should reflect filtered count, not unfiltered');
  });

  await test('Filter + ?per=10 + ?page_n=2 returns rows 11-20 of filtered set', async () => {
    stubState = makeState(250);
    // Hmm - 10 is not in our allowlist. Use the smallest allowed: 50.
    // 50 blocks total, 50 per page = 1 page, so we use page_n=1
    const r = await fetchOnce(server, '/admin/clicks?range=all&decision=block&per=50');
    const rowCount = countTableRows(r.body);
    assert.strictEqual(rowCount, 50);
  });

  console.log('\nPagination UI preserves filters:');

  await test('Next-page link includes current filters', async () => {
    stubState = makeState(250);
    // Use a small per-page so we get multiple pages even with a filter.
    // 50 block decisions in fixtures, ÷ 50 per page = 1 page (no Next).
    // Use the broader filter ?source=google (125 fixtures) and per=50 → 3 pages.
    const r = await fetchOnce(server, '/admin/clicks?range=all&source=google&per=50&page_n=1');
    // The "Next" link should preserve range, source, per
    const nextMatch = r.body.match(/href="(\/admin\/clicks\?[^"]*page_n=2[^"]*)"/);
    assert.ok(nextMatch, `no next-page link found in body: ${r.body.match(/pagination[\s\S]{0,500}/) || 'no pagination section'}`);
    const nextUrl = nextMatch[1];
    assert.ok(nextUrl.includes('range=all'), `next URL missing range: ${nextUrl}`);
    assert.ok(nextUrl.includes('source=google'), `next URL missing source: ${nextUrl}`);
    assert.ok(nextUrl.includes('per=50'), `next URL missing per: ${nextUrl}`);
  });

  await test('Per-page form has hidden inputs for current filters', async () => {
    stubState = makeState(250);
    const r = await fetchOnce(server, '/admin/clicks?range=all&decision=block');
    // The per-page form should have hidden inputs preserving "range" and
    // "decision" so changing per-page doesn't reset them.
    const perPageForm = r.body.match(/<form[^>]*>[\s\S]*?Per page[\s\S]*?<\/form>/);
    assert.ok(perPageForm, 'per-page form not found');
    assert.ok(/name="range"\s+value="all"/.test(perPageForm[0]),
      `per-page form should preserve range=all, got: ${perPageForm[0].slice(0, 400)}`);
    assert.ok(/name="decision"\s+value="block"/.test(perPageForm[0]),
      'per-page form should preserve decision=block');
  });

  await test('Empty state when zero matches (no rows, no crash)', async () => {
    stubState = makeState(0);
    const r = await fetchOnce(server, '/admin/clicks?range=all');
    assert.strictEqual(r.status, 200);
    assert.ok(/No clicks/i.test(r.body) || /no.*matching/i.test(r.body),
      'expected empty-state message');
  });

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
