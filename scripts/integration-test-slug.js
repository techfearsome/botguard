// Integration test: verify that POST /admin/campaigns auto-generates slugs.

process.env.SESSION_SECRET = 'test-secret-must-be-at-least-16-chars';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD_HASH = require(require('path').resolve(__dirname, '../src/middleware/auth')).hashPassword('test');

const assert = require('assert');
const path = require('path');

// Stub the models
const modelsPath = path.resolve(__dirname, '../src/models');
const stubState = {
  workspace: { _id: 'ws1', slug: 'techfirio' },
  existingCampaignSlugs: new Set(),
  existingPageSlugs: new Set(),
  createdCampaign: null,
  createdPage: null,
};

require.cache[modelsPath + '.js'] = require.cache[modelsPath + '/index.js'] = {
  id: modelsPath, filename: modelsPath, loaded: true,
  exports: {
    Workspace: { findOne: async () => stubState.workspace },
    Campaign: {
      exists: async (q) => stubState.existingCampaignSlugs.has(q.slug),
      create: async (doc) => { stubState.createdCampaign = doc; return doc; },
      find: () => ({ select: () => ({ lean: async () => [] }) }),
      findOne: async () => null,
    },
    LandingPage: {
      exists: async (q) => stubState.existingPageSlugs.has(q.slug),
      create: async (doc) => { stubState.createdPage = doc; return doc; },
      find: () => ({ sort: () => ({ lean: async () => [] }) }),
      findOne: async () => null,
    },
    Click: { find: () => ({ sort: () => ({ limit: () => ({ populate: () => ({ lean: async () => [] }) }) }) }), countDocuments: async () => 0, aggregate: async () => [] },
    Conversion: { countDocuments: async () => 0 },
    AsnBlacklist: { find: () => ({ lean: async () => [] }) },
  },
};

// Stub the slug helper deps so admin routes load
const { resolveSlug } = require(path.resolve(__dirname, '../src/lib/slug'));

// Now import the admin router
const adminRouter = require(path.resolve(__dirname, '../src/routes/admin'));
const express = require('express');
const cookieParser = require('cookie-parser');
const http = require('http');

const app = express();
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/admin', adminRouter);

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

