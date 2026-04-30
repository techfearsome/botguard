// Live ProxyCheck API smoke test.
// Run this AFTER setting PROXYCHECK_API_KEY in your env to verify the real API call works.
// Uses 1.1.1.1 (Cloudflare DNS - well-known IP, free to query, won't burn quota).
//
// Usage:
//   PROXYCHECK_API_KEY=xxx node scripts/test-proxycheck-live.js

const path = require('path');
const { lookup, clearCache } = require(path.join(__dirname, '../src/lib/proxycheck'));

if (!process.env.PROXYCHECK_API_KEY) {
  console.log('SKIP: set PROXYCHECK_API_KEY to run this live test.');
  process.exit(0);
}

(async () => {
  console.log('Hitting ProxyCheck.io v3 with a known IP...');
  clearCache();

  const result = await lookup('1.1.1.1');
  if (!result) {
    console.error('FAIL: lookup returned null. Check your API key and network.');
    process.exit(1);
  }

  console.log('\nNormalized result:');
  console.log(JSON.stringify({
    ip: result.ip,
    asn: result.asn,
    asn_org: result.asn_org,
    organisation: result.organisation,
    country: result.country,
    country_name: result.country_name,
    region: result.region,
    city: result.city,
    type: result.type,
    is_proxy: result.is_proxy,
    proxy_type: result.proxy_type,
    operator: result.operator,
    risk_score: result.risk_score,
    confidence: result.confidence,
    hosting: result.hosting,
    scraper: result.scraper,
    source: result.source,
  }, null, 2));

  // Sanity checks - 1.1.1.1 is Cloudflare's DNS resolver
  let ok = true;
  if (!result.country) {
    console.error('FAIL: no country code returned');
    ok = false;
  }
  if (typeof result.asn !== 'number' || result.asn === 0) {
    console.error('FAIL: ASN not parsed as a number');
    ok = false;
  }
  if (!result.asn_org) {
    console.error('FAIL: no provider/asn_org returned');
    ok = false;
  }

  if (!ok) {
    process.exit(1);
  }

  console.log('\nAll smoke checks passed. The v3 client is parsing real responses correctly.');
  process.exit(0);
})().catch((err) => {
  console.error('CRASH:', err);
  process.exit(1);
});
