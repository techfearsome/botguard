// Unit tests for resolveGuardConfig — the resolver that decides whether a
// click runs through the Level 2 Bot Guard, based on the CAMPAIGN-level
// bot_guard config with per-device targeting (falling back to legacy
// page-level bot_guard).
//
// This is the gate that guarantees "not all devices go through Level 2".
// A regression here would either wave bots past the guard or challenge
// device classes that were meant to skip it, so coverage is deliberate.

const assert = require('assert');
const path = require('path');

const { resolveGuardConfig } = require(path.resolve(__dirname, '../src/lib/guardEligibility'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

const offerPage = { kind: 'offer' };

function campaignWithGuard(guard) {
  return { filter_config: { bot_guard: guard } };
}

console.log('resolveGuardConfig - campaign-level with device targeting:');

test('Enabled + device in allowlist → returns config (source campaign)', () => {
  const cfg = resolveGuardConfig({
    campaign: campaignWithGuard({ enabled: true, devices: ['windows', 'mac'] }),
    targetPage: offerPage,
    deviceClass: 'windows',
  });
  assert.ok(cfg, 'expected a config object');
  assert.strictEqual(cfg.source, 'campaign');
  assert.strictEqual(cfg.enabled, true);
});

test('Enabled + device NOT in allowlist → null (device skips Level 2)', () => {
  const cfg = resolveGuardConfig({
    campaign: campaignWithGuard({ enabled: true, devices: ['windows', 'mac'] }),
    targetPage: offerPage,
    deviceClass: 'iphone',
  });
  assert.strictEqual(cfg, null);
});

test('Enabled + empty devices list → treated as ALL devices', () => {
  for (const dc of ['iphone', 'android', 'windows', 'mac', 'linux', 'other']) {
    const cfg = resolveGuardConfig({
      campaign: campaignWithGuard({ enabled: true, devices: [] }),
      targetPage: offerPage,
      deviceClass: dc,
    });
    assert.ok(cfg, `expected guard to run for ${dc} when devices is empty`);
  }
});

test('Disabled campaign guard → null (unless page-level applies)', () => {
  const cfg = resolveGuardConfig({
    campaign: campaignWithGuard({ enabled: false, devices: ['iphone'] }),
    targetPage: offerPage,
    deviceClass: 'iphone',
  });
  assert.strictEqual(cfg, null);
});

console.log('\nresolveGuardConfig - legacy page-level fallback:');

test('No campaign guard + page bot_guard enabled → returns page config', () => {
  const cfg = resolveGuardConfig({
    campaign: { filter_config: {} },
    targetPage: { kind: 'offer', bot_guard: { enabled: true } },
    deviceClass: 'android',
  });
  assert.ok(cfg);
  assert.strictEqual(cfg.source, 'page');
});

test('Campaign guard takes precedence over page-level', () => {
  // Campaign says "only windows"; page-level is enabled. iPhone should skip,
  // proving the page-level flag does NOT override campaign device targeting.
  const cfg = resolveGuardConfig({
    campaign: campaignWithGuard({ enabled: true, devices: ['windows'] }),
    targetPage: { kind: 'offer', bot_guard: { enabled: true } },
    deviceClass: 'iphone',
  });
  assert.strictEqual(cfg, null);
});

test('Neither campaign nor page guard → null', () => {
  const cfg = resolveGuardConfig({
    campaign: { filter_config: {} },
    targetPage: { kind: 'offer' },
    deviceClass: 'windows',
  });
  assert.strictEqual(cfg, null);
});

console.log('\nresolveGuardConfig - config normalization:');

test('min_dwell_ms is clamped to 1000..10000', () => {
  const low = resolveGuardConfig({
    campaign: campaignWithGuard({ enabled: true, devices: ['mac'], min_dwell_ms: 50 }),
    targetPage: offerPage, deviceClass: 'mac',
  });
  const high = resolveGuardConfig({
    campaign: campaignWithGuard({ enabled: true, devices: ['mac'], min_dwell_ms: 999999 }),
    targetPage: offerPage, deviceClass: 'mac',
  });
  assert.strictEqual(low.min_dwell_ms, 1000);
  assert.strictEqual(high.min_dwell_ms, 10000);
});

test('check_* flags default sensibly and pass through', () => {
  const cfg = resolveGuardConfig({
    campaign: campaignWithGuard({ enabled: true, devices: ['mac'], check_webgl: true, check_dwell: false }),
    targetPage: offerPage, deviceClass: 'mac',
  });
  assert.strictEqual(cfg.check_timezone, true);   // undefined → default true
  assert.strictEqual(cfg.check_dwell, false);     // explicit false honored
  assert.strictEqual(cfg.check_webgl, true);      // explicit true honored
});

test('Handles a mongoose-style subdoc (toObject)', () => {
  const guard = {
    enabled: true, devices: ['linux'], check_timezone: true,
    toObject() { return { ...this, toObject: undefined }; },
  };
  const cfg = resolveGuardConfig({
    campaign: { filter_config: { bot_guard: guard } },
    targetPage: offerPage, deviceClass: 'linux',
  });
  assert.ok(cfg);
  assert.strictEqual(cfg.source, 'campaign');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
