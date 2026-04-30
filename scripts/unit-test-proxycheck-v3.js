// Tests for ProxyCheck v3 response normalization.
// These exercise the real API response shape to make sure parsing is correct.

const assert = require('assert');
const path = require('path');
const { normalize } = require(path.join(__dirname, '../src/lib/proxycheck'));

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

console.log('ProxyCheck v3 normalizer:');

// Real response from user's report - OVH hosting in France, not a proxy
test('Real OVH hosting response parses correctly', () => {
  const ip = '37.60.48.2';
  const raw = {
    "network": {
      "asn": "AS16276",
      "range": "37.60.48.0/20",
      "hostname": null,
      "provider": "OVH SAS",
      "organisation": "Smtp.fr - Emailing Services",
      "type": "Hosting"
    },
    "location": {
      "continent_name": "Europe",
      "continent_code": "EU",
      "country_name": "France",
      "country_code": "FR",
      "region_name": "Provence",
      "region_code": "PAC",
      "city_name": "Aubagne",
      "postal_code": "13400",
      "latitude": 43.3165,
      "longitude": 5.5837,
      "timezone": "Europe/Paris"
    },
    "detections": {
      "proxy": false,
      "vpn": false,
      "compromised": false,
      "scraper": false,
      "tor": false,
      "hosting": true,
      "anonymous": false,
      "risk": 33,
      "confidence": 100
    },
    "operator": null,
    "last_updated": "2026-04-29T23:01:12Z"
  };

  const r = normalize(ip, raw);
  assert.strictEqual(r.ip, ip);
  assert.strictEqual(r.asn, 16276);                         // numeric, AS prefix stripped
  assert.strictEqual(r.asn_org, 'OVH SAS');                 // provider field
  assert.strictEqual(r.organisation, 'Smtp.fr - Emailing Services');
  assert.strictEqual(r.country, 'FR');                      // ISO alpha-2
  assert.strictEqual(r.country_name, 'France');
  assert.strictEqual(r.region, 'Provence');
  assert.strictEqual(r.city, 'Aubagne');
  assert.strictEqual(r.type, 'hosting');                    // lowercased
  assert.strictEqual(r.is_proxy, false);                    // not a proxy - just hosting
  assert.strictEqual(r.proxy_type, null);
  assert.strictEqual(r.hosting, true);
  assert.strictEqual(r.scraper, false);
  assert.strictEqual(r.risk_score, 33);
  assert.strictEqual(r.confidence, 100);
  assert.strictEqual(r.operator, null);
});

test('VPN response sets is_proxy=true with proxy_type=VPN', () => {
  const raw = {
    network: { asn: 'AS9009', provider: 'M247 Europe', organisation: 'NordVPN', type: 'Hosting' },
    location: { country_code: 'US', country_name: 'United States' },
    detections: { proxy: false, vpn: true, tor: false, compromised: false, hosting: true, anonymous: false, risk: 75, confidence: 100 },
    operator: 'NordVPN',
  };
  const r = normalize('1.2.3.4', raw);
  assert.strictEqual(r.is_proxy, true);
  assert.strictEqual(r.proxy_type, 'VPN');
  assert.strictEqual(r.operator_name, 'NordVPN');     // denormalized name field
  assert.deepStrictEqual(r.operator, { name: 'NordVPN' });    // wrapped into object
  assert.strictEqual(r.risk_score, 75);
});

test('Tor response surfaces TOR even when other flags also true', () => {
  const raw = {
    network: { asn: 'AS60729', provider: 'Zwiebelfreunde e.V.', type: 'Hosting' },
    location: { country_code: 'DE' },
    detections: { proxy: true, vpn: false, tor: true, compromised: false, hosting: true, anonymous: true, risk: 100, confidence: 100 },
    operator: null,
  };
  const r = normalize('1.2.3.4', raw);
  assert.strictEqual(r.is_proxy, true);
  assert.strictEqual(r.proxy_type, 'TOR');   // TOR wins over anonymous/proxy
});

test('Compromised host surfaces COM proxy_type', () => {
  const raw = {
    network: { asn: 'AS16276', provider: 'Some ISP' },
    location: { country_code: 'CN' },
    detections: { proxy: false, vpn: false, tor: false, compromised: true, hosting: false, anonymous: false, risk: 90, confidence: 90 },
  };
  const r = normalize('1.2.3.4', raw);
  assert.strictEqual(r.is_proxy, true);
  assert.strictEqual(r.proxy_type, 'COM');
});

test('Plain proxy detection (no VPN/Tor) → PUB type', () => {
  const raw = {
    network: { asn: 'AS174', provider: 'Cogent' },
    location: { country_code: 'US' },
    detections: { proxy: true, vpn: false, tor: false, compromised: false, hosting: false, anonymous: false, risk: 60, confidence: 80 },
  };
  const r = normalize('1.2.3.4', raw);
  assert.strictEqual(r.is_proxy, true);
  assert.strictEqual(r.proxy_type, 'PUB');
});

