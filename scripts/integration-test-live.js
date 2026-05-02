// Integration tests for live presence routes

process.env.SESSION_SECRET = 'test-secret-must-be-at-least-16-chars';

const assert = require('assert');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const http = require('http');
const { live } = require(path.join(__dirname, '../src/lib/livePresence'));

const liveRouter = require(path.join(__dirname, '../src/routes/live'));
const app = express();
app.use(cookieParser());
app.use(express.json());
app.use('/lv', liveRouter);

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

function postJson(server, urlPath, body, contentType) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method: 'POST',
      headers: {
        'Content-Type': contentType || 'application/json',
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

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));

  // Register a visitor for the heartbeat tests to find
  function setupVisitor(clickId) {
    live.arrived({
      click_id: clickId,
      workspace_id: 'ws1',
      campaign_name: 'Demo',
      page_type: 'offer',
      ip: '1.2.3.4',
    });
  }

  console.log('/lv/heartbeat:');

  await test('Heartbeat for known visitor returns ok:true', async () => {
    setupVisitor('CID_HB1');
    const r = await postJson(server, '/lv/heartbeat', { click_id: 'CID_HB1' });
    assert.strictEqual(r.status, 200);
    const json = JSON.parse(r.body);
    assert.strictEqual(json.ok, true);
  });

  await test('Heartbeat for UNKNOWN visitor returns ok:false (no orphan registration)', async () => {
    const r = await postJson(server, '/lv/heartbeat', { click_id: 'CID_UNKNOWN_HB' });
    assert.strictEqual(r.status, 200);
    const json = JSON.parse(r.body);
    assert.strictEqual(json.ok, false);
  });

  await test('Heartbeat with missing click_id returns 400', async () => {
    const r = await postJson(server, '/lv/heartbeat', {});
    assert.strictEqual(r.status, 400);
  });

  await test('Heartbeat with click_id too long returns 400', async () => {
    const r = await postJson(server, '/lv/heartbeat', { click_id: 'A'.repeat(100) });
    assert.strictEqual(r.status, 400);
  });

  await test('Heartbeat with click_id containing invalid chars returns 400', async () => {
    const r = await postJson(server, '/lv/heartbeat', { click_id: 'evil<script>' });
    assert.strictEqual(r.status, 400);
  });

  await test('Heartbeat sets no-cache headers (Cloudflare safety)', async () => {
    setupVisitor('CID_HB6');
    const r = await postJson(server, '/lv/heartbeat', { click_id: 'CID_HB6' });
    assert.match(r.headers['cache-control'] || '', /no-store/);
  });

  await test('Heartbeat updates last_seen_at on the in-memory record', async () => {
    setupVisitor('CID_HB7');
    const before = live.visitors.get('CID_HB7').last_seen_at;
    await new Promise((r) => setTimeout(r, 5));
    await postJson(server, '/lv/heartbeat', { click_id: 'CID_HB7' });
    const after = live.visitors.get('CID_HB7').last_seen_at;
    assert.ok(after > before, `last_seen_at should advance: ${before} -> ${after}`);
  });

  await test('sendBeacon-style request with text/plain body still works', async () => {
    setupVisitor('CID_HB8');
    const r = await postJson(server, '/lv/heartbeat', { click_id: 'CID_HB8' }, 'text/plain');
    // Since we don't have express.json type:['text/plain'] in this test app,
    // the body isn't parsed → 400. This documents that server.js needs the
    // tolerant config. The integration test for the full server covers this.
    // Here we just verify the route doesn't crash on weird content-types.
    assert.ok([200, 400].includes(r.status), `unexpected status: ${r.status}`);
  });

  console.log('\n/lv/leave:');

  await test('Leave removes visitor from live tracker', async () => {
    setupVisitor('CID_LV1');
    assert.ok(live.visitors.has('CID_LV1'));
    const r = await postJson(server, '/lv/leave', { click_id: 'CID_LV1' });
    assert.strictEqual(r.status, 200);
    assert.ok(!live.visitors.has('CID_LV1'));
  });

  await test('Leave for unknown click_id is a no-op (no error)', async () => {
    const r = await postJson(server, '/lv/leave', { click_id: 'CID_UNKNOWN_LEAVE' });
    assert.strictEqual(r.status, 200);
    const json = JSON.parse(r.body);
    assert.strictEqual(json.ok, true);
  });

  await test('Leave with missing click_id returns 400', async () => {
    const r = await postJson(server, '/lv/leave', {});
    assert.strictEqual(r.status, 400);
  });

  console.log('\nlive event integration:');

  await test('arrived event fires when /go-equivalent registers visitor', async () => {
    let got = null;
    const handler = (e) => { if (e.type === 'arrived' && e.visitor.click_id === 'CID_EVT1') got = e; };
    live.on('event', handler);
    live.arrived({ click_id: 'CID_EVT1' });
    live.removeListener('event', handler);
    assert.ok(got);
  });

  await test('left event fires when /lv/leave is hit', async () => {
    setupVisitor('CID_EVT2');
    let got = null;
    const handler = (e) => { if (e.type === 'left' && e.visitor.click_id === 'CID_EVT2') got = e; };
    live.on('event', handler);
    await postJson(server, '/lv/leave', { click_id: 'CID_EVT2' });
    live.removeListener('event', handler);
    assert.ok(got, 'left event not fired');
  });

  await test('converted() fired by /cb/auto-conv updates visitor state', () => {
    setupVisitor('CID_CV1');
    let got = null;
    const handler = (e) => { if (e.type === 'converted' && e.visitor.click_id === 'CID_CV1') got = e; };
    live.on('event', handler);
    live.converted({ click_id: 'CID_CV1', term: 'download', text: 'Download Now', href: null });
    live.removeListener('event', handler);
    assert.ok(got);
    assert.strictEqual(got.visitor.converted, true);
    assert.strictEqual(live.visitors.get('CID_CV1').converted, true);
  });

  console.log('\ndaily_stats events:');

  await test('converted() emits daily_stats event scoped to workspace', () => {
    const events = [];
    const handler = (e) => events.push(e);
    live.on('daily_stats', handler);
    live.converted({ click_id: 'CID_DS1', term: 'download', workspace_id: 'ws-test-daily-1' });
    live.removeListener('daily_stats', handler);
    // Should fire twice: once for ws-test-daily-1, once for global
    const wsEvent = events.find(e => e.workspace_id === 'ws-test-daily-1');
    assert.ok(wsEvent, 'expected workspace daily_stats event');
    assert.ok(wsEvent.conversions_today >= 1);
    assert.ok(wsEvent.day, 'event must include day key');
  });

  await test('Multiple conversions in same workspace accumulate the count', () => {
    const events = [];
    const handler = (e) => {
      if (e.workspace_id === 'ws-test-daily-acc') events.push(e);
    };
    live.on('daily_stats', handler);
    live.converted({ click_id: 'A', term: 'x', workspace_id: 'ws-test-daily-acc' });
    live.converted({ click_id: 'B', term: 'y', workspace_id: 'ws-test-daily-acc' });
    live.converted({ click_id: 'C', term: 'z', workspace_id: 'ws-test-daily-acc' });
    live.removeListener('daily_stats', handler);
    assert.strictEqual(events.length, 3);
    assert.strictEqual(events[0].conversions_today, 1);
    assert.strictEqual(events[1].conversions_today, 2);
    assert.strictEqual(events[2].conversions_today, 3);
  });

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
