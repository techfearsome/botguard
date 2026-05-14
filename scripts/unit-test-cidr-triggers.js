// Unit tests for cidrTriggers.js
//
// Verifies the four detection triggers fire correctly and don't false-positive
// on legitimate-looking traffic patterns. The thresholds are tuned based on
// real traffic analysis - changes here should be backed by data, not intuition.

const assert = require('assert');
const path = require('path');
const {
  detectTriggers,
  BURST_THRESHOLD,
  VOLUME_THRESHOLD,
  HAMMER_THRESHOLD,
  RAPID_DUPLICATE_WINDOW_MS,
  BURST_WINDOW_MS,
} = require(path.resolve(__dirname, '../src/lib/cidrTriggers'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

function makeClick(secondsAgo, ip = '1.2.3.4') {
  return { ts: new Date(Date.now() - secondsAgo * 1000), ip };
}

console.log('Empty inputs:');

test('Empty array does not qualify', () => {
  const r = detectTriggers([]);
  assert.strictEqual(r.qualifies, false);
  assert.deepStrictEqual(r.triggers, []);
  assert.strictEqual(r.metrics.hits, 0);
});

test('Null input does not qualify', () => {
  const r = detectTriggers(null);
  assert.strictEqual(r.qualifies, false);
});

test('Single click does not qualify (the critical false-positive case)', () => {
  const r = detectTriggers([makeClick(0, '1.2.3.4')]);
  assert.strictEqual(r.qualifies, false);
  assert.deepStrictEqual(r.triggers, []);
});

console.log('\nVolume trigger:');

test('4 hits across the day does NOT trigger volume (threshold is 5)', () => {
  const clicks = [
    makeClick(36000), makeClick(28000), makeClick(20000), makeClick(10000),
  ];
  const r = detectTriggers(clicks);
  assert.ok(!r.triggers.includes('volume'));
});

test('5 hits spread over many hours triggers volume', () => {
  const clicks = [];
  for (let i = 0; i < 5; i++) {
    clicks.push(makeClick(i * 7200, `1.2.3.${i + 10}`));
  }
  const r = detectTriggers(clicks);
  assert.ok(r.qualifies);
  assert.ok(r.triggers.includes('volume'));
  assert.ok(!r.triggers.includes('burst'));
});

console.log('\nBurst trigger (3+ in 5 minutes):');

test('3 hits within 5 minutes triggers burst', () => {
  const clicks = [
    makeClick(0, '1.2.3.1'),
    makeClick(120, '1.2.3.2'),
    makeClick(60, '1.2.3.3'),
  ];
  const r = detectTriggers(clicks);
  assert.ok(r.triggers.includes('burst'));
  assert.strictEqual(r.metrics.max_burst_5min, 3);
});

test('3 hits spread over 10 minutes does NOT trigger burst', () => {
  const clicks = [
    makeClick(0, '1.2.3.1'),
    makeClick(300, '1.2.3.2'),
    makeClick(600, '1.2.3.3'),
  ];
  const r = detectTriggers(clicks);
  assert.ok(!r.triggers.includes('burst'));
});

test('Burst metric reflects the densest window', () => {
  const clicks = [
    makeClick(0, '1.2.3.1'),
    makeClick(10, '1.2.3.2'),
    makeClick(20, '1.2.3.3'),
    makeClick(30, '1.2.3.4'),
    makeClick(40, '1.2.3.5'),
    makeClick(3600, '1.2.3.6'),
    makeClick(3700, '1.2.3.7'),
  ];
  const r = detectTriggers(clicks);
  assert.ok(r.metrics.max_burst_5min >= 5);
});

console.log('\nHammer trigger (single IP hits 3+ times):');

test('Same IP 3 times triggers hammer', () => {
  const clicks = [
    makeClick(10000, '1.2.3.4'),
    makeClick(5000, '1.2.3.4'),
    makeClick(1000, '1.2.3.4'),
  ];
  const r = detectTriggers(clicks);
  assert.ok(r.triggers.includes('hammer'));
  assert.strictEqual(r.metrics.single_ip_hammer_count, 1);
});

test('Same IP twice does NOT trigger hammer', () => {
  const clicks = [
    makeClick(10000, '1.2.3.4'),
    makeClick(1000, '1.2.3.4'),
  ];
  const r = detectTriggers(clicks);
  assert.ok(!r.triggers.includes('hammer'));
});

test('Multiple hammering IPs each get counted', () => {
  const clicks = [
    makeClick(10000, '1.1.1.1'), makeClick(5000, '1.1.1.1'), makeClick(1000, '1.1.1.1'),
    makeClick(9000, '2.2.2.2'),  makeClick(4000, '2.2.2.2'), makeClick(500,  '2.2.2.2'),
  ];
  const r = detectTriggers(clicks);
  assert.strictEqual(r.metrics.single_ip_hammer_count, 2);
});

console.log('\nRapid duplicate trigger (same IP within 60s):');

test('Same IP within 30 seconds triggers rapid_duplicate', () => {
  const now = Date.now();
  const clicks = [
    { ts: new Date(now - 60000), ip: '1.2.3.4' },
    { ts: new Date(now - 30000), ip: '1.2.3.4' },
  ];
  const r = detectTriggers(clicks);
  assert.ok(r.triggers.includes('rapid_duplicate'));
  assert.strictEqual(r.metrics.rapid_duplicate_count, 1);
});

test('Same IP exactly 60s apart does NOT trigger (strictly less than)', () => {
  const now = Date.now();
  const clicks = [
    { ts: new Date(now - 60000), ip: '1.2.3.4' },
    { ts: new Date(now), ip: '1.2.3.4' },
  ];
  const r = detectTriggers(clicks);
  assert.ok(!r.triggers.includes('rapid_duplicate'));
});

test('Same IP 5 seconds apart records the pair for downstream auto-block', () => {
  const now = Date.now();
  const clicks = [
    { ts: new Date(now - 5000), ip: '1.2.3.4' },
    { ts: new Date(now), ip: '1.2.3.4' },
  ];
  const r = detectTriggers(clicks);
  assert.strictEqual(r.metrics.rapid_duplicate_pairs.length, 1);
  assert.strictEqual(r.metrics.rapid_duplicate_pairs[0].ip, '1.2.3.4');
  assert.strictEqual(r.metrics.rapid_duplicate_pairs[0].gapMs, 5000);
});

test('Two different IPs within 60s does NOT trigger rapid_duplicate', () => {
  const now = Date.now();
  const clicks = [
    { ts: new Date(now - 30000), ip: '1.1.1.1' },
    { ts: new Date(now), ip: '2.2.2.2' },
  ];
  const r = detectTriggers(clicks);
  assert.ok(!r.triggers.includes('rapid_duplicate'));
});

console.log('\nMulti-trigger combinations:');

test('Burst pattern fires both burst AND volume', () => {
  const clicks = [];
  for (let i = 0; i < 6; i++) {
    clicks.push(makeClick(i * 30, `1.2.3.${i + 1}`));
  }
  const r = detectTriggers(clicks);
  assert.ok(r.triggers.includes('burst'));
  assert.ok(r.triggers.includes('volume'));
  assert.ok(!r.triggers.includes('rapid_duplicate'));
});

test('Single IP automation fires hammer, rapid_duplicate, volume, and burst', () => {
  const clicks = [];
  for (let i = 0; i < 5; i++) {
    clicks.push(makeClick(i * 10, '1.2.3.99'));
  }
  const r = detectTriggers(clicks);
  assert.ok(r.triggers.includes('hammer'));
  assert.ok(r.triggers.includes('rapid_duplicate'));
  assert.ok(r.triggers.includes('volume'));
  assert.ok(r.triggers.includes('burst'));
});

console.log('\nReal-world calibration:');

test('Single human-like click pattern does not qualify (canonical FP test)', () => {
  const r = detectTriggers([makeClick(3600, '5.5.5.5')]);
  assert.strictEqual(r.qualifies, false);
});

test('Two clicks 10 minutes apart from one user does not qualify', () => {
  const clicks = [
    makeClick(1200, '5.5.5.5'),
    makeClick(600, '5.5.5.5'),
  ];
  const r = detectTriggers(clicks);
  assert.strictEqual(r.qualifies, false);
});

test('Bot 5x burst from same IP definitely qualifies (canonical TP test)', () => {
  const clicks = [];
  for (let i = 0; i < 5; i++) {
    clicks.push(makeClick(i * 5, '6.6.6.6'));
  }
  const r = detectTriggers(clicks);
  assert.strictEqual(r.qualifies, true);
  assert.strictEqual(r.triggers.length, 4);
});

console.log('\nThresholds match constants:');

test('Constants are at expected values for documentation', () => {
  assert.strictEqual(BURST_THRESHOLD, 3);
  assert.strictEqual(BURST_WINDOW_MS, 5 * 60 * 1000);
  assert.strictEqual(VOLUME_THRESHOLD, 5);
  assert.strictEqual(HAMMER_THRESHOLD, 3);
  assert.strictEqual(RAPID_DUPLICATE_WINDOW_MS, 60 * 1000);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
