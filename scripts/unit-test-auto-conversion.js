// Tests for auto-conversion injection logic

const assert = require('assert');
const path = require('path');
const { buildInjection, DEFAULT_TERMS } = require(path.join(__dirname, '../src/lib/autoConversion'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

console.log('Auto-conversion injection:');

test('Builds a script tag with config and runtime', () => {
  const html = buildInjection({ terms: ['Download'] });
  assert.ok(html.includes('<script type="application/json" id="bg-auto-conv-config">'));
  // After the config block there should be another <script> for the runtime
  const configEnd = html.indexOf('</script>');
  assert.ok(configEnd > 0);
  const afterConfig = html.slice(configEnd + 9);    // strip first </script>
  assert.ok(afterConfig.includes('<script>'), 'runtime <script> not found after config');
  assert.ok(html.toLowerCase().includes('download'));
});

test('Empty terms list falls back to defaults', () => {
  const html = buildInjection({ terms: [] });
  // Should contain at least one default term
  assert.ok(html.toLowerCase().includes('download'), 'expected default terms');
  assert.ok(html.toLowerCase().includes('subscribe'));
});

test('Missing terms parameter falls back to defaults', () => {
  const html = buildInjection({});
  assert.ok(html.toLowerCase().includes('download'));
});

test('DEFAULT_TERMS is non-empty and has expected entries', () => {
  assert.ok(DEFAULT_TERMS.length > 5);
  const lower = DEFAULT_TERMS.map(t => t.toLowerCase());
  assert.ok(lower.includes('download'));
  assert.ok(lower.includes('subscribe'));
  assert.ok(lower.includes('install'));
});

test('Terms are normalized to lowercase in the injection', () => {
  const html = buildInjection({ terms: ['DOWNLOAD', 'Subscribe', 'place ORDER'] });
  // Find the JSON config block
  const m = html.match(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(m, 'config block not found');
  const cfg = JSON.parse(m[1]);
  assert.deepStrictEqual(cfg.terms.sort(), ['download', 'place order', 'subscribe']);
});

test('Duplicate terms are deduped', () => {
  const html = buildInjection({ terms: ['Download', 'DOWNLOAD', 'download'] });
  const m = html.match(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/);
  const cfg = JSON.parse(m[1]);
  assert.deepStrictEqual(cfg.terms, ['download']);
});

test('Empty / whitespace terms are dropped', () => {
  const html = buildInjection({ terms: ['Download', '', '   ', null, 'Submit'] });
  const m = html.match(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/);
  const cfg = JSON.parse(m[1]);
  assert.deepStrictEqual(cfg.terms.sort(), ['download', 'submit']);
});

test('Custom event_name is preserved', () => {
  const html = buildInjection({ terms: ['Install'], eventName: 'app_install' });
  const m = html.match(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/);
  const cfg = JSON.parse(m[1]);
  assert.strictEqual(cfg.event_name, 'app_install');
});

test('Custom endpoint is preserved', () => {
  const html = buildInjection({ terms: ['Install'], endpoint: '/custom/conv' });
  const m = html.match(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/);
  const cfg = JSON.parse(m[1]);
  assert.strictEqual(cfg.endpoint, '/custom/conv');
});

test('Default endpoint is /cb/auto-conv', () => {
  const html = buildInjection({ terms: ['Install'] });
  const m = html.match(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/);
  const cfg = JSON.parse(m[1]);
  assert.strictEqual(cfg.endpoint, '/cb/auto-conv');
});

test('Session cookie name and TTL are sane', () => {
  const html = buildInjection({ terms: ['x'] });
  const m = html.match(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/);
  const cfg = JSON.parse(m[1]);
  assert.strictEqual(cfg.session_cookie, 'bg_conv');
  assert.strictEqual(cfg.session_days, 30);
});

test('XSS attempt in term is JSON-escaped, not executed', () => {
  const evilTerm = '</script><script>alert(1)</script>';
  const html = buildInjection({ terms: [evilTerm] });
  // The literal </script> sequence should not appear UNESCAPED in the JSON config.
  // It should be escaped to <\/script>
  const configBlock = html.match(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(configBlock, 'config block should still parse out cleanly');
  // The matched config block must be valid JSON (i.e. our escaping worked)
  assert.doesNotThrow(() => JSON.parse(configBlock[1]));
});

test('U+2028 and U+2029 in terms are escaped', () => {
  const html = buildInjection({ terms: ['line\u2028break', 'para\u2029break'] });
  // Find the config block - the raw chars should be replaced with escape sequences
  const idx = html.indexOf('<script type="application/json"');
  const endIdx = html.indexOf('</script>', idx);
  const block = html.slice(idx, endIdx);
  assert.ok(!block.includes('\u2028'), 'U+2028 should be escaped');
  assert.ok(!block.includes('\u2029'), 'U+2029 should be escaped');
});

test('Runtime script reads cookie, matches text, sends beacon - smoke check', () => {
  const html = buildInjection({ terms: ['Download'] });
  // Runtime should mention the key APIs we depend on
  assert.match(html, /document\.addEventListener.*click/);
  assert.match(html, /sendBeacon|fetch/);
  assert.match(html, /bg_cid/);          // reads click_id
  assert.match(html, /bg_conv/);           // session dedup cookie
});

test('Runtime script wraps everything in try/catch (defensive)', () => {
  const html = buildInjection({ terms: ['x'] });
  // Should have at least 2 try/catch blocks (outer + inner click handler)
  const tryCount = (html.match(/try\s*\{/g) || []).length;
  assert.ok(tryCount >= 2, `expected >=2 try blocks, got ${tryCount}`);
});

test('Runtime caps text length to prevent pathological matching', () => {
  const html = buildInjection({ terms: ['x'] });
  assert.match(html, /\.length\s*>\s*200|slice\(0,\s*200\)/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
