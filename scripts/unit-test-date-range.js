// Unit tests for the date-range parser used across admin list pages.

const assert = require('assert');
const path = require('path');
const {
  parseRange,
  applyRangeToFilter,
  RANGE_OPTIONS,
  DEFAULT_RANGE,
  VALID_RANGES,
} = require(path.join(__dirname, '../src/lib/dateRange'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

console.log('dateRange:');

test('Default range is "today" when query is empty', () => {
  const r = parseRange({});
  assert.strictEqual(r.range, 'today');
  assert.strictEqual(r.label, 'Today');
  assert.ok(r.gte instanceof Date);
  assert.strictEqual(r.lte, null);
});

test('Default range is "today" when range param is unrecognized', () => {
  const r = parseRange({ range: 'last_century' });
  assert.strictEqual(r.range, 'today');
});

test('Default range is "today" when range param is undefined', () => {
  const r = parseRange();
  assert.strictEqual(r.range, 'today');
});

test('"today" range gte = midnight server-local', () => {
  const r = parseRange({ range: 'today' });
  assert.strictEqual(r.gte.getHours(), 0);
  assert.strictEqual(r.gte.getMinutes(), 0);
  assert.strictEqual(r.gte.getSeconds(), 0);
  assert.strictEqual(r.gte.getMilliseconds(), 0);
  // Should be today's date
  const now = new Date();
  assert.strictEqual(r.gte.getDate(), now.getDate());
});

test('"yesterday" range covers full previous day', () => {
  const r = parseRange({ range: 'yesterday' });
  assert.strictEqual(r.range, 'yesterday');
  assert.ok(r.gte && r.lte);
  // gte should be 24h before lte's midnight... let's just verify they're 1 day apart
  const dayMs = 24 * 60 * 60 * 1000;
  const diff = r.lte.getTime() - r.gte.getTime();
  // Should be one day minus 1 ms (00:00:00.000 to 23:59:59.999)
  assert.ok(Math.abs(diff - (dayMs - 1)) < 1000, `expected ~1 day diff, got ${diff}ms`);
});

test('"7d" range gte is ~7 days ago', () => {
  const r = parseRange({ range: '7d' });
  const ageMs = Date.now() - r.gte.getTime();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  assert.ok(Math.abs(ageMs - sevenDaysMs) < 5000, `expected ~7 days ago`);
  assert.strictEqual(r.lte, null);
});

test('"30d" range gte is ~30 days ago', () => {
  const r = parseRange({ range: '30d' });
  const ageMs = Date.now() - r.gte.getTime();
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  assert.ok(Math.abs(ageMs - thirtyDaysMs) < 5000);
});

test('"all" range has no time bounds', () => {
  const r = parseRange({ range: 'all' });
  assert.strictEqual(r.gte, null);
  assert.strictEqual(r.lte, null);
  assert.strictEqual(r.label, 'All time');
});

test('"custom" range parses YYYY-MM-DD date_from and date_to', () => {
  const r = parseRange({ range: 'custom', date_from: '2026-04-15', date_to: '2026-04-20' });
  assert.strictEqual(r.range, 'custom');
  assert.strictEqual(r.gte.getFullYear(), 2026);
  assert.strictEqual(r.gte.getMonth(), 3);   // April = 3
  assert.strictEqual(r.gte.getDate(), 15);
  assert.strictEqual(r.lte.getFullYear(), 2026);
  assert.strictEqual(r.lte.getDate(), 20);
  // date_to should be end-of-day inclusive
  assert.strictEqual(r.lte.getHours(), 23);
  assert.strictEqual(r.lte.getMinutes(), 59);
});

test('"custom" range with only date_from', () => {
  const r = parseRange({ range: 'custom', date_from: '2026-04-15' });
  assert.ok(r.gte);
  assert.strictEqual(r.lte, null);
});

test('"custom" range with malformed date is treated as null bound', () => {
  const r = parseRange({ range: 'custom', date_from: 'not-a-date', date_to: '2026/04/20' });
  assert.strictEqual(r.gte, null);
  assert.strictEqual(r.lte, null);
});

test('applyRangeToFilter sets ts.$gte when gte is set', () => {
  const filter = { workspace_id: 'ws1' };
  const range = parseRange({ range: 'today' });
  applyRangeToFilter(filter, range);
  assert.ok(filter.ts);
  assert.ok(filter.ts.$gte instanceof Date);
});

test('applyRangeToFilter does NOT set ts when range is "all"', () => {
  const filter = { workspace_id: 'ws1' };
  const range = parseRange({ range: 'all' });
  applyRangeToFilter(filter, range);
  assert.strictEqual(filter.ts, undefined);
});

test('applyRangeToFilter sets both $gte and $lte for yesterday', () => {
  const filter = {};
  applyRangeToFilter(filter, parseRange({ range: 'yesterday' }));
  assert.ok(filter.ts.$gte && filter.ts.$lte);
});

test('applyRangeToFilter preserves existing filter properties', () => {
  const filter = { workspace_id: 'ws1', decision: 'allow' };
  applyRangeToFilter(filter, parseRange({ range: 'today' }));
  assert.strictEqual(filter.workspace_id, 'ws1');
  assert.strictEqual(filter.decision, 'allow');
});

test('RANGE_OPTIONS includes the expected entries in order', () => {
  const values = RANGE_OPTIONS.map(o => o.value);
  assert.deepStrictEqual(values, ['today', 'yesterday', '7d', '30d', 'all', 'custom']);
});

test('VALID_RANGES contains all option values', () => {
  for (const opt of RANGE_OPTIONS) {
    assert.ok(VALID_RANGES.has(opt.value), `missing ${opt.value}`);
  }
});

test('DEFAULT_RANGE is "today"', () => {
  assert.strictEqual(DEFAULT_RANGE, 'today');
});

test('Empty/null query is handled gracefully', () => {
  const r1 = parseRange(null);
  const r2 = parseRange(undefined);
  assert.strictEqual(r1.range, 'today');
  assert.strictEqual(r2.range, 'today');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
