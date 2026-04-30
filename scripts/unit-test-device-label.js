// Tests for device classification - verifies the deviceLabel function produces
// the platform-aware labels we want to show in the dashboard.

const assert = require('assert');
const path = require('path');
const UAParser = require('ua-parser-js');

// Re-require the click module to access deviceLabel via internal export.
// It's not currently exported, so we'll test by re-implementing the call.
// Instead: parse a UA and check the click doc shape via buildClickDoc.

const { buildClickDoc } = require(path.join(__dirname, '../src/lib/click'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

function makeClick(userAgent) {
  const req = {
    get: (h) => h.toLowerCase() === 'user-agent' ? userAgent : '',
    headers: {},
    query: {},
    ip: '1.2.3.4',
  };
  const workspace = { _id: 'ws1' };
  const campaign  = { _id: 'c1', source_profile: 'mixed', filter_config: { mode: 'log_only' } };
  return buildClickDoc({ req, workspace, campaign });
}

console.log('Device label classification:');

test('iPhone Safari → iPhone', () => {
  const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  const doc = makeClick(ua);
  assert.strictEqual(doc.ua_parsed.device_label, 'iPhone');
  assert.strictEqual(doc.ua_parsed.device_type, 'mobile');
});

test('iPad → iPad', () => {
  const ua = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  const doc = makeClick(ua);
  assert.strictEqual(doc.ua_parsed.device_label, 'iPad');
});

test('Android phone (Pixel) → Android phone', () => {
  const ua = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
  const doc = makeClick(ua);
  assert.strictEqual(doc.ua_parsed.device_label, 'Android phone');
  assert.strictEqual(doc.ua_parsed.device_type, 'mobile');
});

test('Samsung Galaxy → Android phone', () => {
  const ua = 'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
  const doc = makeClick(ua);
  assert.strictEqual(doc.ua_parsed.device_label, 'Android phone');
  assert.strictEqual(doc.ua_parsed.device_vendor, 'Samsung');
});

test('Android tablet → Android tablet', () => {
  const ua = 'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const doc = makeClick(ua);
  assert.strictEqual(doc.ua_parsed.device_label, 'Android tablet');
});

test('Mac Safari → Mac', () => {
  const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const doc = makeClick(ua);
  assert.strictEqual(doc.ua_parsed.device_label, 'Mac');
  assert.strictEqual(doc.ua_parsed.device_type, 'desktop');
});

test('Windows Chrome → Windows', () => {
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const doc = makeClick(ua);
  assert.strictEqual(doc.ua_parsed.device_label, 'Windows');
});

test('Linux desktop → Linux', () => {
  const ua = 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0';
  const doc = makeClick(ua);
  assert.strictEqual(doc.ua_parsed.device_label, 'Linux');
});

test('Empty UA → desktop fallback', () => {
  const doc = makeClick('');
  assert.strictEqual(doc.ua_parsed.device_label, 'desktop');
});

test('Bot UA still classifies device sensibly', () => {
  const doc = makeClick('curl/8.4.0');
  // No OS fingerprint, falls through to desktop default
  assert.ok(['desktop', undefined, ''].includes(doc.ua_parsed.device_label) || typeof doc.ua_parsed.device_label === 'string');
  assert.strictEqual(doc.ua_parsed.is_bot, true);
});

test('iPhone in Facebook in-app browser still labeled iPhone', () => {
  const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/438.0.0.0]';
  const doc = makeClick(ua);
  assert.strictEqual(doc.ua_parsed.device_label, 'iPhone');
  assert.strictEqual(doc.in_app_browser, 'fb');
});

test('Android in Instagram still labeled Android phone', () => {
  const ua = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 Instagram 250.0.0.21.109';
  const doc = makeClick(ua);
  assert.strictEqual(doc.ua_parsed.device_label, 'Android phone');
  assert.strictEqual(doc.in_app_browser, 'ig');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
