// Unit tests for country gate and proxy gate filters

const assert = require('assert');
const path = require('path');

const { countryGateCheck } = require(path.join(__dirname, '../src/filters/countryGate'));
const { proxyGateCheck } = require(path.join(__dirname, '../src/filters/proxyGate'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

// =====================================================
console.log('Country gate:');
// =====================================================

test('Disabled gate → never blocks', () => {
  const r = countryGateCheck({
    country: 'CN',
    campaign: { filter_config: { country_gate: { enabled: false, countries: ['US'], mode: 'whitelist' } } },
  });
  assert.strictEqual(r.blocked, false);
  assert.ok(r.flags.includes('country_gate_off'));
});

test('Whitelist mode: country in list → pass', () => {
  const r = countryGateCheck({
    country: 'US',
    campaign: { filter_config: { country_gate: { enabled: true, mode: 'whitelist', countries: ['US', 'GB', 'CA'] } } },
  });
  assert.strictEqual(r.blocked, false);
  assert.ok(r.flags.includes('country_allowed_US'));
});

test('Whitelist mode: country NOT in list → block', () => {
  const r = countryGateCheck({
    country: 'CN',
    campaign: { filter_config: { country_gate: { enabled: true, mode: 'whitelist', countries: ['US', 'GB'] } } },
  });
  assert.strictEqual(r.blocked, true);
  assert.ok(r.flags.includes('country_gate_fail'));
  assert.ok(r.flags.includes('country_blocked_CN'));
});

test('Blacklist mode: country in list → block', () => {
  const r = countryGateCheck({
    country: 'CN',
    campaign: { filter_config: { country_gate: { enabled: true, mode: 'blacklist', countries: ['CN', 'RU', 'KP'] } } },
  });
  assert.strictEqual(r.blocked, true);
  assert.ok(r.flags.includes('country_blocked_CN'));
});

test('Blacklist mode: country NOT in list → pass', () => {
  const r = countryGateCheck({
    country: 'US',
    campaign: { filter_config: { country_gate: { enabled: true, mode: 'blacklist', countries: ['CN', 'RU'] } } },
  });
  assert.strictEqual(r.blocked, false);
  assert.ok(r.flags.includes('country_allowed_US'));
});

test('Country code is case-insensitive', () => {
  const r1 = countryGateCheck({
    country: 'us',     // lowercase
    campaign: { filter_config: { country_gate: { enabled: true, mode: 'whitelist', countries: ['US'] } } },
  });
  const r2 = countryGateCheck({
    country: 'US',
    campaign: { filter_config: { country_gate: { enabled: true, mode: 'whitelist', countries: ['us'] } } },
  });
  assert.strictEqual(r1.blocked, false);
  assert.strictEqual(r2.blocked, false);
});

test('Unknown country + on_unknown=allow → pass', () => {
  const r = countryGateCheck({
    country: null,
    campaign: { filter_config: { country_gate: { enabled: true, mode: 'whitelist', countries: ['US'], on_unknown: 'allow' } } },
  });
  assert.strictEqual(r.blocked, false);
  assert.ok(r.flags.includes('country_gate_unknown_allowed'));
});

test('Unknown country + on_unknown=block → block', () => {
  const r = countryGateCheck({
    country: null,
    campaign: { filter_config: { country_gate: { enabled: true, mode: 'whitelist', countries: ['US'], on_unknown: 'block' } } },
  });
  assert.strictEqual(r.blocked, true);
  assert.ok(r.flags.includes('country_gate_unknown_blocked'));
});

test('Empty whitelist → pass with warning flag (probable misconfig)', () => {
  // Whitelist with no countries listed would normally block everyone.
  // We treat this as a misconfig and let traffic through with a flag instead.
  const r = countryGateCheck({
    country: 'US',
    campaign: { filter_config: { country_gate: { enabled: true, mode: 'whitelist', countries: [] } } },
  });
  assert.strictEqual(r.blocked, false);
  assert.ok(r.flags.includes('country_gate_empty_whitelist'));
});

test('Empty blacklist → pass (nothing to block)', () => {
  const r = countryGateCheck({
    country: 'CN',
    campaign: { filter_config: { country_gate: { enabled: true, mode: 'blacklist', countries: [] } } },
  });
  assert.strictEqual(r.blocked, false);
});

test('Missing country_gate config → not blocked', () => {
  const r = countryGateCheck({ country: 'CN', campaign: { filter_config: {} } });
  assert.strictEqual(r.blocked, false);
});

// =====================================================
console.log('\nProxy gate:');
// =====================================================

test('Disabled gate → never blocks', () => {
  const r = proxyGateCheck({
    enrichment: { is_proxy: true, proxy_type: 'TOR', risk_score: 100 },
    networkFlags: ['proxycheck_tor'],
    campaign: { filter_config: { proxy_gate: { enabled: false } } },
  });
  assert.strictEqual(r.blocked, false);
  assert.ok(r.flags.includes('proxy_gate_off'));
});

test('Block Tor when block_tor=true', () => {
  const r = proxyGateCheck({
    enrichment: { is_proxy: true, proxy_type: 'TOR' },
    networkFlags: [],
    campaign: { filter_config: { proxy_gate: { enabled: true, block_tor: true, block_vpn: true, block_public_proxy: true, block_compromised: true } } },
  });
  assert.strictEqual(r.blocked, true);
  assert.strictEqual(r.reason, 'tor');
});

test('Allow Tor when block_tor=false (rare but possible)', () => {
  const r = proxyGateCheck({
    enrichment: { is_proxy: true, proxy_type: 'TOR' },
    networkFlags: [],
    campaign: { filter_config: { proxy_gate: { enabled: true, block_tor: false, block_vpn: true, block_public_proxy: true, block_compromised: true } } },
  });
  // When block_tor=false but block_vpn=true, the catch-all path could fire.
  // Verify Tor specifically isn't caught when its toggle is off.
  // The 'proxy_other' fallback excludes TOR explicitly.
  assert.strictEqual(r.blocked, false, `unexpectedly blocked: ${r.reason} flags=${r.flags}`);
});

test('Block VPN', () => {
  const r = proxyGateCheck({
    enrichment: { is_proxy: true, proxy_type: 'VPN' },
    networkFlags: [],
    campaign: { filter_config: { proxy_gate: { enabled: true, block_vpn: true, block_tor: true, block_public_proxy: true, block_compromised: true } } },
  });
  assert.strictEqual(r.blocked, true);
  assert.strictEqual(r.reason, 'vpn');
});

test('Block compromised IPs', () => {
  const r = proxyGateCheck({
    enrichment: { is_proxy: true, proxy_type: 'COM' },
    networkFlags: [],
    campaign: { filter_config: { proxy_gate: { enabled: true, block_compromised: true, block_vpn: true, block_tor: true, block_public_proxy: true } } },
  });
  assert.strictEqual(r.blocked, true);
  assert.strictEqual(r.reason, 'compromised');
});

test('Block public proxy', () => {
  const r = proxyGateCheck({
    enrichment: { is_proxy: true, proxy_type: 'PUB' },
    networkFlags: [],
    campaign: { filter_config: { proxy_gate: { enabled: true, block_public_proxy: true, block_vpn: true, block_tor: true, block_compromised: true } } },
  });
  assert.strictEqual(r.blocked, true);
  assert.strictEqual(r.reason, 'public_proxy');
});

test('Hosting IP only blocked when block_hosting=true', () => {
  const enrichment = { is_proxy: false, ip_type: 'hosting' };

  const r1 = proxyGateCheck({
    enrichment, networkFlags: ['hosting_ip'],
    campaign: { filter_config: { proxy_gate: { enabled: true, block_hosting: false, block_vpn: true, block_tor: true, block_public_proxy: true, block_compromised: true } } },
  });
  assert.strictEqual(r1.blocked, false);

  const r2 = proxyGateCheck({
    enrichment, networkFlags: ['hosting_ip'],
    campaign: { filter_config: { proxy_gate: { enabled: true, block_hosting: true, block_vpn: true, block_tor: true, block_public_proxy: true, block_compromised: true } } },
  });
  assert.strictEqual(r2.blocked, true);
  assert.strictEqual(r2.reason, 'hosting');
});

test('Risk score over threshold → block', () => {
  const r = proxyGateCheck({
    enrichment: { is_proxy: false, risk_score: 85 },
    networkFlags: [],
    campaign: { filter_config: { proxy_gate: { enabled: true, max_risk_score: 70, block_vpn: true, block_tor: true, block_public_proxy: true, block_compromised: true } } },
  });
  assert.strictEqual(r.blocked, true);
  assert.strictEqual(r.reason, 'risk_score');
});

test('Risk score at/under threshold → pass', () => {
  const r = proxyGateCheck({
    enrichment: { is_proxy: false, risk_score: 50 },
    networkFlags: [],
    campaign: { filter_config: { proxy_gate: { enabled: true, max_risk_score: 70, block_vpn: true, block_tor: true, block_public_proxy: true, block_compromised: true } } },
  });
  assert.strictEqual(r.blocked, false);
});

test('max_risk_score=100 (default) → never blocks on risk alone', () => {
  const r = proxyGateCheck({
    enrichment: { is_proxy: false, risk_score: 99 },
    networkFlags: [],
    campaign: { filter_config: { proxy_gate: { enabled: true, max_risk_score: 100, block_vpn: true, block_tor: true, block_public_proxy: true, block_compromised: true } } },
  });
  assert.strictEqual(r.blocked, false);
});

test('Clean IP → pass', () => {
  const r = proxyGateCheck({
    enrichment: { is_proxy: false, ip_type: 'residential', risk_score: 5 },
    networkFlags: [],
    campaign: { filter_config: { proxy_gate: { enabled: true, block_vpn: true, block_tor: true, block_public_proxy: true, block_compromised: true } } },
  });
  assert.strictEqual(r.blocked, false);
  assert.ok(r.flags.includes('proxy_gate_pass'));
});

test('ASN blacklist promoted-to-proxy with BLACKLIST_VPN type → block when block_vpn=true', () => {
  // When the ASN blacklist overlay flips a clean ProxyCheck verdict to "proxy" via mark_proxy,
  // the proxy_type gets a BLACKLIST_<CATEGORY> prefix. Make sure the gate honors it.
  const r = proxyGateCheck({
    enrichment: { is_proxy: true, proxy_type: 'BLACKLIST_VPN' },
    networkFlags: ['asn_blacklist_vpn'],
    campaign: { filter_config: { proxy_gate: { enabled: true, block_vpn: true, block_tor: true, block_public_proxy: true, block_compromised: true } } },
  });
  assert.strictEqual(r.blocked, true);
  assert.strictEqual(r.reason, 'vpn');
});

test('BLACKLIST_TOR proxy type → block when block_tor=true', () => {
  const r = proxyGateCheck({
    enrichment: { is_proxy: true, proxy_type: 'BLACKLIST_TOR' },
    networkFlags: ['asn_blacklist_tor'],
    campaign: { filter_config: { proxy_gate: { enabled: true, block_vpn: true, block_tor: true, block_public_proxy: true, block_compromised: true } } },
  });
  assert.strictEqual(r.blocked, true);
  assert.strictEqual(r.reason, 'tor');
});

test('BLACKLIST_DATACENTER not blocked when block_hosting=false', () => {
  const r = proxyGateCheck({
    enrichment: { is_proxy: true, proxy_type: 'BLACKLIST_DATACENTER' },
    networkFlags: ['asn_blacklist_datacenter'],
    campaign: { filter_config: { proxy_gate: { enabled: true, block_hosting: false, block_vpn: true, block_tor: true, block_public_proxy: true, block_compromised: true } } },
  });
  // BLACKLIST_DATACENTER is excluded from the catch-all proxy_other path
  assert.strictEqual(r.blocked, false, `flags=${r.flags}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