// Helper to POST a form
function postForm(server, urlPath, fields, cookies = '') {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const body = Object.entries(fields)
      .map(([k, v]) => Array.isArray(v)
        ? v.map((x) => `${k}=${encodeURIComponent(x)}`).join('&')
        : `${k}=${encodeURIComponent(v)}`)
      .join('&');
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'Cookie': cookies,
      },
    }, (res) => {
      let resBody = '';
      res.on('data', (c) => resBody += c);
      res.on('end', () => resolve({ status: res.statusCode, body: resBody, headers: res.headers }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Authenticate by signing a session cookie directly
const { signSession } = require(path.resolve(__dirname, '../src/middleware/auth'));
const sessionToken = signSession('admin');
const authCookie = `bg_admin=${sessionToken}`;

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));

  console.log('Auto-slug on campaign creation:');

  await test('Slug auto-generated from name when blank', async () => {
    stubState.existingCampaignSlugs = new Set();
    stubState.createdCampaign = null;
    const r = await postForm(server, '/admin/campaigns', {
      name: 'Black Friday Promo', slug: '',
      threshold: '70', mode: 'log_only',
      utm_required_keys: ['source', 'medium', 'campaign'],
    }, authCookie);
    assert.strictEqual(r.status, 302);   // redirect after success
    assert.strictEqual(stubState.createdCampaign.slug, 'black-friday-promo');
  });

  await test('Provided slug used as-is when no collision', async () => {
    stubState.existingCampaignSlugs = new Set();
    stubState.createdCampaign = null;
    const r = await postForm(server, '/admin/campaigns', {
      name: 'My Campaign', slug: 'custom-slug',
      threshold: '70', mode: 'log_only',
      utm_required_keys: ['source', 'medium', 'campaign'],
    }, authCookie);
    assert.strictEqual(r.status, 302);
    assert.strictEqual(stubState.createdCampaign.slug, 'custom-slug');
  });

  await test('Random suffix appended on slug collision', async () => {
    stubState.existingCampaignSlugs = new Set(['black-friday-promo']);
    stubState.createdCampaign = null;
    const r = await postForm(server, '/admin/campaigns', {
      name: 'Black Friday Promo', slug: '',
      threshold: '70', mode: 'log_only',
      utm_required_keys: ['source', 'medium', 'campaign'],
    }, authCookie);
    assert.strictEqual(r.status, 302);
    assert.match(stubState.createdCampaign.slug, /^black-friday-promo-\d{4,}$/);
    assert.notStrictEqual(stubState.createdCampaign.slug, 'black-friday-promo');
  });

  await test('Provided slug also gets suffix on collision', async () => {
    stubState.existingCampaignSlugs = new Set(['demo']);
    stubState.createdCampaign = null;
    const r = await postForm(server, '/admin/campaigns', {
      name: 'Demo', slug: 'demo',
      threshold: '70', mode: 'log_only',
      utm_required_keys: ['source', 'medium', 'campaign'],
    }, authCookie);
    assert.strictEqual(r.status, 302);
    assert.match(stubState.createdCampaign.slug, /^demo-\d{4,}$/);
  });

  await test('UTM gate config is saved correctly', async () => {
    stubState.existingCampaignSlugs = new Set();
    stubState.createdCampaign = null;
    const r = await postForm(server, '/admin/campaigns', {
      name: 'Gated', slug: 'gated',
      threshold: '70', mode: 'log_only',
      utm_gate_enabled: 'on',
      utm_required_keys: ['source', 'campaign'],   // only 2 required
    }, authCookie);
    assert.strictEqual(r.status, 302);
    assert.strictEqual(stubState.createdCampaign.filter_config.utm_gate.enabled, true);
    assert.deepStrictEqual(stubState.createdCampaign.filter_config.utm_gate.required_keys, ['source', 'campaign']);
  });

  await test('UTM gate disabled when checkbox not present', async () => {
    stubState.existingCampaignSlugs = new Set();
    stubState.createdCampaign = null;
    const r = await postForm(server, '/admin/campaigns', {
      name: 'Open', slug: 'open',
      threshold: '70', mode: 'log_only',
      // utm_gate_enabled NOT included (unchecked checkbox)
      utm_required_keys: ['source', 'medium', 'campaign'],
    }, authCookie);
    assert.strictEqual(r.status, 302);
    assert.strictEqual(stubState.createdCampaign.filter_config.utm_gate.enabled, false);
  });

  await test('Invalid utm_required_keys are filtered out', async () => {
    stubState.existingCampaignSlugs = new Set();
    stubState.createdCampaign = null;
    const r = await postForm(server, '/admin/campaigns', {
      name: 'Filter Test', slug: 'filter-test',
      threshold: '70', mode: 'log_only',
      utm_gate_enabled: 'on',
      utm_required_keys: ['source', 'evil_key', 'campaign', 'sql_injection'],
    }, authCookie);
    assert.strictEqual(r.status, 302);
    assert.deepStrictEqual(
      stubState.createdCampaign.filter_config.utm_gate.required_keys.sort(),
      ['campaign', 'source']
    );
  });

  console.log('\nAuto-slug on landing page creation:');

  await test('Page slug auto-generated from name', async () => {
    stubState.existingPageSlugs = new Set();
    stubState.createdPage = null;
    const r = await postForm(server, '/admin/pages', {
      name: 'My Sales Page', slug: '',
      kind: 'offer', html_template: '<html></html>',
    }, authCookie);
    assert.strictEqual(r.status, 302);
    assert.strictEqual(stubState.createdPage.slug, 'my-sales-page');
  });

  await test('Page slug gets suffix on collision', async () => {
    stubState.existingPageSlugs = new Set(['my-sales-page']);
    stubState.createdPage = null;
    const r = await postForm(server, '/admin/pages', {
      name: 'My Sales Page', slug: '',
      kind: 'offer', html_template: '<html></html>',
    }, authCookie);
    assert.strictEqual(r.status, 302);
    assert.match(stubState.createdPage.slug, /^my-sales-page-\d{4,}$/);
  });

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
