// Tests for the third-party tracking injection helper

const assert = require('assert');
const path = require('path');
const { buildTrackingInjection, isValidClarityId } = require(path.join(__dirname, '../src/lib/tracking'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

console.log('Clarity ID validation:');

test('Real Clarity ID format passes', () => {
  assert.strictEqual(isValidClarityId('wjsr5hjt53'), true);
});

test('Alphanumeric variations pass', () => {
  assert.strictEqual(isValidClarityId('abc123XYZ'), true);
  assert.strictEqual(isValidClarityId('abc-def-123'), true);
});

test('Empty string rejected', () => {
  assert.strictEqual(isValidClarityId(''), false);
});

test('Null / undefined rejected', () => {
  assert.strictEqual(isValidClarityId(null), false);
  assert.strictEqual(isValidClarityId(undefined), false);
});

test('Non-string rejected', () => {
  assert.strictEqual(isValidClarityId(12345), false);
  assert.strictEqual(isValidClarityId({}), false);
});

test('Too long (33+ chars) rejected', () => {
  assert.strictEqual(isValidClarityId('a'.repeat(33)), false);
});

test('Special chars rejected (XSS prevention)', () => {
  // The whole point of validation: prevent script injection via the ID
  assert.strictEqual(isValidClarityId('"; alert(1); //'), false);
  assert.strictEqual(isValidClarityId('abc\";evil"'), false);
  assert.strictEqual(isValidClarityId('abc<script>'), false);
  assert.strictEqual(isValidClarityId('abc def'), false);     // spaces
  assert.strictEqual(isValidClarityId('abc.def'), false);     // dots
  assert.strictEqual(isValidClarityId('abc/def'), false);     // slashes
});

console.log('\nClarity injection:');

test('No project ID → empty injection', () => {
  assert.strictEqual(buildTrackingInjection({}), '');
  assert.strictEqual(buildTrackingInjection({ clarityProjectId: '' }), '');
  assert.strictEqual(buildTrackingInjection({ clarityProjectId: null }), '');
});

test('Invalid project ID → no injection (fail-safe)', () => {
  // Even though the route validates, the helper itself should be defense-in-depth
  assert.strictEqual(buildTrackingInjection({ clarityProjectId: '"; alert(1)' }), '');
  assert.strictEqual(buildTrackingInjection({ clarityProjectId: 'a b c' }), '');
});

test('Valid project ID → script tag with correct snippet', () => {
  const html = buildTrackingInjection({ clarityProjectId: 'wjsr5hjt53' });
  assert.match(html, /<script type="text\/javascript">/);
  assert.match(html, /clarity\.ms\/tag/);
  assert.ok(html.includes('"wjsr5hjt53"'), 'project ID should be embedded as JS string');
});

test('Project ID is interpolated as a string literal', () => {
  const html = buildTrackingInjection({ clarityProjectId: 'abc123' });
  // Should be inside double quotes after "script", not bare
  assert.match(html, /"script",\s*"abc123"/);
});

test('Multiple calls with same ID produce identical output', () => {
  const a = buildTrackingInjection({ clarityProjectId: 'wjsr5hjt53' });
  const b = buildTrackingInjection({ clarityProjectId: 'wjsr5hjt53' });
  assert.strictEqual(a, b);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
