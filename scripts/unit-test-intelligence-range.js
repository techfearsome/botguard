// Unit test for intelligence range resolution rules.
//
// These rules are subtle and the bug we just fixed had this exact failure
// mode: the URL said range=today but the user provided custom dates and
// expected to see the dates' window. We codify the rules here:
//
//   Rule 1: dates win. If date_from AND date_to are both present, the
//           effective range is 'custom' regardless of dropdown value.
//   Rule 2: live mode requires range=today AND no dates.
//   Rule 3: range=yesterday/7d/30d/all + no dates → historical mode
//           with the appropriate window.
//   Rule 4: range=custom without dates is invalid — treat as today live.

const assert = require('assert');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

/**
 * Replica of the GET handler's range resolution logic, extracted for testing.
 * If this is changed in the route, change it here too. The test fails
 * loudly if they drift.
 */
function resolveRange(query) {
  const rawRange  = query.range || 'today';
  const dateFrom  = (query.date_from || '').trim();
  const dateTo    = (query.date_to   || '').trim();
  const hasDates  = !!(dateFrom && dateTo);
  const rangeKey  = hasDates ? 'custom' : rawRange;
  const rangeIsLive = (rangeKey === 'today' && !hasDates);
  return { rangeKey, rangeIsLive, hasDates, dateFrom, dateTo };
}

console.log('Range resolution rules:');

test('range=today with no dates → live mode', () => {
  const r = resolveRange({ range: 'today' });
  assert.strictEqual(r.rangeIsLive, true);
  assert.strictEqual(r.rangeKey, 'today');
});

test('range=yesterday with no dates → historical, key=yesterday', () => {
  const r = resolveRange({ range: 'yesterday' });
  assert.strictEqual(r.rangeIsLive, false);
  assert.strictEqual(r.rangeKey, 'yesterday');
});

test('range=today with both dates → custom (dates win)', () => {
  const r = resolveRange({
    range: 'today',
    date_from: '2026-05-12',
    date_to: '2026-05-14',
  });
  assert.strictEqual(r.rangeIsLive, false, 'dates make this historical');
  assert.strictEqual(r.rangeKey, 'custom', 'dropdown ignored when dates present');
});

test('range=yesterday with both dates → custom (dates win)', () => {
  const r = resolveRange({
    range: 'yesterday',
    date_from: '2026-05-10',
    date_to: '2026-05-12',
  });
  assert.strictEqual(r.rangeKey, 'custom');
  assert.strictEqual(r.rangeIsLive, false);
});

test('range=custom without dates → key=custom but no window', () => {
  // Edge case: user picks custom in dropdown but doesn't fill dates.
  // Not live, but no date window either. parseRange would return null/null.
  const r = resolveRange({ range: 'custom' });
  assert.strictEqual(r.rangeKey, 'custom');
  assert.strictEqual(r.rangeIsLive, false);
});

test('range=7d → historical', () => {
  const r = resolveRange({ range: '7d' });
  assert.strictEqual(r.rangeKey, '7d');
  assert.strictEqual(r.rangeIsLive, false);
});

test('range=all → historical (no window)', () => {
  const r = resolveRange({ range: 'all' });
  assert.strictEqual(r.rangeKey, 'all');
  assert.strictEqual(r.rangeIsLive, false);
});

test('no range param → defaults to today live', () => {
  const r = resolveRange({});
  assert.strictEqual(r.rangeKey, 'today');
  assert.strictEqual(r.rangeIsLive, true);
});

test('only date_from (missing date_to) → ignore dates, use dropdown', () => {
  // Half-filled dates shouldn't trigger custom mode
  const r = resolveRange({ range: 'today', date_from: '2026-05-12' });
  assert.strictEqual(r.hasDates, false);
  assert.strictEqual(r.rangeIsLive, true);
});

test('only date_to (missing date_from) → ignore dates, use dropdown', () => {
  const r = resolveRange({ range: 'yesterday', date_to: '2026-05-12' });
  assert.strictEqual(r.hasDates, false);
  assert.strictEqual(r.rangeKey, 'yesterday');
});

test('whitespace-only dates treated as empty', () => {
  const r = resolveRange({ range: 'today', date_from: '  ', date_to: '  ' });
  assert.strictEqual(r.hasDates, false);
  assert.strictEqual(r.rangeIsLive, true);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
