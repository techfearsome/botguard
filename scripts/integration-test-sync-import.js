// Integration test for syncImport.pullPartner — drives the full pull → classify
// → stage → implement flow with a stubbed feed (fetch) and stubbed models.
// No network, no DB. Verifies the importer-control guarantees end-to-end.

const assert = require('assert');
const path = require('path');
const { pullPartner } = require(path.resolve(__dirname, '../src/lib/syncImport'));

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

// ── Stub models ───────────────────────────────────────────────────────────
function makeModels(localCidrDocs = [], localAsnDocs = []) {
  const staged = [];
  const seededCidrs = [];
  const seededAsns = [];
  const query = (docs) => ({ select: () => ({ lean: async () => docs }) });
  return {
    _staged: staged, _seededCidrs: seededCidrs, _seededAsns: seededAsns,
    CidrIntelligence: { find: () => query(localCidrDocs) },
    AsnBlacklist: {
      find: () => query(localAsnDocs),
      updateOne: async (filter, update) => { seededAsns.push({ filter, update }); },
    },
    SyncStagedEntry: {
      updateOne: async (filter, update) => {
        const existing = staged.find((s) => s.value === filter.value && s.kind === filter.kind);
        const state = update.$set.state;
        if (existing) Object.assign(existing, { state, match_status: update.$set.match_status });
        else staged.push({ value: filter.value, kind: filter.kind, state, match_status: update.$set.match_status });
      },
    },
  };
}

// Stub cidrSeed so we can see what got implemented as CIDR.
function makeCidrSeed(sink) {
  return { importSeeds: async (wsId, cidrs, opts) => { sink.push({ cidrs, opts }); return { imported: cidrs.length }; } };
}

function makeFetch(payload, ok = true, status = 200) {
  return async () => ({ ok, status, json: async () => payload });
}

function makePartner(overrides = {}) {
  return {
    _id: 'p1', name: 'PartnerA', direction: 'import',
    feed_url: 'https://partner.example/sync/feed', passcode: 'bgs_testkey123456',
    pull: { cidr: true, asn: true },
    disposition: 'monitor', promotion_mode: 'corroboration',
    thresholds: { min_local_score: 60, min_local_hits: 5, match_percentage: 50 },
    implement_target: 'seed',
    async save() { this._saved = true; },
    ...overrides,
  };
}

const ws = { _id: 'ws1' };

