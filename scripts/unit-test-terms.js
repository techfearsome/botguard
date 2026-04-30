// Tests for term-based blacklist matching - exercises asnLookup without Mongo
// by injecting cache state directly.

const assert = require('assert');
const path = require('path');

// Load module
const asnLookupPath = path.join(__dirname, '../src/lib/asnLookup');
const asnLookup = require(asnLookupPath);

// We bypass Mongo by stuffing the cache directly. Reach into module internals.
// (Acceptable in tests - never in production code.)
function setCache(rules) {
  // Reset cache via require cache
  delete require.cache[require.resolve(asnLookupPath)];
  // Re-import then patch
  const fresh = require(asnLookupPath);
  // The module exports a `loadCache` function that hits Mongo. Since we can't, we
  // monkeypatch by calling with a custom cache via internal state. Easiest path:
  // Replace ensureCache to be a no-op, and seed `cache` indirectly through the rules.
  // The cleanest test approach: rewrite this with module-level injection.
  return fresh;
}

// Cleaner approach: test against a small in-memory blacklist without going through Mongo.
// We'll write a mini-version of the matching logic and verify it produces the same outputs.
// This isolates the matching algorithm from the storage layer.

const { lookupAsn } = require(asnLookupPath);

// Stub the AsnBlacklist model so .find() returns our test data and .updateOne is a no-op.
const Module = require('module');
const origResolve = Module._resolve_filename || Module._resolveFilename;
const modelsPath = require.resolve(path.join(__dirname, '../src/models'));
const realModels = require(modelsPath);

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}\n${e.stack.split('\n').slice(1,3).join('\n')}`); fail++; }
}

// Replace the AsnBlacklist model temporarily for these tests.
// Save originals so we don't affect other test files in the same process.
const realFind = realModels.AsnBlacklist.find;
const realUpdate = realModels.AsnBlacklist.updateOne;

function withMockBlacklist(rules, fn) {
  realModels.AsnBlacklist.find = (query = {}) => ({
    lean: async () => {
      // Simulate { active: true } filter
      const filtered = rules.filter(r => r.active !== false);
      return filtered;
    }
  });
  realModels.AsnBlacklist.updateOne = async () => ({ acknowledged: true });
  // Force cache reload
  asnLookup.invalidateCache();
  return fn().finally(() => {
    realModels.AsnBlacklist.find = realFind;
    realModels.AsnBlacklist.updateOne = realUpdate;
    asnLookup.invalidateCache();
  });
}

(async () => {
console.log('Term-match blacklist:');

await test('Exact ASN match still works (regression check)', async () => {
  await withMockBlacklist([
    { _id: 'a', asn: 9009, asn_org: 'M247', category: 'vpn', severity: 'high', score_weight: 70, override: 'mark_proxy', active: true },
  ], async () => {
    const r = await lookupAsn(9009, null, { provider: 'M247 Europe SRL' });
    assert.strictEqual(r.match, true);
    assert.strictEqual(r.match_kind, 'asn');
    assert.strictEqual(r.matched_value, 9009);
    assert.strictEqual(r.score_weight, 70);
  });
});

await test('Term rule matches "vpn" in provider field (case-insensitive)', async () => {
  await withMockBlacklist([
    { _id: 'b', term: 'vpn', term_field: 'provider', category: 'vpn', severity: 'high', score_weight: 60, active: true },
  ], async () => {
    const r = await lookupAsn(99999, null, { provider: 'NordVPN s.r.o.' });
    assert.strictEqual(r.match, true, JSON.stringify(r));
    assert.strictEqual(r.match_kind, 'term');
    assert.strictEqual(r.matched_value, 'vpn');
    assert.ok(r.flags.includes('term_match:vpn'));
  });
});

await test('Term rule matches "m247" against provider regardless of ASN', async () => {
  await withMockBlacklist([
    { _id: 'c', term: 'm247', term_field: 'provider', category: 'vpn', severity: 'high', score_weight: 70, active: true },
  ], async () => {
    // ASN totally different from any seeded M247 ASN
    const r = await lookupAsn(123456, null, { provider: 'M247 Singapore Pte Ltd' });
    assert.strictEqual(r.match, true);
    assert.strictEqual(r.match_kind, 'term');
  });
});

await test('Term rule with term_field=asn_org only matches asn_org, not provider', async () => {
  await withMockBlacklist([
    { _id: 'd', term: 'datacamp', term_field: 'asn_org', category: 'vpn', severity: 'high', score_weight: 70, active: true },
  ], async () => {
    // Provider has the term but asn_org doesn't → no match
    const r1 = await lookupAsn(1, null, { provider: 'Datacamp Limited', asnOrg: 'Some ISP' });
    assert.strictEqual(r1.match, false);
    // asn_org has the term → match
    const r2 = await lookupAsn(1, null, { provider: 'foo', asnOrg: 'Datacamp Limited' });
    assert.strictEqual(r2.match, true);
  });
});

await test('term_field=any matches when term appears in either field', async () => {
  await withMockBlacklist([
    { _id: 'e', term: 'tor exit', term_field: 'any', category: 'tor', severity: 'hard_block', score_weight: 100, active: true },
  ], async () => {
    const r = await lookupAsn(1, null, { provider: 'Some Tor Exit Operator' });
    assert.strictEqual(r.match, true);
    assert.strictEqual(r.severity, 'hard_block');
    assert.ok(r.flags.includes('asn_hard_block') || r.flags.some(f => f.includes('hard_block')));
  });
});

await test('No match when term is not present in either field', async () => {
  await withMockBlacklist([
    { _id: 'f', term: 'vpn', term_field: 'any', category: 'vpn', severity: 'high', score_weight: 60, active: true },
  ], async () => {
    const r = await lookupAsn(1, null, { provider: 'Comcast Cable', asnOrg: 'COMCAST-7922' });
    assert.strictEqual(r.match, false);
  });
});

await test('ASN rule wins when both ASN and term match', async () => {
  await withMockBlacklist([
    { _id: 'g1', asn: 9009, category: 'vpn', severity: 'high', score_weight: 70, active: true },
    { _id: 'g2', term: 'vpn', term_field: 'any', category: 'vpn', severity: 'medium', score_weight: 40, active: true },
  ], async () => {
    const r = await lookupAsn(9009, null, { provider: 'M247 VPN Service' });
    assert.strictEqual(r.match_kind, 'asn');
    assert.strictEqual(r.score_weight, 70);   // ASN rule's weight, not term rule's
    // But we should still note the term match for visibility
    assert.ok(r.flags.some(f => f.startsWith('also_term_match:')), `flags=${r.flags}`);
  });
});

await test('Among multiple term hits, hard_block wins over high', async () => {
  await withMockBlacklist([
    { _id: 'h1', term: 'hosting',  term_field: 'any', category: 'hosting', severity: 'low',        score_weight: 25, active: true },
    { _id: 'h2', term: 'tor exit', term_field: 'any', category: 'tor',     severity: 'hard_block', score_weight: 100, active: true },
  ], async () => {
    const r = await lookupAsn(1, null, { provider: 'Acme Hosting and Tor Exit' });
    assert.strictEqual(r.match, true);
    assert.strictEqual(r.severity, 'hard_block');
    assert.strictEqual(r.score_weight, 100);
  });
});

await test('Inactive rules are ignored', async () => {
  await withMockBlacklist([
    { _id: 'i', term: 'vpn', term_field: 'any', category: 'vpn', severity: 'high', score_weight: 60, active: false },
  ], async () => {
    const r = await lookupAsn(1, null, { provider: 'NordVPN' });
    assert.strictEqual(r.match, false);
  });
});

await test('Workspace-scoped term rule does not leak to other workspaces', async () => {
  const wsA = '507f1f77bcf86cd799439011';
  const wsB = '507f1f77bcf86cd799439022';
  await withMockBlacklist([
    { _id: 'j', workspace_id: { toString: () => wsA }, term: 'foo', term_field: 'any', category: 'other', severity: 'low', score_weight: 10, active: true },
  ], async () => {
    const r = await lookupAsn(1, { toString: () => wsB }, { provider: 'foo bar' });
    assert.strictEqual(r.match, false);
  });
});

await test('Global term rule applies regardless of workspace', async () => {
  const wsA = '507f1f77bcf86cd799439011';
  await withMockBlacklist([
    { _id: 'k', workspace_id: null, term: 'tor exit', term_field: 'any', category: 'tor', severity: 'hard_block', score_weight: 100, active: true },
  ], async () => {
    const r = await lookupAsn(1, { toString: () => wsA }, { provider: 'Random Tor Exit' });
    assert.strictEqual(r.match, true);
  });
});

await test('Match works when ASN is null but provider is set', async () => {
  await withMockBlacklist([
    { _id: 'l', term: 'bulletproof', term_field: 'any', category: 'spam', severity: 'high', score_weight: 80, active: true },
  ], async () => {
    const r = await lookupAsn(null, null, { provider: 'BulletProof Hosting LLC' });
    assert.strictEqual(r.match, true);
  });
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
})();
