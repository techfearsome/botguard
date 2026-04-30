// Integration test: /cb/auto-conv endpoint records auto-conversions correctly.

process.env.SESSION_SECRET = 'test-secret-must-be-at-least-16-chars';

const assert = require('assert');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const http = require('http');

// Stub Mongoose models BEFORE requiring the route
const modelsPath = path.resolve(__dirname, '../src/models');
let stubState;
require.cache[modelsPath + '.js'] = require.cache[modelsPath + '/index.js'] = {
  id: modelsPath, filename: modelsPath, loaded: true,
  exports: {
    Click: {
      findOne: (q) => ({
        lean: async () => stubState.click,
      }),
      updateOne: async (q, u) => {
        stubState.clickUpdates.push({ q, u });
        return { acknowledged: true };
      },
    },
    Conversion: {
      create: async (doc) => {
        stubState.conversions.push(doc);
        return { _id: { toString: () => 'conv_' + stubState.conversions.length }, ...doc };
      },
    },
  },
};

const postbackRouter = require(path.resolve(__dirname, '../src/routes/postback'));
const app = express();
app.use(cookieParser());
app.use(express.json());
app.use('/cb', postbackRouter);

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

function postJson(server, urlPath, body, cookies = '') {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'Cookie': cookies,
      },
    }, (res) => {
      let resBody = '';
      res.on('data', (c) => resBody += c);
      res.on('end', () => resolve({ status: res.statusCode, body: resBody, headers: res.headers }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));

  function makeState() {
    return {
      click: {
        click_id: 'CLICK123',
        workspace_id: 'ws1',
        campaign_id: 'c1',
      },
      conversions: [],
      clickUpdates: [],
    };
  }

  console.log('/cb/auto-conv endpoint:');

  await test('Valid request → conversion created with correct fields', async () => {
    stubState = makeState();
    const r = await postJson(server, '/cb/auto-conv', {
      click_id: 'CLICK123',
      event_name: 'install',
      term: 'download',
      text: 'Download Now',
      element: 'button#cta.primary',
      page_url: 'https://example.com/offer',
    });
    assert.strictEqual(r.status, 200);
    const json = JSON.parse(r.body);
    assert.strictEqual(json.ok, true);
    assert.match(json.conversion_id, /^conv_/);
    assert.strictEqual(stubState.conversions.length, 1);
    const conv = stubState.conversions[0];
    assert.strictEqual(conv.click_id, 'CLICK123');
    assert.strictEqual(conv.source, 'auto');
    assert.strictEqual(conv.auto_detected, true);
    assert.strictEqual(conv.matched_term, 'download');
    assert.strictEqual(conv.matched_text, 'Download Now');
    assert.strictEqual(conv.event_name, 'install');
  });

  await test('Conversion sets bg_conv cookie for client-side dedup', async () => {
    stubState = makeState();
    const r = await postJson(server, '/cb/auto-conv', { click_id: 'CLICK123', term: 'download' });
    const setCookie = r.headers['set-cookie'] || [];
    assert.ok(setCookie.some(c => /^bg_conv=1/.test(c)), `expected bg_conv cookie, got: ${setCookie}`);
  });

  await test('Click record is updated with conversion counters', async () => {
    stubState = makeState();
    await postJson(server, '/cb/auto-conv', { click_id: 'CLICK123', term: 'download' });
    assert.strictEqual(stubState.clickUpdates.length, 1);
    const update = stubState.clickUpdates[0];
    assert.strictEqual(update.q.click_id, 'CLICK123');
    assert.strictEqual(update.u.$inc.conversion_count, 1);
    assert.strictEqual(update.u.$inc.auto_conversion_count, 1);
    assert.ok(update.u.$set.last_conversion_at instanceof Date);
  });

  await test('Existing bg_conv cookie → dedup, no new conversion', async () => {
    stubState = makeState();
    const r = await postJson(server, '/cb/auto-conv',
      { click_id: 'CLICK123', term: 'download' },
      'bg_conv=1');
    assert.strictEqual(r.status, 200);
    const json = JSON.parse(r.body);
    assert.strictEqual(json.ok, true);
    assert.strictEqual(json.dedup, true);
    assert.strictEqual(stubState.conversions.length, 0);
    assert.strictEqual(stubState.clickUpdates.length, 0);
  });

  await test('Missing click_id → 400', async () => {
    stubState = makeState();
    const r = await postJson(server, '/cb/auto-conv', { term: 'download' });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(stubState.conversions.length, 0);
  });

  await test('Click_id too long → 400 (input validation)', async () => {
    stubState = makeState();
    const r = await postJson(server, '/cb/auto-conv', {
      click_id: 'A'.repeat(200),
    });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(stubState.conversions.length, 0);
  });

  await test('Click_id non-string → 400', async () => {
    stubState = makeState();
    const r = await postJson(server, '/cb/auto-conv', { click_id: 12345 });
    assert.strictEqual(r.status, 400);
  });

  await test('Unknown click_id → 200 ok:true with ignored:true (no info leak)', async () => {
    stubState = makeState();
    stubState.click = null;     // Click.findOne returns null
    const r = await postJson(server, '/cb/auto-conv', {
      click_id: 'BOGUS',
      term: 'download',
    });
    // Returns 200 not 404 to prevent click_id enumeration attacks
    assert.strictEqual(r.status, 200);
    const json = JSON.parse(r.body);
    assert.strictEqual(json.ok, true);
    assert.strictEqual(json.ignored, true);
    assert.strictEqual(stubState.conversions.length, 0);
  });

  await test('Control characters in text are stripped', async () => {
    stubState = makeState();
    await postJson(server, '/cb/auto-conv', {
      click_id: 'CLICK123',
      term: 'download',
      text: 'Down\x00load\x07 Now',
      element: 'button\x1b#cta',
    });
    const conv = stubState.conversions[0];
    assert.strictEqual(conv.matched_text, 'Download Now');     // control chars gone
    assert.strictEqual(conv.matched_element, 'button#cta');
  });

  await test('Long text is truncated to safe length', async () => {
    stubState = makeState();
    await postJson(server, '/cb/auto-conv', {
      click_id: 'CLICK123',
      text: 'X'.repeat(10000),
    });
    const conv = stubState.conversions[0];
    assert.ok(conv.matched_text.length <= 200, `text length: ${conv.matched_text.length}`);
  });

  await test('No-cache headers set on response', async () => {
    stubState = makeState();
    const r = await postJson(server, '/cb/auto-conv', { click_id: 'CLICK123', term: 'x' });
    assert.match(r.headers['cache-control'] || '', /no-store/);
    assert.match(r.headers['cdn-cache-control'] || '', /no-store/);
  });

  await test('event_name defaults to auto_click when empty', async () => {
    stubState = makeState();
    await postJson(server, '/cb/auto-conv', { click_id: 'CLICK123', term: 'download' });
    const conv = stubState.conversions[0];
    assert.strictEqual(conv.event_name, 'auto_click');
  });

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
