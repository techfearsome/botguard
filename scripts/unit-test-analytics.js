// Unit tests for the analytics date-range presets and filter construction.

process.env.SESSION_SECRET = 'test-secret-at-least-16-chars';

const assert = require('assert');
const path = require('path');
const a = require(path.resolve(__dirname, '../src/routes/admin/analytics'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

const iso = (d) => (d ? d.toISOString().slice(0, 10) : null);

console.log('computeRange presets:');

test('today is a single day [start, start+1)', () => {
  const { start, end } = a.computeRange('today', {});
  assert.ok(start && end);
  assert.strictEqual(Math.round((end - start) / 86400000), 1);
});
test('yesterday ends where today starts', () => {
  const y = a.computeRange('yesterday', {});
  const t = a.computeRange('today', {});
  assert.strictEqual(iso(y.end), iso(t.start));
});
test('this_week is 7 days, Monday start', () => {
  const { start, end } = a.computeRange('this_week', {});
  assert.strictEqual(Math.round((end - start) / 86400000), 7);
  assert.strictEqual(start.getDay(), 1); // Monday
});
test('last_week precedes this_week and is 7 days', () => {
  const lw = a.computeRange('last_week', {});
  const tw = a.computeRange('this_week', {});
  assert.strictEqual(iso(lw.end), iso(tw.start));
  assert.strictEqual(Math.round((lw.end - lw.start) / 86400000), 7);
});
test('this_month starts on the 1st', () => {
  const { start } = a.computeRange('this_month', {});
  assert.strictEqual(start.getDate(), 1);
});
test('last_month ends where this_month starts', () => {
  const lm = a.computeRange('last_month', {});
  const tm = a.computeRange('this_month', {});
  assert.strictEqual(iso(lm.end), iso(tm.start));
  assert.strictEqual(lm.start.getDate(), 1);
});
test('last_7 spans 7 days inclusive of today', () => {
  const { start, end } = a.computeRange('last_7', {});
  assert.strictEqual(Math.round((end - start) / 86400000), 7);
});
test('all → no bounds', () => {
  const { start, end } = a.computeRange('all', {});
  assert.strictEqual(start, null);
  assert.strictEqual(end, null);
});
test('custom range uses inclusive end (date_to + 1 day)', () => {
  const { start, end } = a.computeRange('custom', { date_from: '2026-08-01', date_to: '2026-08-05' });
  assert.strictEqual(iso(start), '2026-08-01');
  assert.strictEqual(iso(end), '2026-08-06'); // exclusive upper bound
});

console.log('\nbuildFilter:');

const ws = { _id: 'ws1' };

test('applies workspace + date + campaign + source + medium', () => {
  const { filter, preset } = a.buildFilter(ws, { range: 'today', campaign: 'c1', source: 'google', medium: 'cpc' });
  assert.strictEqual(filter.workspace_id, 'ws1');
  assert.ok(filter.ts && filter.ts.$gte && filter.ts.$lt);
  assert.strictEqual(filter.campaign_id, 'c1');
  assert.strictEqual(filter['utm.source'], 'google');
  assert.strictEqual(filter['utm.medium'], 'cpc');
  assert.strictEqual(preset, 'today');
});
test('all-time → no ts filter', () => {
  const { filter } = a.buildFilter(ws, { range: 'all' });
  assert.ok(!filter.ts);
});
test('invalid range falls back to last_7', () => {
  const { preset } = a.buildFilter(ws, { range: 'bogus' });
  assert.strictEqual(preset, 'last_7');
});
test('empty filters are omitted', () => {
  const { filter } = a.buildFilter(ws, { range: 'all' });
  assert.ok(!('campaign_id' in filter));
  assert.ok(!('utm.source' in filter));
});

console.log('\ndimensions:');
test('all expected dimensions present', () => {
  ['placement', 'vt_campaign', 'adgroup', 'creative', 'network', 'vt_device', 'utm_source', 'utm_medium', 'country', 'campaign'].forEach((k) => {
    assert.ok(a.DIMENSIONS[k], `missing dimension ${k}`);
  });
  assert.strictEqual(a.DIMENSIONS.placement.path, 'valuetrack.google.placement');
  assert.strictEqual(a.DIMENSIONS.placement.app, true);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
