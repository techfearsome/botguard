// Unit tests for Fix 2: enrichment timeout with fail-open.
// Proves that:
//   1. Fast lookups return normally (timeout doesn't interfere).
//   2. Slow lookups trip the timeout → null (fail-open, not hang).
//   3. Timeout=0 disables the budget (previous behavior).
//   4. Env-configurable budget is respected.

process.env.SESSION_SECRET = 'test-secret-at-least-16-chars';

const assert = require('assert');
const path = require('path');

// Stub both providers so we control their latency.
const pcPath = require.resolve(path.resolve(__dirname, '../src/lib/proxycheck'));
const ilPath = require.resolve(path.resolve(__dirname, '../src/lib/iplocate'));
const enrichCachePath = require.resolve(path.resolve(__dirname, '../src/lib/enrichCache'));
const redisPath = require.resolve(path.resolve(__dirname, '../src/lib/redisClient'));

// Stub redis (not needed for this test)
require.cache[require.resolve(redisPath)] = {
  id: redisPath, filename: redisPath, loaded: true,
  exports: { getClient: () => null, get: async () => null, set: async () => {} },
};

let pcDelay = 0, pcReturn = null;
let ilDelay = 0, ilReturn = null;
require.cache[pcPath] = {
  id: pcPath, filename: pcPath, loaded: true,
  exports: {
    lookup: async (ip) => { await sleep(pcDelay); return pcReturn; },
    clearCache: () => {},
    normalize: () => ({}),
  },
};
require.cache[ilPath] = {
  id: ilPath, filename: ilPath, loaded: true,
  exports: {
    lookup: async (ip) => { await sleep(ilDelay); return ilReturn; },
    clearCache: () => {},
    normalize: () => ({}),
  },
};

// Clear ipEnrich from cache so it picks up our stubs.
const ipEnrichPath = require.resolve(path.resolve(__dirname, '../src/lib/ipEnrich'));
delete require.cache[ipEnrichPath];
const ipEnrich = require(ipEnrichPath);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

(async () => {
  console.log('Enrichment timeout (fail-open):');

  await test('fast lookup returns normally (timeout does not interfere)', async () => {
    process.env.ENRICH_TIMEOUT_MS = '2000';
    pcDelay = 10; pcReturn = { source: 'proxycheck', is_proxy: false };
    ilDelay = 0; ilReturn = null;
    const r = await ipEnrich.lookup('1.2.3.4');
    assert.ok(r, 'should return enrichment');
    assert.strictEqual(r.source, 'proxycheck');
  });

  await test('slow lookup trips timeout → null (fail-open)', async () => {
    process.env.ENRICH_TIMEOUT_MS = '100'; // 100ms budget
    pcDelay = 500; pcReturn = { source: 'proxycheck' }; // takes 500ms, over budget
    ilDelay = 0; ilReturn = null;
    const start = Date.now();
    const r = await ipEnrich.lookup('1.2.3.4');
    const elapsed = Date.now() - start;
    assert.strictEqual(r, null, 'should return null on timeout (fail-open)');
    assert.ok(elapsed < 300, `should resolve near the budget, not wait for full provider (took ${elapsed}ms)`);
  });

  await test('slow primary + slow fallback → timeout covers both combined', async () => {
    process.env.ENRICH_TIMEOUT_MS = '150';
    process.env.IPLOCATE_FALLBACK_ENABLED = 'true';
    process.env.IPLOCATE_API_KEY = 'k';
    pcDelay = 100; pcReturn = null; // primary slow + fails → triggers fallback
    ilDelay = 100; ilReturn = { source: 'iplocate' }; // fallback also slow
    // Total: 200ms, budget 150ms → should timeout.
    const r = await ipEnrich.lookup('1.2.3.4');
    assert.strictEqual(r, null, 'combined latency exceeds budget → null');
  });

  await test('timeout=0 disables the budget (waits indefinitely)', async () => {
    process.env.ENRICH_TIMEOUT_MS = '0';
    pcDelay = 100; pcReturn = { source: 'proxycheck', risk: 50 };
    ilDelay = 0; ilReturn = null;
    const r = await ipEnrich.lookup('1.2.3.4');
    assert.ok(r, 'with timeout=0, should wait for the full provider response');
    assert.strictEqual(r.source, 'proxycheck');
  });

  await test('env-configurable budget is respected', async () => {
    process.env.ENRICH_TIMEOUT_MS = '50';
    pcDelay = 200; pcReturn = { source: 'proxycheck' };
    const start = Date.now();
    const r = await ipEnrich.lookup('1.2.3.4');
    const elapsed = Date.now() - start;
    assert.strictEqual(r, null);
    assert.ok(elapsed < 150, `50ms budget should cut off well before 200ms (took ${elapsed}ms)`);
  });

  await test('no ip → null immediately (no timeout needed)', async () => {
    const r = await ipEnrich.lookup('');
    assert.strictEqual(r, null);
  });

  // Clean up
  delete process.env.ENRICH_TIMEOUT_MS;
  delete process.env.IPLOCATE_FALLBACK_ENABLED;
  delete process.env.IPLOCATE_API_KEY;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
