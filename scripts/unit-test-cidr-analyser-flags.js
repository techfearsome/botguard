// Unit tests for the writeLiveState / writeSnapshots flags on analyseWorkspace.
//
// These flags are what makes the time-frame selector work correctly:
//  - When you ask for "yesterday", the analyser should write snapshots for
//    yesterday but NOT touch CidrIntelligence (the live state). Otherwise
//    the 60s worker would immediately overwrite results with current-day
//    patterns.
//  - When the 60s worker runs (default), both should be written.
//
// We can't easily spin up MongoDB in unit tests, so this test inspects the
// analyser's behaviour by mocking the model layer with in-memory recorders.

const assert = require('assert');
const path = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

// Mock the models module — analyser does `require('../models')` lazily so
// we can intercept by overriding the require cache.
const Module = require('module');
const origResolve = Module._resolve_filename || Module._resolveFilename;

// Create simple in-memory recorders
function makeRecorder() {
  const writes = [];
  return {
    writes,
    find: () => ({
      select: () => ({ sort: () => ({ lean: async () => [] }), lean: async () => [] }),
      lean: async () => [],
    }),
    updateOne: async (filter, update, opts) => {
      writes.push({ filter, update, opts });
      return { upsertedCount: 1, matchedCount: 0 };
    },
  };
}

// Stub mongoose model registration so we don't need a real DB
process.env.SKIP_MONGOOSE_CONNECT = '1';

// Inject mocks before requiring the analyser
const clickRecorder    = makeRecorder();
const intelRecorder    = makeRecorder();
const snapshotRecorder = makeRecorder();
const workspaceRecorder = makeRecorder();

const mockModels = {
  Click: {
    find: () => ({
      select: () => ({
        lean: async () => [
          // 5 clicks from same /24 within 1 minute = burst + hammer + rapid_dup + volume
          { ip: '1.2.3.4', ts: new Date('2026-05-13T10:00:00Z'), conversion_count: 0,
            user_agent: 'iPhone', asn_org: 'Test', country: 'US', decision: 'allow' },
          { ip: '1.2.3.4', ts: new Date('2026-05-13T10:00:05Z'), conversion_count: 0,
            user_agent: 'iPhone', asn_org: 'Test', country: 'US', decision: 'allow' },
          { ip: '1.2.3.4', ts: new Date('2026-05-13T10:00:10Z'), conversion_count: 0,
            user_agent: 'iPhone', asn_org: 'Test', country: 'US', decision: 'allow' },
          { ip: '1.2.3.4', ts: new Date('2026-05-13T10:00:15Z'), conversion_count: 0,
            user_agent: 'iPhone', asn_org: 'Test', country: 'US', decision: 'allow' },
          { ip: '1.2.3.4', ts: new Date('2026-05-13T10:00:20Z'), conversion_count: 0,
            user_agent: 'iPhone', asn_org: 'Test', country: 'US', decision: 'allow' },
        ],
      }),
    }),
  },
  CidrIntelligence: intelRecorder,
  CidrDailySnapshot: snapshotRecorder,
  Workspace: { find: () => ({ select: () => ({ lean: async () => [] }) }) },
};

// Patch require so the analyser gets our mocks
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === '../models' || id.endsWith('/models')) return mockModels;
  return origRequire.apply(this, arguments);
};

const { analyseWorkspace } = require(path.resolve(__dirname, '../src/lib/cidrAnalyser'));

(async () => {
  console.log('writeLiveState / writeSnapshots flag behaviour:');

  // ── default: both writes ───────────────────────────────────────────
  intelRecorder.writes.length = 0;
  snapshotRecorder.writes.length = 0;

  await analyseWorkspace('test-ws', {
    windowStart: new Date('2026-05-13T00:00:00Z'),
    windowEnd:   new Date('2026-05-13T23:59:59Z'),
  });

  test('Default behaviour writes both snapshots AND live state', () => {
    assert.ok(snapshotRecorder.writes.length > 0,
      'expected at least one snapshot write');
    assert.ok(intelRecorder.writes.length > 0,
      'expected at least one CidrIntelligence write');
  });

  // ── writeLiveState: false ──────────────────────────────────────────
  intelRecorder.writes.length = 0;
  snapshotRecorder.writes.length = 0;

  await analyseWorkspace('test-ws', {
    windowStart: new Date('2026-05-13T00:00:00Z'),
    windowEnd:   new Date('2026-05-13T23:59:59Z'),
    writeLiveState: false,
  });

  test('writeLiveState=false skips CidrIntelligence write', () => {
    assert.strictEqual(intelRecorder.writes.length, 0,
      `expected 0 intel writes, got ${intelRecorder.writes.length}`);
  });

  test('writeLiveState=false still writes snapshots', () => {
    assert.ok(snapshotRecorder.writes.length > 0,
      'snapshots should be written even when live state is skipped');
  });

  // ── writeSnapshots: false ──────────────────────────────────────────
  intelRecorder.writes.length = 0;
  snapshotRecorder.writes.length = 0;

  await analyseWorkspace('test-ws', {
    windowStart: new Date('2026-05-13T00:00:00Z'),
    windowEnd:   new Date('2026-05-13T23:59:59Z'),
    writeSnapshots: false,
  });

  test('writeSnapshots=false skips CidrDailySnapshot write', () => {
    assert.strictEqual(snapshotRecorder.writes.length, 0,
      `expected 0 snapshot writes, got ${snapshotRecorder.writes.length}`);
  });

  test('writeSnapshots=false still writes live state', () => {
    assert.ok(intelRecorder.writes.length > 0,
      'live state should be written even when snapshots are skipped');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
