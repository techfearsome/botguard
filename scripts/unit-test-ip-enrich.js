// Unit tests for the IPLocate fallback provider + ipEnrich abstraction:
//   - normalize() maps IPLocate → ProxyCheck's exact shape (field parity)
//   - risk score synthesis (proxy/vpn/tor/abuser → 90, hosting → 50, clean → 0)
//   - ipEnrich falls back to IPLocate only when ProxyCheck returns null,
//     and only when the fallback is enabled + configured.

const assert = require('assert');
const path = require('path');

const iplocate = require(path.resolve(__dirname, '../src/lib/iplocate'));
const proxycheck = require(path.resolve(__dirname, '../src/lib/proxycheck'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

// The exact sample the user provided.
const SAMPLE = {
  ip: '64.204.7.228', country: 'Japan', country_code: 'JP', city: 'Tokyo',
  time_zone: 'Asia/Tokyo', subdivision: 'Tokyo',
  asn: { asn: 'AS211415', route: '64.204.7.0/24', name: 'Karolio IT paslaugos, UAB', domain: 'iproyal.com', type: 'isp' },
  privacy: { is_abuser: false, is_hosting: true, is_icloud_relay: false, is_proxy: false, is_tor: false, is_vpn: false },
  company: { name: 'GTT Americas, LLC', domain: 'gtt.net', type: 'isp' },
};

console.log('iplocate.normalize — field mapping:');

test('maps the real sample correctly', () => {
  const n = iplocate.normalize('64.204.7.228', SAMPLE);
  assert.strictEqual(n.asn, 211415);
  assert.strictEqual(n.asn_org, 'Karolio IT paslaugos, UAB'); // asn.name (residential-proxy signal)
  assert.strictEqual(n.organisation, 'GTT Americas, LLC');    // company.name
  assert.strictEqual(n.country, 'JP');
  assert.strictEqual(n.country_name, 'Japan');
  assert.strictEqual(n.region, 'Tokyo');
  assert.strictEqual(n.city, 'Tokyo');
  assert.strictEqual(n.timezone, 'Asia/Tokyo');              // IANA — guard needs this
  assert.strictEqual(n.hosting, true);
  assert.strictEqual(n.operator_name, 'Karolio IT paslaugos, UAB');
});

test('produces the SAME keys as proxycheck.normalize (shape parity)', () => {
  // A minimal ProxyCheck raw to normalize for comparison.
  const pcRaw = {
    network: { asn: 'AS211415', provider: 'X', organisation: 'Y', type: 'isp' },
    location: { country_code: 'JP', country_name: 'Japan', region_name: 'Tokyo', city_name: 'Tokyo', timezone: 'Asia/Tokyo' },
    detections: { proxy: false, risk: 0 },
  };
  const pc = proxycheck.normalize('64.204.7.228', pcRaw);
  const il = iplocate.normalize('64.204.7.228', SAMPLE);
  // Every key the scoring chain reads from ProxyCheck must exist on IPLocate output.
  for (const k of Object.keys(pc)) {
    assert.ok(k in il, `IPLocate output missing key "${k}" that ProxyCheck provides`);
  }
});

console.log('\nrisk score synthesis:');

function riskFor(privacy) {
  return iplocate.normalize('x', { asn: {}, privacy, company: {} }).risk_score;
}

test('proxy → 90', () => assert.strictEqual(riskFor({ is_proxy: true }), 90));
test('vpn → 90', () => assert.strictEqual(riskFor({ is_vpn: true }), 90));
test('tor → 90', () => assert.strictEqual(riskFor({ is_tor: true }), 90));
test('abuser → 90', () => assert.strictEqual(riskFor({ is_abuser: true }), 90));
test('hosting only → 50', () => assert.strictEqual(riskFor({ is_hosting: true }), 50));
test('clean → 0', () => assert.strictEqual(riskFor({}), 0));

test('proxy type severity ordering (tor > abuser > vpn > proxy)', () => {
  const t = (p) => iplocate.normalize('x', { asn: {}, privacy: p, company: {} }).proxy_type;
  assert.strictEqual(t({ is_tor: true, is_vpn: true, is_proxy: true }), 'TOR');
  assert.strictEqual(t({ is_abuser: true, is_vpn: true }), 'COM');
  assert.strictEqual(t({ is_vpn: true, is_proxy: true }), 'VPN');
  assert.strictEqual(t({ is_proxy: true }), 'PUB');
});

console.log('\nipEnrich fallback wiring:');

// Stub the two providers in the require cache so we control their returns.
const proxyPath = require.resolve(path.resolve(__dirname, '../src/lib/proxycheck'));
const ilPath = require.resolve(path.resolve(__dirname, '../src/lib/iplocate'));
let pcReturn = null, ilReturn = null, ilCalled = false;
require.cache[proxyPath].exports = { lookup: async () => pcReturn, clearCache: () => {} };
require.cache[ilPath].exports = { lookup: async () => { ilCalled = true; return ilReturn; }, clearCache: () => {} };
delete require.cache[require.resolve(path.resolve(__dirname, '../src/lib/ipEnrich'))];
const ipEnrich = require(path.resolve(__dirname, '../src/lib/ipEnrich'));

async function run() {
  await asyncTest('primary succeeds → fallback NOT called', async () => {
    process.env.IPLOCATE_FALLBACK_ENABLED = 'true';
    process.env.IPLOCATE_API_KEY = 'k';
    pcReturn = { source: 'proxycheck', is_proxy: true }; ilReturn = null; ilCalled = false;
    const r = await ipEnrich.lookup('1.2.3.4');
    assert.strictEqual(r.source, 'proxycheck');
    assert.strictEqual(ilCalled, false, 'fallback must not run when primary succeeds');
  });

  await asyncTest('primary null + fallback enabled → IPLocate used', async () => {
    process.env.IPLOCATE_FALLBACK_ENABLED = 'yes';
    process.env.IPLOCATE_API_KEY = 'k';
    pcReturn = null; ilReturn = { source: 'iplocate', is_proxy: false }; ilCalled = false;
    const r = await ipEnrich.lookup('1.2.3.4');
    assert.strictEqual(r.source, 'iplocate');
    assert.strictEqual(ilCalled, true);
  });

  await asyncTest('primary null + fallback DISABLED → null (no IPLocate call)', async () => {
    process.env.IPLOCATE_FALLBACK_ENABLED = 'false';
    process.env.IPLOCATE_API_KEY = 'k';
    pcReturn = null; ilReturn = { source: 'iplocate' }; ilCalled = false;
    const r = await ipEnrich.lookup('1.2.3.4');
    assert.strictEqual(r, null);
    assert.strictEqual(ilCalled, false, 'fallback disabled → IPLocate not called');
  });

  await asyncTest('primary null + enabled but no key → null', async () => {
    process.env.IPLOCATE_FALLBACK_ENABLED = 'true';
    delete process.env.IPLOCATE_API_KEY;
    pcReturn = null; ilReturn = { source: 'iplocate' }; ilCalled = false;
    const r = await ipEnrich.lookup('1.2.3.4');
    assert.strictEqual(r, null);
    assert.strictEqual(ilCalled, false);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

async function asyncTest(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

run();