test('Anonymous (without proxy/vpn/tor) → PUB type', () => {
  const raw = {
    network: { asn: 'AS174', provider: 'Anonymizer Inc' },
    location: { country_code: 'US' },
    detections: { proxy: false, vpn: false, tor: false, compromised: false, hosting: false, anonymous: true, risk: 50, confidence: 70 },
  };
  const r = normalize('1.2.3.4', raw);
  assert.strictEqual(r.is_proxy, true);
  assert.strictEqual(r.proxy_type, 'PUB');
});

test('Operator as STRING (legacy/simple) → wrapped into {name}', () => {
  const raw = {
    network: { asn: 'AS9009', provider: 'M247' },
    location: { country_code: 'US' },
    detections: { vpn: true, risk: 75, confidence: 100 },
    operator: 'NordVPN',     // string form
  };
  const r = normalize('1.2.3.4', raw);
  assert.strictEqual(r.operator_name, 'NordVPN');
  assert.deepStrictEqual(r.operator, { name: 'NordVPN' });
  assert.strictEqual(r.operator_anonymity, null);
});

test('Operator as OBJECT (real v3 response) → preserved + denormalized', () => {
  // This is the EXACT shape from the live error log (VPN Unlimited).
  // Without object handling this used to crash Mongoose with "Cast to string failed".
  const raw = {
    network: { asn: 'AS123', provider: 'KeepSolid Inc' },
    location: { country_code: 'US' },
    detections: { vpn: true, risk: 80, confidence: 100 },
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
  };
  const r = normalize('1.2.3.4', raw);
  assert.strictEqual(r.operator_name, 'VPN Unlimited');
  assert.strictEqual(r.operator_anonymity, 'medium');
  assert.strictEqual(r.operator.url, 'https://www.vpnunlimited.com/');
  assert.deepStrictEqual(r.operator.protocols, ['WireGuard', 'OpenVPN', 'IKEv2', 'IPSec', 'PPTP']);
  assert.strictEqual(r.is_proxy, true);
  assert.strictEqual(r.proxy_type, 'VPN');
});

test('Operator missing/null → all operator fields null', () => {
  const r = normalize('1.2.3.4', {
    network: { asn: 'AS1', provider: 'X' },
    location: {},
    detections: {},
    operator: null,
  });
  assert.strictEqual(r.operator, null);
  assert.strictEqual(r.operator_name, null);
  assert.strictEqual(r.operator_anonymity, null);
});

test('Operator object without anonymity field → operator_anonymity is null', () => {
  const r = normalize('1.2.3.4', {
    network: { asn: 'AS1', provider: 'X' },
    location: {},
    detections: { vpn: true },
    operator: { name: 'SomeVPN', url: 'https://example.com' },
  });
  assert.strictEqual(r.operator_name, 'SomeVPN');
  assert.strictEqual(r.operator_anonymity, null);
});

test('Residential clean IP - all detections false', () => {
  const raw = {
    network: { asn: 'AS7922', provider: 'Comcast', type: 'Residential' },
    location: { country_code: 'US', country_name: 'United States' },
    detections: { proxy: false, vpn: false, tor: false, compromised: false, hosting: false, scraper: false, anonymous: false, risk: 0, confidence: 100 },
  };
  const r = normalize('1.2.3.4', raw);
  assert.strictEqual(r.is_proxy, false);
  assert.strictEqual(r.proxy_type, null);
  assert.strictEqual(r.hosting, false);
  assert.strictEqual(r.type, 'residential');
});

test('Hosting alone is NOT treated as proxy (corp VPN case)', () => {
  // detection.hosting=true but no proxy/vpn/tor flag - this is a datacenter IP
  // that ProxyCheck doesn't classify as proxy. Could be a corporate VPN gateway.
  const raw = {
    network: { asn: 'AS16276', provider: 'OVH SAS', type: 'Hosting' },
    location: { country_code: 'FR' },
    detections: { proxy: false, vpn: false, tor: false, compromised: false, hosting: true, scraper: false, anonymous: false, risk: 33, confidence: 100 },
  };
  const r = normalize('1.2.3.4', raw);
  assert.strictEqual(r.is_proxy, false, 'hosting alone should not flag is_proxy');
  assert.strictEqual(r.hosting, true);    // but the hosting field is true so the proxy gate's block_hosting toggle can decide
});

test('Missing fields handled gracefully', () => {
  const raw = {
    network: { asn: 'AS123', provider: 'Test' },
    location: {},
    detections: {},
  };
  const r = normalize('1.2.3.4', raw);
  assert.strictEqual(r.country, null);
  assert.strictEqual(r.region, null);
  assert.strictEqual(r.city, null);
  assert.strictEqual(r.is_proxy, false);
  assert.strictEqual(r.risk_score, 0);
  assert.strictEqual(r.confidence, 0);
});

test('ASN with malformed string still parses numeric portion', () => {
  const raw = {
    network: { asn: 'asn 12345', provider: 'X' },
    location: {},
    detections: {},
  };
  const r = normalize('1.2.3.4', raw);
  assert.strictEqual(r.asn, 12345);
});

test('Empty network/location/detections still returns valid object', () => {
  const r = normalize('1.2.3.4', {});
  assert.strictEqual(r.ip, '1.2.3.4');
  assert.strictEqual(r.asn, null);
  assert.strictEqual(r.country, null);
  assert.strictEqual(r.is_proxy, false);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
