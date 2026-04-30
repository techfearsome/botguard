// Regression test for the production crash:
//   "Click validation failed: operator: Cast to string failed for value [object Object]"
//
// Reproduces the exact ProxyCheck response that crashed the click writer in production
// (VPN Unlimited identified as the operator with full profile object), and verifies the
// click record can be built and validated by Mongoose without throwing.

const assert = require('assert');
const path = require('path');
const mongoose = require('mongoose');

const { Click } = require(path.join(__dirname, '../src/models'));
const { buildClickDoc } = require(path.join(__dirname, '../src/lib/click'));
const { normalize } = require(path.join(__dirname, '../src/lib/proxycheck'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

console.log('Regression: operator object handling:');

// Exact ProxyCheck response from the production crash log
const VPN_UNLIMITED_RESPONSE = {
  network: {
    asn: 'AS123', range: '1.2.3.0/24', hostname: null,
    provider: 'KeepSolid Inc', organisation: 'VPN Unlimited',
    type: 'Hosting',
  },
  location: {
    country_code: 'US', country_name: 'United States',
    region_name: 'California', city_name: 'Los Angeles',
  },
  detections: {
    proxy: false, vpn: true, compromised: false, scraper: false, tor: false,
    hosting: true, anonymous: false, risk: 80, confidence: 100,
  },
  operator: {
    name: 'VPN Unlimited',
    url: 'https://www.vpnunlimited.com/',
    anonymity: 'medium',
    popularity: 'high',
    services: ['datacenter_vpns'],
    protocols: ['WireGuard', 'OpenVPN', 'IKEv2', 'IPSec', 'PPTP'],
    policies: {
      ad_filtering: false, free_access: false, paid_access: true,
      port_forwarding: false, logging: false, anonymous_payments: true,
      crypto_payments: true, traceable_ownership: true,
    },
    additional_operators: null,
  },
  last_updated: '2026-04-29T23:01:12Z',
};

test('Normalizer accepts operator-as-object without crashing', () => {
  const r = normalize('1.2.3.4', VPN_UNLIMITED_RESPONSE);
  assert.strictEqual(r.operator_name, 'VPN Unlimited');
  assert.strictEqual(r.operator_anonymity, 'medium');
  assert.strictEqual(typeof r.operator, 'object');
  assert.deepStrictEqual(r.operator.protocols, ['WireGuard', 'OpenVPN', 'IKEv2', 'IPSec', 'PPTP']);
});

test('Mongoose validates click doc with operator object without throwing', () => {
  // Build the same shape that /go would build
  const req = {
    get: () => 'Mozilla/5.0 (Windows NT 10.0) Chrome/120',
    headers: {},
    query: { utm_source: 'fb', utm_medium: 'cpc', utm_campaign: 'q4' },
    ip: '1.2.3.4',
  };
  const doc = buildClickDoc({
    req,
    workspace: { _id: new mongoose.Types.ObjectId() },
    campaign: { _id: new mongoose.Types.ObjectId(), source_profile: 'mixed', filter_config: { mode: 'log_only' } },
  });

  // Merge ProxyCheck enrichment - this is what the /go route does
  const verdict = normalize('1.2.3.4', VPN_UNLIMITED_RESPONSE);
  Object.assign(doc, {
    asn: verdict.asn,
    asn_org: verdict.asn_org,
    organisation: verdict.organisation,
    operator: verdict.operator,                   // ← THE OBJECT - must not crash
    operator_name: verdict.operator_name,
    operator_anonymity: verdict.operator_anonymity,
    country: verdict.country,
    is_proxy: verdict.is_proxy,
    proxy_type: verdict.proxy_type,
    risk_score: verdict.risk_score,
  });

  // Construct a Mongoose document and run validation - this is what was throwing before
  const click = new Click(doc);
  const err = click.validateSync();
  assert.strictEqual(err, undefined, `Mongoose validation error: ${err && err.message}`);

  // Verify the data round-trips correctly
  assert.strictEqual(click.operator_name, 'VPN Unlimited');
  assert.strictEqual(click.operator_anonymity, 'medium');
  assert.strictEqual(click.operator.url, 'https://www.vpnunlimited.com/');
});

test('Click with operator=null also validates', () => {
  const req = {
    get: () => 'Mozilla/5.0',
    headers: {}, query: {}, ip: '8.8.8.8',
  };
  const doc = buildClickDoc({
    req,
    workspace: { _id: new mongoose.Types.ObjectId() },
    campaign: { _id: new mongoose.Types.ObjectId(), source_profile: 'mixed', filter_config: { mode: 'log_only' } },
  });
  doc.operator = null;
  doc.operator_name = null;

  const click = new Click(doc);
  const err = click.validateSync();
  assert.strictEqual(err, undefined);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
