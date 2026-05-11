// Unit tests for parseUtm and parseExternalIds.
//
// The case-sensitivity tests are the most important ones here. Google Ads
// silently rejects conversion uploads when gclid/wbraid/gbraid are stored
// with altered case. If anyone ever adds a .toLowerCase() to the capture
// path, these tests catch it before production.

const assert = require('assert');
const path = require('path');
const { parseUtm, parseExternalIds, UTM_KEYS, EXTERNAL_ID_KEYS } = require(
  path.resolve(__dirname, '../src/lib/utm')
);

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

console.log('EXTERNAL_ID_KEYS:');

test('Includes the full set of supported ad-platform identifiers', () => {
  // If the canonical list shifts, the schema, parser, indexes, and admin
  // displays all need to update together. This test locks the list down.
  assert.deepStrictEqual(
    [...EXTERNAL_ID_KEYS].sort(),
    ['fbclid', 'gbraid', 'gclid', 'li_fat_id', 'msclkid', 'ttclid', 'wbraid'],
  );
});

test('Includes wbraid (iOS in-app → web, the common iOS pattern)', () => {
  assert.ok(EXTERNAL_ID_KEYS.includes('wbraid'));
});

test('Includes gbraid (iOS web → app)', () => {
  assert.ok(EXTERNAL_ID_KEYS.includes('gbraid'));
});

console.log('\nparseExternalIds - basic capture:');

test('Returns empty object for null/undefined/non-object input', () => {
  assert.deepStrictEqual(parseExternalIds(null), {});
  assert.deepStrictEqual(parseExternalIds(undefined), {});
  assert.deepStrictEqual(parseExternalIds('not an object'), {});
  assert.deepStrictEqual(parseExternalIds(42), {});
});

test('Returns empty object when no identifiers are present', () => {
  assert.deepStrictEqual(parseExternalIds({ foo: 'bar', baz: 'qux' }), {});
});

test('Captures gclid', () => {
  const out = parseExternalIds({ gclid: 'CjwKCAjw...example' });
  assert.strictEqual(out.gclid, 'CjwKCAjw...example');
});

test('Captures wbraid', () => {
  const out = parseExternalIds({ wbraid: 'CjkKCAjwABCDEF' });
  assert.strictEqual(out.wbraid, 'CjkKCAjwABCDEF');
});

test('Captures gbraid', () => {
  const out = parseExternalIds({ gbraid: 'CjkKCAjwXYZ123' });
  assert.strictEqual(out.gbraid, 'CjkKCAjwXYZ123');
});

test('Captures fbclid, msclkid, ttclid, li_fat_id', () => {
  const out = parseExternalIds({
    fbclid: 'FB.1.example',
    msclkid: 'bing-click-id',
    ttclid: 'tiktok-click-id',
    li_fat_id: 'linkedin-fat-id',
  });
  assert.strictEqual(out.fbclid, 'FB.1.example');
  assert.strictEqual(out.msclkid, 'bing-click-id');
  assert.strictEqual(out.ttclid, 'tiktok-click-id');
  assert.strictEqual(out.li_fat_id, 'linkedin-fat-id');
});

test('Captures all identifiers together when present on same URL', () => {
  // Per Google docs, a single URL can carry both gclid and wbraid/gbraid
  // simultaneously. We must keep all of them.
  const out = parseExternalIds({
    gclid: 'gclid-value',
    wbraid: 'wbraid-value',
    gbraid: 'gbraid-value',
  });
  assert.strictEqual(out.gclid, 'gclid-value');
  assert.strictEqual(out.wbraid, 'wbraid-value');
  assert.strictEqual(out.gbraid, 'gbraid-value');
});

console.log('\nparseExternalIds - case sensitivity (load-bearing):');

test('Preserves mixed-case in gclid (Google API rejects case-altered values)', () => {
  // Real gclids contain a mix of uppercase, lowercase, digits, and dashes.
  // Any normalization here would silently break conversion uploads.
  const original = 'CjwKCAjw3vyxBhBYEiwAyc';
  const out = parseExternalIds({ gclid: original });
  assert.strictEqual(out.gclid, original);
});

test('Preserves mixed-case in wbraid', () => {
  const original = 'CjkKCAjwABCdefGHIjkl';
  const out = parseExternalIds({ wbraid: original });
  assert.strictEqual(out.wbraid, original);
});

test('Preserves mixed-case in gbraid', () => {
  const original = 'CjkKCAjwXYZabc123';
  const out = parseExternalIds({ gbraid: original });
  assert.strictEqual(out.gbraid, original);
});

test('Does NOT lowercase even when input is all caps', () => {
  // Edge case: what if Google ever sent an all-caps value? We must keep
  // whatever they sent us, exact. The capture path is verbatim.
  const out = parseExternalIds({ gclid: 'ALLCAPS123' });
  assert.strictEqual(out.gclid, 'ALLCAPS123');
});

test('Does NOT uppercase, strip, or transform in any way', () => {
  // Comprehensive defensiveness - characters that some normalizers strip.
  const original = '  CjwKCAjw-_-_3vyxBhBYEiwAyc/+=  ';
  const out = parseExternalIds({ gclid: original });
  // We preserve EXACTLY what was sent (within the length cap). No trim,
  // no normalize, no decode. The query parser already URL-decoded.
  assert.strictEqual(out.gclid, original);
});

console.log('\nparseExternalIds - length cap (DoS protection):');

test('Caps each value at 512 characters', () => {
  const long = 'X'.repeat(2000);
  const out = parseExternalIds({ gclid: long });
  assert.strictEqual(out.gclid.length, 512);
});

test('Ignores non-string values (no crash on object/array input)', () => {
  const out = parseExternalIds({
    gclid: 'real-value',
    wbraid: { not: 'a string' },
    gbraid: ['array', 'of', 'strings'],
    fbclid: 42,
  });
  assert.strictEqual(out.gclid, 'real-value');
  assert.strictEqual(out.wbraid, undefined);
  assert.strictEqual(out.gbraid, undefined);
  assert.strictEqual(out.fbclid, undefined);
});

test('Ignores empty strings (no key set for empty values)', () => {
  const out = parseExternalIds({ gclid: '', wbraid: '' });
  // Empty string is falsy in our `if (v && typeof v === 'string')` check
  // so the key isn't set in the output object. This is correct behavior:
  // empty identifier = no identifier.
  assert.ok(!('gclid' in out));
  assert.ok(!('wbraid' in out));
});

console.log('\nparseUtm - regression coverage (existing behavior unchanged):');

test('Captures all five UTM keys', () => {
  const out = parseUtm({
    utm_source: 'google',
    utm_medium: 'cpc',
    utm_campaign: 'main',
    utm_term: 'shoes',
    utm_content: 'ad1',
  });
  assert.deepStrictEqual(out, {
    source: 'google', medium: 'cpc', campaign: 'main', term: 'shoes', content: 'ad1',
  });
});

test('UTM_KEYS is the canonical five', () => {
  assert.deepStrictEqual(
    [...UTM_KEYS].sort(),
    ['campaign', 'content', 'medium', 'source', 'term'],
  );
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
