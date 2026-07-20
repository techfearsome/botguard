// Unit tests for the media upload helpers: type allow-list (SVG excluded),
// filename sanitization (path traversal, unsafe chars, mimetype-forced ext),
// and public URL construction.

const assert = require('assert');
const path = require('path');
const h = require(path.resolve(__dirname, '../src/lib/uploadHelpers'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

console.log('isAllowedMime:');
test('allows png/jpeg/gif/webp', () => {
  ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].forEach((m) => assert.ok(h.isAllowedMime(m), m));
});
test('blocks SVG (XSS risk) and non-images', () => {
  assert.strictEqual(h.isAllowedMime('image/svg+xml'), false);
  assert.strictEqual(h.isAllowedMime('text/html'), false);
  assert.strictEqual(h.isAllowedMime('application/octet-stream'), false);
  assert.strictEqual(h.isAllowedMime(''), false);
  assert.strictEqual(h.isAllowedMime(undefined), false);
});
test('case-insensitive', () => {
  assert.ok(h.isAllowedMime('IMAGE/PNG'));
});

console.log('\nsanitizeFilename:');
test('lowercases, replaces unsafe chars, forces mimetype extension', () => {
  assert.strictEqual(h.sanitizeFilename('My Photo (1).PNG', 'image/png'), 'my-photo-1.png');
});
test('strips path traversal', () => {
  assert.strictEqual(h.sanitizeFilename('../../etc/passwd', 'image/jpeg'), 'passwd.jpg');
  assert.strictEqual(h.sanitizeFilename('..\\..\\windows\\evil', 'image/gif'), 'evil.gif');
});
test('extension always matches the detected mimetype (URL cannot lie)', () => {
  assert.strictEqual(h.sanitizeFilename('logo.gif', 'image/png'), 'logo.png');
  assert.strictEqual(h.sanitizeFilename('pic.png', 'image/webp'), 'pic.webp');
});
test('empty / weird names fall back to "image"', () => {
  assert.strictEqual(h.sanitizeFilename('', 'image/png'), 'image.png');
  assert.strictEqual(h.sanitizeFilename('!!!', 'image/png'), 'image.png');
  assert.strictEqual(h.sanitizeFilename('.hidden', 'image/png'), 'image.png');
});
test('long names are truncated', () => {
  const out = h.sanitizeFilename('a'.repeat(200), 'image/png');
  assert.ok(out.length <= 64, `too long: ${out.length}`);
});

console.log('\npublicUrl:');
test('builds the wp-content path', () => {
  assert.strictEqual(h.publicUrl('abc123', 'logo.png'), '/wp-content/uploads/abc123/logo.png');
});

console.log('\nMAX_BYTES:');
test('cap is 8 MB (under Mongo 16 MB doc limit)', () => {
  assert.strictEqual(h.MAX_BYTES, 8 * 1024 * 1024);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
