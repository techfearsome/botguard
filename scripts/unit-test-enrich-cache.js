// Unit tests for enrichCache: Redis-first, in-memory fallback.
// Tests both paths — Redis available and Redis unavailable.

process.env.SESSION_SECRET = 'test-secret-at-least-16-chars';

const assert = require('assert');
const path = require('path');

// Stub the redisClient module so we can control Redis availability.
const redisPath = path.resolve(__dirname, '../src/lib/redisClient');
let redisAvailable = false;
const redisStore = {};
require.cache[require.resolve(redisPath)] = {
  id: redisPath, filename: redisPath, loaded: true,
  exports: {
    getClient: () => redisAvailable ? { status: 'ready' } : null,
    get: async (key) => redisStore[key] || null,
    set: async (key, value, ttl) => { redisStore[key] = value; },
  },
};

const enrichCache = require(path.resolve(__dirname, '../src/lib/enrichCache'));

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

(async () => {
  console.log('enrichCache — Redis unavailable (memory-only fallback):');
  redisAvailable = false;
  enrichCache.clear();

  await test('set + get round-trip (memory)', async () => {
    await enrichCache.set('1.2.3.4', { is_proxy: true, risk_score: 90 });
    const result = await enrichCache.get('1.2.3.4');
    assert.ok(result);
    assert.strictEqual(result.is_proxy, true);
    assert.strictEqual(result.risk_score, 90);
  });

  await test('miss returns null', async () => {
    assert.strictEqual(await enrichCache.get('9.9.9.9'), null);
  });

  await test('clear wipes memory cache', async () => {
    enrichCache.clear();
    assert.strictEqual(await enrichCache.get('1.2.3.4'), null);
  });

  console.log('\nenrichCache — Redis available:');
  redisAvailable = true;
  enrichCache.clear();
  for (const k of Object.keys(redisStore)) delete redisStore[k];

  await test('set writes to Redis + memory', async () => {
    await enrichCache.set('5.6.7.8', { country: 'US', risk_score: 0 });
    // Redis store should have it
    assert.ok(redisStore['enrich:5.6.7.8']);
    const parsed = JSON.parse(redisStore['enrich:5.6.7.8']);
    assert.strictEqual(parsed.country, 'US');
    // Memory should also have it
    const result = await enrichCache.get('5.6.7.8');
    assert.strictEqual(result.country, 'US');
  });

  await test('get reads from Redis (simulating cross-process)', async () => {
    // Clear memory but leave Redis
    enrichCache.clear();
    const result = await enrichCache.get('5.6.7.8');
    assert.ok(result, 'should find it in Redis even after memory clear');
    assert.strictEqual(result.country, 'US');
  });

  await test('Redis down → falls back to memory seamlessly', async () => {
    // First, cache something while Redis is up
    await enrichCache.set('10.0.0.1', { asn: 12345 });
    // Now Redis goes down
    redisAvailable = false;
    // Memory should still have it
    const result = await enrichCache.get('10.0.0.1');
    assert.ok(result);
    assert.strictEqual(result.asn, 12345);
  });

  await test('isRedisReady reflects state', () => {
    redisAvailable = true;
    assert.strictEqual(enrichCache.isRedisReady(), true);
    redisAvailable = false;
    assert.ok(!enrichCache.isRedisReady(), 'should be falsy when Redis is down');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
