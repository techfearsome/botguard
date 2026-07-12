// Unit tests for syncMatch.js — the decision brain that governs whether
// imported partner data is implemented, staged, or ignored. This is the
// security-critical logic (remote data → your firewall), so it's tested hard.

const assert = require('assert');
const path = require('path');
const { classifyMatch, decideEntryFate, batchMatchRatio } =
  require(path.resolve(__dirname, '../src/lib/syncMatch'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

const entry = { kind: 'cidr', value: '1.2.3.0/24' };

console.log('classifyMatch:');

test('unknown locally → new', () => {
  const m = classifyMatch(entry, { known: false, active: false });
  assert.strictEqual(m.match_status, 'new');
  assert.strictEqual(m.local_score, 0);
});
test('known but not active → match, carries local evidence', () => {
  const m = classifyMatch(entry, { known: true, active: false, score: 82, hits: 400 });
  assert.strictEqual(m.match_status, 'match');
  assert.strictEqual(m.local_score, 82);
  assert.strictEqual(m.local_hits, 400);
});
test('already active → duplicate', () => {
  const m = classifyMatch(entry, { known: true, active: true, score: 90, hits: 10 });
  assert.strictEqual(m.match_status, 'duplicate');
});

console.log('\ndecideEntryFate — disposition gates:');

test('duplicate is always ignored (never re-added)', () => {
  const p = { disposition: 'implement', promotion_mode: 'full' };
  assert.strictEqual(decideEntryFate(p, { match_status: 'duplicate' }), 'ignore');
});
test('monitor never implements, even on a strong match', () => {
  const p = { disposition: 'monitor', promotion_mode: 'full' };
  assert.strictEqual(decideEntryFate(p, { match_status: 'match', local_score: 99, local_hits: 999 }), 'stage');
});
test('quarantine never implements', () => {
  const p = { disposition: 'quarantine', promotion_mode: 'full' };
  assert.strictEqual(decideEntryFate(p, { match_status: 'match', local_score: 99, local_hits: 999 }), 'stage');
});

console.log('\ndecideEntryFate — promotion modes (disposition=implement):');

test('full trust implements a brand-new entry', () => {
  const p = { disposition: 'implement', promotion_mode: 'full' };
  assert.strictEqual(decideEntryFate(p, { match_status: 'new' }), 'implement');
});

test('corroboration: new entry stays staged (never seen it)', () => {
  const p = { disposition: 'implement', promotion_mode: 'corroboration', thresholds: { min_local_score: 60, min_local_hits: 5 } };
  assert.strictEqual(decideEntryFate(p, { match_status: 'new', local_score: 0, local_hits: 0 }), 'stage');
});
test('corroboration: match above thresholds → implement', () => {
  const p = { disposition: 'implement', promotion_mode: 'corroboration', thresholds: { min_local_score: 60, min_local_hits: 5 } };
  assert.strictEqual(decideEntryFate(p, { match_status: 'match', local_score: 70, local_hits: 20 }), 'implement');
});
test('corroboration: match below score threshold → stage', () => {
  const p = { disposition: 'implement', promotion_mode: 'corroboration', thresholds: { min_local_score: 60, min_local_hits: 5 } };
  assert.strictEqual(decideEntryFate(p, { match_status: 'match', local_score: 40, local_hits: 20 }), 'stage');
});
test('corroboration: match below hits threshold → stage', () => {
  const p = { disposition: 'implement', promotion_mode: 'corroboration', thresholds: { min_local_score: 60, min_local_hits: 50 } };
  assert.strictEqual(decideEntryFate(p, { match_status: 'match', local_score: 90, local_hits: 10 }), 'stage');
});

test('percentage: batch trusted → implement each non-duplicate', () => {
  const p = { disposition: 'implement', promotion_mode: 'percentage', thresholds: { match_percentage: 50 } };
  assert.strictEqual(decideEntryFate(p, { match_status: 'new' }, { batchTrusted: true }), 'implement');
  assert.strictEqual(decideEntryFate(p, { match_status: 'match', local_score: 10 }, { batchTrusted: true }), 'implement');
});
test('percentage: batch NOT trusted → stage all', () => {
  const p = { disposition: 'implement', promotion_mode: 'percentage', thresholds: { match_percentage: 50 } };
  assert.strictEqual(decideEntryFate(p, { match_status: 'match', local_score: 99 }, { batchTrusted: false }), 'stage');
});

console.log('\nbatchMatchRatio:');

test('ratio counts match + duplicate as "seen"', () => {
  const classified = [
    { match_status: 'match' }, { match_status: 'duplicate' },
    { match_status: 'new' }, { match_status: 'new' },
  ];
  const r = batchMatchRatio(classified, 50);
  assert.strictEqual(r.matched, 2);
  assert.strictEqual(r.total, 4);
  assert.strictEqual(r.ratio, 50);
  assert.strictEqual(r.trusted, true); // 50 >= 50
});
test('below threshold → not trusted', () => {
  const classified = [{ match_status: 'match' }, { match_status: 'new' }, { match_status: 'new' }, { match_status: 'new' }];
  const r = batchMatchRatio(classified, 50);
  assert.strictEqual(r.trusted, false); // 25% < 50%
});
test('empty batch → not trusted, no divide-by-zero', () => {
  const r = batchMatchRatio([], 50);
  assert.strictEqual(r.trusted, false);
  assert.strictEqual(r.ratio, 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
