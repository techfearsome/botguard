// Unit tests for the intelligence Custom Export helpers:
//   - parseCustomExportParams: clamps/normalizes the form inputs
//   - shapeCustomExportRows: expands IPv6, drops Google-Ads-incompatible masks,
//     preserves the DB ranking order, and caps at the requested limit
//   - rankSort: maps the rank choice to the right Mongo sort

const assert = require('assert');
const path = require('path');
const {
  parseCustomExportParams,
  shapeCustomExportRows,
  rankSort,
} = require(path.resolve(__dirname, '../src/lib/customExport'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

console.log('parseCustomExportParams:');

test('defaults when nothing provided', () => {
  const p = parseCustomExportParams({});
  assert.deepStrictEqual(p, { minScore: 60, frequency: 'all', version: 'all', rank: 'score', limit: 200 });
});

test('score is clamped to 0..100', () => {
  assert.strictEqual(parseCustomExportParams({ min_score: '-5' }).minScore, 0);
  assert.strictEqual(parseCustomExportParams({ min_score: '250' }).minScore, 100);
  assert.strictEqual(parseCustomExportParams({ min_score: '73' }).minScore, 73);
});

test('rank only accepts score|frequency, defaults score', () => {
  assert.strictEqual(parseCustomExportParams({ rank: 'frequency' }).rank, 'frequency');
  assert.strictEqual(parseCustomExportParams({ rank: 'garbage' }).rank, 'score');
});

test('frequency and version are whitelisted', () => {
  assert.strictEqual(parseCustomExportParams({ frequency: 'high' }).frequency, 'high');
  assert.strictEqual(parseCustomExportParams({ frequency: 'nope' }).frequency, 'all');
  assert.strictEqual(parseCustomExportParams({ version: 'v6' }).version, 'v6');
  assert.strictEqual(parseCustomExportParams({ version: 'v9' }).version, 'all');
});

test('manual limit honored and capped at 5000', () => {
  assert.strictEqual(parseCustomExportParams({ limit: '750' }).limit, 750);
  assert.strictEqual(parseCustomExportParams({ limit: '99999' }).limit, 5000);
  assert.strictEqual(parseCustomExportParams({ limit: '0' }).limit, 200);   // invalid → default
  assert.strictEqual(parseCustomExportParams({ limit: 'abc' }).limit, 200); // invalid → default
});

console.log('\nrankSort:');

test('score ranking → score desc then hits', () => {
  assert.deepStrictEqual(rankSort('score'), { score: -1, hit_count: -1 });
});
test('frequency ranking → hits desc then score', () => {
  assert.deepStrictEqual(rankSort('frequency'), { hit_count: -1, score: -1 });
});

console.log('\nshapeCustomExportRows:');

const docs = [
  { cidr: '1.2.3.0/24',   score: 90, hit_count: 5000, ip_version: 'v4', asn_org: 'OVH',  country: 'FR' },
  { cidr: '2003:d8::/32', score: 80, hit_count: 900,  ip_version: 'v6', asn_org: 'DTAG', country: 'DE' },
  { cidr: '5.6.0.0/20',   score: 70, hit_count: 300,  ip_version: 'v4', asn_org: 'X',    country: 'US' }, // unsupported mask
  { cidr: '8.8.8.8/32',   score: 60, hit_count: 100,  ip_version: 'v4', asn_org: 'Y',    country: 'US' },
];

test('expands IPv6 :: in output', () => {
  const rows = shapeCustomExportRows(docs, 100);
  const v6 = rows.find(r => r.ip_version === 'v6');
  assert.strictEqual(v6.out, '2003:d8:0:0:0:0:0:0/32');
  assert.ok(!v6.out.includes('::'), 'no :: shorthand should remain');
});

test('drops Google-Ads-incompatible v4 mask (/20)', () => {
  const rows = shapeCustomExportRows(docs, 100);
  assert.ok(!rows.some(r => r.cidr === '5.6.0.0/20'), '/20 should be dropped');
  assert.ok(rows.some(r => r.out === '8.8.8.8/32'), '/32 should pass');
  assert.ok(rows.some(r => r.out === '1.2.3.0/24'), '/24 should pass');
});

test('preserves input (DB-ranked) order', () => {
  const rows = shapeCustomExportRows(docs, 100);
  assert.deepStrictEqual(rows.map(r => r.out), ['1.2.3.0/24', '2003:d8:0:0:0:0:0:0/32', '8.8.8.8/32']);
});

test('caps at the requested limit (after drops)', () => {
  const rows = shapeCustomExportRows(docs, 2);
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(rows.map(r => r.out), ['1.2.3.0/24', '2003:d8:0:0:0:0:0:0/32']);
});

test('empty / null input → empty array', () => {
  assert.deepStrictEqual(shapeCustomExportRows([], 100), []);
  assert.deepStrictEqual(shapeCustomExportRows(null, 100), []);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
