// Tests for Cloudflare-specific request/response handling.

process.env.SESSION_SECRET = 'test-secret-must-be-at-least-16-chars';

const assert = require('assert');
const path = require('path');

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); fail++; }
}

// =====================================================
console.log('Cloudflare country fallback:');
// =====================================================

// Stub models + ProxyCheck so the network filter runs without external calls
const modelsPath = path.resolve(__dirname, '../src/models');
require.cache[modelsPath + '.js'] = require.cache[modelsPath + '/index.js'] = {
  id: modelsPath, filename: modelsPath, loaded: true,
  exports: { AsnBlacklist: { find: () => ({ lean: async () => [] }) } },
};
const proxycheckPath = path.resolve(__dirname, '../src/lib/proxycheck');
let pcMock = null;
require.cache[proxycheckPath + '.js'] = {
  id: proxycheckPath, filename: proxycheckPath, loaded: true,
  exports: { lookup: async () => pcMock, clearCache: () => {}, normalize: () => null },
};

const { networkFilter } = require(path.resolve(__dirname, '../src/filters/network'));

(async () => {

  await test('CF-IPCountry used when ProxyCheck unavailable', async () => {
    pcMock = null;     // no proxycheck data
    const r = await networkFilter({
      ip: '1.2.3.4',
      userAgent: 'Mozilla/5.0',
      headers: { 'cf-ipcountry': 'IN' },
    });
    assert.strictEqual(r.enrichment.country, 'IN');
    assert.ok(r.flags.includes('cf_country_fallback'));
  });

  await test('CF-IPCountry NOT overwritten when ProxyCheck has country', async () => {
    pcMock = {
      asn: 16276, asn_org: 'OVH', country: 'FR', is_proxy: false,
      type: 'hosting', risk_score: 33, organisation: 'X',
    };
    const r = await networkFilter({
      ip: '1.2.3.4',
      userAgent: 'Mozilla/5.0',
      headers: { 'cf-ipcountry': 'IN' },
    });
    assert.strictEqual(r.enrichment.country, 'FR');
    assert.ok(!r.flags.includes('cf_country_fallback'));
  });

  await test('CF-IPCountry "XX" (unknown) ignored', async () => {
    pcMock = null;
    const r = await networkFilter({
      ip: '1.2.3.4',
      userAgent: 'Mozilla/5.0',
      headers: { 'cf-ipcountry': 'XX' },
    });
    assert.strictEqual(r.enrichment.country, undefined);
  });

  await test('CF-IPCountry "T1" (Tor) flips proxy verdict to TOR', async () => {
    pcMock = null;
    const r = await networkFilter({
      ip: '1.2.3.4',
      userAgent: 'Mozilla/5.0',
      headers: { 'cf-ipcountry': 'T1' },
    });
    assert.strictEqual(r.enrichment.is_proxy, true);
    assert.strictEqual(r.enrichment.proxy_type, 'TOR');
    assert.ok(r.flags.includes('cf_tor_flagged'));
    assert.ok(r.score >= 100);
  });

  await test('CF-IPCountry "T1" does NOT override existing ProxyCheck non-tor verdict', async () => {
    pcMock = {
      asn: 1, asn_org: 'X', country: 'US', is_proxy: true, proxy_type: 'VPN', risk_score: 50,
    };
    const r = await networkFilter({
      ip: '1.2.3.4',
      userAgent: 'Mozilla/5.0',
      headers: { 'cf-ipcountry': 'T1' },
    });
    // ProxyCheck already said VPN - we don't overwrite. Country stays US.
    assert.strictEqual(r.enrichment.country, 'US');
    assert.strictEqual(r.enrichment.proxy_type, 'VPN');
  });

  await test('Invalid CF-IPCountry format ignored', async () => {
    pcMock = null;
    const r = await networkFilter({
      ip: '1.2.3.4',
      userAgent: 'Mozilla/5.0',
      headers: { 'cf-ipcountry': 'lowercase' },     // not 2 uppercase letters
    });
    assert.strictEqual(r.enrichment.country, undefined);
  });

  await test('CF-IPCity used as fallback', async () => {
    pcMock = null;
    const r = await networkFilter({
      ip: '1.2.3.4',
      userAgent: 'Mozilla/5.0',
      headers: { 'cf-ipcountry': 'GB', 'cf-ipcity': 'London', 'cf-region': 'England' },
    });
    assert.strictEqual(r.enrichment.country, 'GB');
    assert.strictEqual(r.enrichment.city, 'London');
    assert.strictEqual(r.enrichment.region, 'England');
  });

  await test('No CF headers and no ProxyCheck = no country (graceful)', async () => {
    pcMock = null;
    const r = await networkFilter({
      ip: '1.2.3.4',
      userAgent: 'Mozilla/5.0',
      headers: {},
    });
    assert.strictEqual(r.enrichment.country, undefined);
    assert.ok(r.flags.includes('proxycheck_unavailable'));
  });

// =====================================================
console.log('\nIP extraction (Cloudflare-aware):');
// =====================================================

const { getClientIp } = require(path.resolve(__dirname, '../src/lib/ip'));

  await test('CF-Connecting-IP wins over X-Real-IP and req.ip', () => {
    const req = {
      headers: { 'cf-connecting-ip': '1.2.3.4', 'x-real-ip': '5.6.7.8' },
      ip: '9.9.9.9',
    };
    assert.strictEqual(getClientIp(req), '1.2.3.4');
  });

  await test('CF-Connecting-IP trimmed', () => {
    const req = { headers: { 'cf-connecting-ip': '  1.2.3.4  ' }, ip: '9.9.9.9' };
    assert.strictEqual(getClientIp(req), '1.2.3.4');
  });

  await test('Falls through to req.ip when no CF headers', () => {
    const req = { headers: {}, ip: '9.9.9.9' };
    assert.strictEqual(getClientIp(req), '9.9.9.9');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
