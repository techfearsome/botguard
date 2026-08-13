// Unit test for cluster worker-count selection logic.
// Tests env override, auto-detection with cap, single-process mode, and
// invalid-value fallback.

const assert = require('assert');
const os = require('os');

// Extract the logic (mirrors getWorkerCount in server.js without requiring
// the full server, which would try to connect Mongo + listen).
function getWorkerCount(envVal) {
  const env = parseInt(envVal, 10);
  if (Number.isFinite(env) && env >= 1) return env;
  return Math.min(os.cpus().length, 4);
}

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

const cores = os.cpus().length;
console.log(`Cluster worker-count (this box has ${cores} core(s)):`);

test('env override takes precedence', () => {
  assert.strictEqual(getWorkerCount('2'), 2);
  assert.strictEqual(getWorkerCount('6'), 6);
});

test('CLUSTER_WORKERS=1 → single-process mode', () => {
  assert.strictEqual(getWorkerCount('1'), 1);
});

test('no env → auto-detect capped at 4', () => {
  const result = getWorkerCount(undefined);
  assert.strictEqual(result, Math.min(cores, 4));
  assert.ok(result >= 1 && result <= 4);
});

test('invalid values fall back to auto', () => {
  assert.strictEqual(getWorkerCount('abc'), Math.min(cores, 4));
  assert.strictEqual(getWorkerCount(''), Math.min(cores, 4));
  assert.strictEqual(getWorkerCount('0'), Math.min(cores, 4)); // 0 isn't >= 1
  assert.strictEqual(getWorkerCount('-2'), Math.min(cores, 4));
});

test('auto is always >= 1', () => {
  assert.ok(getWorkerCount(undefined) >= 1);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