(async () => {
  console.log('pullPartner — disposition=monitor:');

  await test('monitor stages everything, implements nothing', async () => {
    const models = makeModels();
    const seedSink = [];
    const partner = makePartner({ disposition: 'monitor' });
    const feed = makeFetch({ ok: true, cidr: [{ cidr: '1.2.3.0/24', score: 90 }, { cidr: '9.9.9.0/24', score: 70 }], asn: [{ asn: 64500 }] });
    const stats = await pullPartner({ models, fetchImpl: feed, cidrSeed: makeCidrSeed(seedSink) }, ws, partner);
    assert.strictEqual(stats.pulled, 3);
    assert.strictEqual(stats.implemented, 0, 'monitor must not implement');
    assert.strictEqual(stats.staged, 3);
    assert.strictEqual(seedSink.length, 0, 'no CIDR seeding under monitor');
  });

  console.log('\npullPartner — disposition=implement, corroboration:');

  await test('only locally-corroborated ranges implement; new ones stage', async () => {
    // Local: 1.2.3.0/24 seen at score 82/400 hits (corroborates); 9.9.9.0/24 unknown.
    const models = makeModels([{ cidr: '1.2.3.0/24', score: 82, hit_count: 400, status: 'new' }]);
    const seedSink = [];
    const partner = makePartner({ disposition: 'implement', promotion_mode: 'corroboration', thresholds: { min_local_score: 60, min_local_hits: 5, match_percentage: 50 } });
    const feed = makeFetch({ ok: true, cidr: [{ cidr: '1.2.3.0/24', score: 90 }, { cidr: '9.9.9.0/24', score: 70 }], asn: [] });
    const stats = await pullPartner({ models, fetchImpl: feed, cidrSeed: makeCidrSeed(seedSink) }, ws, partner);
    assert.strictEqual(stats.matched, 1);
    assert.strictEqual(stats.new_entries, 1);
    assert.strictEqual(stats.implemented, 1, 'corroborated range should implement');
    assert.strictEqual(stats.staged, 1, 'unseen range should stage');
    assert.deepStrictEqual(seedSink[0].cidrs, ['1.2.3.0/24']);
    assert.ok(seedSink[0].opts.seedSource.includes('PartnerA'), 'seed tagged by source');
  });

  await test('active local range is skipped (duplicate), never re-seeded', async () => {
    const models = makeModels([{ cidr: '1.2.3.0/24', score: 82, hit_count: 400, status: 'blocked' }]);
    const seedSink = [];
    const partner = makePartner({ disposition: 'implement', promotion_mode: 'full' });
    const feed = makeFetch({ ok: true, cidr: [{ cidr: '1.2.3.0/24', score: 90 }], asn: [] });
    const stats = await pullPartner({ models, fetchImpl: feed, cidrSeed: makeCidrSeed(seedSink) }, ws, partner);
    assert.strictEqual(stats.skipped, 1, 'already-active range is a duplicate → skipped');
    assert.strictEqual(stats.implemented, 0);
    assert.strictEqual(seedSink.length, 0);
  });

  console.log('\npullPartner — full trust + ASN:');

  await test('full trust implements new CIDR and ASN', async () => {
    const models = makeModels();
    const seedSink = [];
    const partner = makePartner({ disposition: 'implement', promotion_mode: 'full', implement_target: 'direct' });
    const feed = makeFetch({ ok: true, cidr: [{ cidr: '5.6.7.0/24', score: 88 }], asn: [{ asn: 64500, category: 'vpn' }] });
    const stats = await pullPartner({ models, fetchImpl: feed, cidrSeed: makeCidrSeed(seedSink) }, ws, partner);
    assert.strictEqual(stats.implemented, 2);
    assert.deepStrictEqual(seedSink[0].cidrs, ['5.6.7.0/24']);
    assert.strictEqual(models._seededAsns.length, 1, 'ASN upserted into blacklist');
    assert.strictEqual(models._seededAsns[0].update.$setOnInsert.active, true, 'direct target activates ASN');
  });

  console.log('\npullPartner — percentage mode:');

  await test('percentage: batch above threshold implements all', async () => {
    // 2 of 2 incoming match local → 100% ≥ 50% → trusted → implement both.
    const models = makeModels([
      { cidr: '1.1.1.0/24', score: 30, hit_count: 1, status: 'new' },
      { cidr: '2.2.2.0/24', score: 30, hit_count: 1, status: 'new' },
    ]);
    const seedSink = [];
    const partner = makePartner({ disposition: 'implement', promotion_mode: 'percentage', thresholds: { match_percentage: 50 } });
    const feed = makeFetch({ ok: true, cidr: [{ cidr: '1.1.1.0/24', score: 90 }, { cidr: '2.2.2.0/24', score: 90 }], asn: [] });
    const stats = await pullPartner({ models, fetchImpl: feed, cidrSeed: makeCidrSeed(seedSink) }, ws, partner);
    assert.strictEqual(stats.implemented, 2, 'trusted batch implements all (even low local score)');
  });

  await test('percentage: batch below threshold stages all', async () => {
    const models = makeModels([{ cidr: '1.1.1.0/24', score: 30, hit_count: 1, status: 'new' }]);
    const seedSink = [];
    const partner = makePartner({ disposition: 'implement', promotion_mode: 'percentage', thresholds: { match_percentage: 50 } });
    // 1 of 3 matches → 33% < 50% → not trusted → stage all.
    const feed = makeFetch({ ok: true, cidr: [{ cidr: '1.1.1.0/24', score: 90 }, { cidr: '7.7.7.0/24', score: 90 }, { cidr: '8.8.8.0/24', score: 90 }], asn: [] });
    const stats = await pullPartner({ models, fetchImpl: feed, cidrSeed: makeCidrSeed(seedSink) }, ws, partner);
    assert.strictEqual(stats.implemented, 0);
    assert.strictEqual(stats.staged, 3);
  });

  console.log('\npullPartner — error handling:');

  await test('feed HTTP error is captured, nothing implemented', async () => {
    const models = makeModels();
    const seedSink = [];
    const partner = makePartner({ disposition: 'implement', promotion_mode: 'full' });
    const feed = makeFetch({}, false, 403);
    const stats = await pullPartner({ models, fetchImpl: feed, cidrSeed: makeCidrSeed(seedSink) }, ws, partner);
    assert.ok(stats.error, 'error should be recorded');
    assert.strictEqual(stats.implemented, 0);
  });

  await test('pull respects pull.cidr/asn toggles', async () => {
    const models = makeModels();
    const seedSink = [];
    const partner = makePartner({ disposition: 'monitor', pull: { cidr: true, asn: false } });
    const feed = makeFetch({ ok: true, cidr: [{ cidr: '1.2.3.0/24', score: 90 }], asn: [{ asn: 64500 }] });
    const stats = await pullPartner({ models, fetchImpl: feed, cidrSeed: makeCidrSeed(seedSink) }, ws, partner);
    assert.strictEqual(stats.pulled, 1, 'ASN pull disabled → only CIDR counted');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
