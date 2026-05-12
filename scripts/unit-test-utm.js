// Unit tests for parseUtm and parseExternalIds.
//
// The case-sensitivity tests are the most important ones here. Google Ads
// silently rejects conversion uploads when gclid/wbraid/gbraid are stored
// with altered case. If anyone ever adds a .toLowerCase() to the capture
// path, these tests catch it before production.

const assert = require('assert');
const path = require('path');
const {
  parseUtm, parseExternalIds, parseValueTrack,
  UTM_KEYS, EXTERNAL_ID_KEYS,
  GOOGLE_VALUETRACK_CORE, GOOGLE_VALUETRACK_KEYS, BING_VALUETRACK_KEYS,
} = require(
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

console.log('\nparseValueTrack - constants:');

test('GOOGLE_VALUETRACK_CORE contains the 15 essential params', () => {
  // Lock the canonical list. If a future change removes one of these,
  // we want to know.
  for (const key of [
    'campaignid', 'adgroupid', 'creative', 'keyword', 'matchtype',
    'network', 'device', 'devicemodel', 'targetid', 'placement',
    'adposition', 'loc_physical_ms', 'loc_interest_ms',
    'feeditemid', 'extensionid',
  ]) {
    assert.ok(GOOGLE_VALUETRACK_CORE.includes(key),
      `GOOGLE_VALUETRACK_CORE missing ${key}`);
  }
});

test('GOOGLE_VALUETRACK_KEYS includes shopping/travel params', () => {
  for (const key of ['product_id', 'merchant_id', 'hotel_id', 'travel_start_year']) {
    assert.ok(GOOGLE_VALUETRACK_KEYS.includes(key),
      `GOOGLE_VALUETRACK_KEYS missing shopping/travel key ${key}`);
  }
});

test('BING_VALUETRACK_KEYS includes Bing-specific params', () => {
  for (const key of ['querystring', 'matchtype', 'adid', 'orderitemid']) {
    assert.ok(BING_VALUETRACK_KEYS.includes(key),
      `BING_VALUETRACK_KEYS missing ${key}`);
  }
});

console.log('\nparseValueTrack - basic capture:');

test('Returns empty object for null/non-object/empty input', () => {
  assert.deepStrictEqual(parseValueTrack(null), {});
  assert.deepStrictEqual(parseValueTrack(undefined), {});
  assert.deepStrictEqual(parseValueTrack('not an object'), {});
  assert.deepStrictEqual(parseValueTrack({}), {});
});

test('Captures Google ValueTrack when gclid is present', () => {
  const out = parseValueTrack({
    gclid: 'CjwKCAjw',
    campaignid: '12345678',
    adgroupid: '87654321',
    keyword: 'cooking school nyc',
    matchtype: 'e',
    network: 'g',
    device: 'm',
    placement: 'example.com',
  });
  assert.ok(out.google, 'expected google subdoc');
  assert.strictEqual(out.google.campaignid, '12345678');
  assert.strictEqual(out.google.keyword, 'cooking school nyc');
  assert.strictEqual(out.google.matchtype, 'e');
  assert.strictEqual(out.google.network, 'g');
});

test('Captures Google ValueTrack when wbraid is present (iOS)', () => {
  // wbraid is the iOS aggregate identifier - same Google platform
  const out = parseValueTrack({
    wbraid: 'CjkKCA',
    campaignid: '999',
    keyword: 'iphone keyword',
  });
  assert.ok(out.google);
  assert.strictEqual(out.google.campaignid, '999');
});

test('Captures Google ValueTrack when gbraid is present', () => {
  const out = parseValueTrack({
    gbraid: 'CjkKCA',
    campaignid: '111',
  });
  assert.ok(out.google);
  assert.strictEqual(out.google.campaignid, '111');
});

test('Captures Bing ValueTrack when msclkid is present (no Google IDs)', () => {
  const out = parseValueTrack({
    msclkid: 'bing123',
    campaignid: '5555',
    adid: 'bingad',
    querystring: 'cooking class nyc',
  });
  assert.ok(out.bing, 'expected bing subdoc');
  assert.ok(!out.google, 'should NOT populate google when only msclkid present');
  assert.strictEqual(out.bing.campaignid, '5555');
  assert.strictEqual(out.bing.adid, 'bingad');
  assert.strictEqual(out.bing.querystring, 'cooking class nyc');
});

test('Defaults to Google semantics when no click ID is present', () => {
  // Direct traffic with manual ValueTrack tagging (unusual but possible).
  // We can't tell which platform; default to Google since it's the more
  // common case in practice.
  const out = parseValueTrack({
    campaignid: '777',
    keyword: 'organic',
  });
  assert.ok(out.google);
  assert.strictEqual(out.google.campaignid, '777');
});

test('Captures shopping/travel ValueTrack params', () => {
  const out = parseValueTrack({
    gclid: 'g123',
    product_id: 'SKU-9876',
    merchant_id: '4567',
    product_country: 'US',
  });
  assert.strictEqual(out.google.product_id, 'SKU-9876');
  assert.strictEqual(out.google.merchant_id, '4567');
  assert.strictEqual(out.google.product_country, 'US');
});

console.log('\nparseValueTrack - case sensitivity:');

test('Preserves case in keyword (search terms can be mixed case)', () => {
  const out = parseValueTrack({
    gclid: 'g1',
    keyword: 'Best Cooking Schools NYC',
  });
  assert.strictEqual(out.google.keyword, 'Best Cooking Schools NYC');
});

test('Preserves case in placement (URLs are case-sensitive)', () => {
  const out = parseValueTrack({
    gclid: 'g1',
    placement: 'Example.COM/Path',
  });
  assert.strictEqual(out.google.placement, 'Example.COM/Path');
});

console.log('\nparseValueTrack - allowlist enforcement:');

test('Ignores unknown query parameters (no schema pollution)', () => {
  // We don't want random URL junk landing in the valuetrack subdoc.
  const out = parseValueTrack({
    gclid: 'g1',
    campaignid: '123',
    random_junk: 'should be ignored',
    spam_param: 'also ignored',
    xss_attempt: '<script>alert(1)</script>',
  });
  assert.strictEqual(out.google.campaignid, '123');
  assert.strictEqual(out.google.random_junk, undefined);
  assert.strictEqual(out.google.spam_param, undefined);
  assert.strictEqual(out.google.xss_attempt, undefined);
});

test('Omits google subdoc entirely when no Google VT params present', () => {
  // Just a gclid with no other VT params - the google subdoc would be {}.
  // The function should not populate it (saves Mongo space across millions
  // of clicks that have a gclid but no other VT tagging).
  const out = parseValueTrack({ gclid: 'g1' });
  assert.strictEqual(out.google, undefined);
});

console.log('\nparseValueTrack - DoS protection:');

test('Caps each value at 512 characters', () => {
  const long = 'X'.repeat(2000);
  const out = parseValueTrack({ gclid: 'g1', keyword: long });
  assert.strictEqual(out.google.keyword.length, 512);
});

test('Ignores non-string values', () => {
  const out = parseValueTrack({
    gclid: 'g1',
    campaignid: '123',
    keyword: { not: 'a string' },
    matchtype: ['array'],
    network: 42,
  });
  assert.strictEqual(out.google.campaignid, '123');
  assert.strictEqual(out.google.keyword, undefined);
  assert.strictEqual(out.google.matchtype, undefined);
  assert.strictEqual(out.google.network, undefined);
});

test('Ignores empty string values', () => {
  // Some advertisers leave placeholder syntax in their URLs that Google
  // doesn't substitute (e.g. {keyword} on a display-network click). Google
  // replaces with empty string per their docs. We should NOT store empty.
  const out = parseValueTrack({
    gclid: 'g1',
    campaignid: '123',
    keyword: '',
    matchtype: '',
  });
  assert.strictEqual(out.google.campaignid, '123');
  assert.ok(!('keyword' in out.google), 'empty keyword should not be stored');
  assert.ok(!('matchtype' in out.google), 'empty matchtype should not be stored');
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
