// Unit tests for resolveRedirectUrl — device-specific redirect destinations,
// mirroring the per-device offer/safe page resolution.

const assert = require('assert');
const path = require('path');
const { resolveRedirectUrl, normalizeRedirectUrl } = require(path.resolve(__dirname, '../src/lib/redirect'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

console.log('resolveRedirectUrl:');

test('per-device override wins', () => {
  const c = { redirect_urls: { default: 'https://d.com', iphone: 'https://i.com' } };
  assert.strictEqual(resolveRedirectUrl(c, 'iphone'), 'https://i.com');
});

test('falls back to default when no device override', () => {
  const c = { redirect_urls: { default: 'https://d.com', iphone: 'https://i.com' } };
  assert.strictEqual(resolveRedirectUrl(c, 'windows'), 'https://d.com');
});

test('blank device override falls through to default', () => {
  const c = { redirect_urls: { default: 'https://d.com', android: '   ' } };
  assert.strictEqual(resolveRedirectUrl(c, 'android'), 'https://d.com');
});

test('legacy redirect_url used when no redirect_urls', () => {
  assert.strictEqual(resolveRedirectUrl({ redirect_url: 'https://legacy.com' }, 'iphone'), 'https://legacy.com');
});

test('legacy used when redirect_urls has no default and no device', () => {
  const c = { redirect_urls: { iphone: 'https://i.com' }, redirect_url: 'https://legacy.com' };
  assert.strictEqual(resolveRedirectUrl(c, 'windows'), 'https://legacy.com');
});

test('empty when nothing configured', () => {
  assert.strictEqual(resolveRedirectUrl({}, 'iphone'), '');
  assert.strictEqual(resolveRedirectUrl(null, 'iphone'), '');
});

test('each device class resolves independently', () => {
  const c = { redirect_urls: { default: 'https://d.com', iphone: 'https://i.com', android: 'https://a.com', mac: 'https://m.com' } };
  assert.strictEqual(resolveRedirectUrl(c, 'iphone'), 'https://i.com');
  assert.strictEqual(resolveRedirectUrl(c, 'android'), 'https://a.com');
  assert.strictEqual(resolveRedirectUrl(c, 'mac'), 'https://m.com');
  assert.strictEqual(resolveRedirectUrl(c, 'linux'), 'https://d.com'); // no override → default
});

console.log('\nnormalizeRedirectUrl (scheme-less → https, fixes duplicated-domain bug):');

test('bare host/path gets https:// prepended', () => {
  assert.strictEqual(normalizeRedirectUrl('cookingshow.space/indian-cooking'), 'https://cookingshow.space/indian-cooking');
  assert.strictEqual(normalizeRedirectUrl('example.com'), 'https://example.com');
});
test('already-absolute URLs are left alone', () => {
  assert.strictEqual(normalizeRedirectUrl('https://x.com/a'), 'https://x.com/a');
  assert.strictEqual(normalizeRedirectUrl('http://x.com'), 'http://x.com');
});
test('protocol-relative gets https:', () => {
  assert.strictEqual(normalizeRedirectUrl('//host/p'), 'https://host/p');
});
test('genuine relative path (no host) is left as-is (validation rejects later)', () => {
  assert.strictEqual(normalizeRedirectUrl('/relative-path'), '/relative-path');
});
test('resolveRedirectUrl normalizes its result', () => {
  assert.strictEqual(resolveRedirectUrl({ redirect_urls: { default: 'cookingshow.space/x' } }, 'windows'), 'https://cookingshow.space/x');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
