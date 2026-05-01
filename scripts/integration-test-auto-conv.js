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
      findOne: (q) => {
        const result = stubState.click;
        return {
          lean: async () => result,
          select: () => ({ lean: async () => result }),
        };
      },
      updateOne: async (q, u) => {
        stubState.clickUpdates.push({ q, u });
        return {
          acknowledged: true,
          matchedCount: stubState.click ? 1 : 0,
          modifiedCount: stubState.click ? 1 : 0,
        };
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
// Match server.js body parser - accepts JSON for application/json AND text/plain
// (some browsers send sendBeacon JSON with text/plain content-type)
app.use(express.json({ type: ['application/json', 'text/plain'] }));
app.use('/cb', postbackRouter);

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

function postJson(server, urlPath, body, cookies = '') {
  return postJsonWithReferer(server, urlPath, body, cookies, '');
}

function postJsonWithContentType(server, urlPath, body, contentType) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method: 'POST',
      headers: {
        'Content-Type': contentType,
        'Content-Length': Buffer.byteLength(data),
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

function postJsonWithReferer(server, urlPath, body, cookies, referer) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const data = JSON.stringify(body);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
      'Cookie': cookies,
    };
    if (referer) headers['Referer'] = referer;
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method: 'POST', headers,
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

  await test('Conversion sets bg_conv cookie containing the click_id (per-click dedup)', async () => {
    stubState = makeState();
    const r = await postJson(server, '/cb/auto-conv', { click_id: 'CLICK123', term: 'download' });
    const setCookie = r.headers['set-cookie'] || [];
    // Cookie value is now the click_id, not just '1' - so dedup is per-click-id
    assert.ok(setCookie.some(c => /^bg_conv=CLICK123/.test(c)), `expected bg_conv=CLICK123, got: ${setCookie}`);
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

  await test('bg_conv cookie matching current click_id → dedup, no new conversion', async () => {
    stubState = makeState();
    const r = await postJson(server, '/cb/auto-conv',
      { click_id: 'CLICK123', term: 'download' },
      'bg_conv=CLICK123');     // value matches click_id → dedup
    assert.strictEqual(r.status, 200);
    const json = JSON.parse(r.body);
    assert.strictEqual(json.ok, true);
    assert.strictEqual(json.dedup, true);
    assert.strictEqual(stubState.conversions.length, 0);
    assert.strictEqual(stubState.clickUpdates.length, 0);
  });

  await test('bg_conv cookie from DIFFERENT click_id → conversion fires (fresh session)', async () => {
    // Critical: stale bg_conv from a previous ad campaign must not block fresh conversions
    stubState = makeState();
    const r = await postJson(server, '/cb/auto-conv',
      { click_id: 'CLICK_NEW', term: 'download' },
      'bg_conv=CLICK_OLD');    // different click_id → not dedup
    assert.strictEqual(r.status, 200);
    const json = JSON.parse(r.body);
    assert.strictEqual(json.ok, true);
    assert.notStrictEqual(json.dedup, true, 'should NOT dedup for different click_id');
    assert.strictEqual(stubState.conversions.length, 1);
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

  await test('Debug mode via ?bg_debug=1 query string also bypasses dedup (no Referer needed)', async () => {
    // Critical: incognito mode strips Referer, so query string is the reliable signal
    stubState = makeState();
    const r = await postJsonWithReferer(server, '/cb/auto-conv?bg_debug=1',
      { click_id: 'CLICK123', term: 'download' },
      'bg_conv=CLICK123',     // would dedup if not for debug mode
      '');     // NO referer at all - simulates incognito mode
    assert.strictEqual(r.status, 200);
    const json = JSON.parse(r.body);
    assert.notStrictEqual(json.dedup, true, 'should NOT be deduped when ?bg_debug=1 in URL');
    assert.strictEqual(stubState.conversions.length, 1, 'conversion should be recorded');
  });

  await test('Debug mode (Referer contains bg_debug=1) bypasses dedup cookie', async () => {
    stubState = makeState();
    // Has matching bg_conv cookie (would normally cause dedup) BUT referer says debug mode
    const r = await postJsonWithReferer(server, '/cb/auto-conv',
      { click_id: 'CLICK123', term: 'download' },
      'bg_conv=CLICK123',
      'https://example.com/go/demo?bg_debug=1');
    assert.strictEqual(r.status, 200);
    const json = JSON.parse(r.body);
    assert.strictEqual(json.ok, true);
    assert.notStrictEqual(json.dedup, true, 'should NOT be deduped in debug mode');
    assert.strictEqual(stubState.conversions.length, 1, 'conversion should be recorded');
  });

  await test('Debug mode does NOT apply when bg_debug not in referer', async () => {
    stubState = makeState();
    const r = await postJsonWithReferer(server, '/cb/auto-conv',
      { click_id: 'CLICK123', term: 'download' },
      'bg_conv=CLICK123',
      'https://example.com/go/demo');     // no bg_debug
    assert.strictEqual(r.status, 200);
    const json = JSON.parse(r.body);
    assert.strictEqual(json.dedup, true, 'should still dedup without debug flag');
    assert.strictEqual(stubState.conversions.length, 0);
  });

  await test('sendBeacon-style request with text/plain content-type still works', async () => {
    // sendBeacon's Blob with type 'application/json' sometimes arrives with
    // content-type 'text/plain' due to browser quirks. The JSON body must
    // still be parsed.
    stubState = makeState();
    const r = await postJsonWithContentType(server, '/cb/auto-conv',
      { click_id: 'CLICK123', term: 'call' },
      'text/plain');
    assert.strictEqual(r.status, 200, `expected 200, got ${r.status}: ${r.body}`);
    const json = JSON.parse(r.body);
    assert.strictEqual(json.ok, true);
    assert.strictEqual(stubState.conversions.length, 1, 'conversion should be recorded');
    assert.strictEqual(stubState.conversions[0].matched_term, 'call');
  });

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
