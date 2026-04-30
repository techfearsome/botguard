const axios = require('axios');
const logger = require('./logger');

/**
 * ProxyCheck.io v3 integration.
 *
 * v3 endpoint shape:
 *   GET https://proxycheck.io/v3/lookup?ips=1.2.3.4,5.6.7.8&key=...&asn=1&risk=2&vpn=3
 *
 * Response (per IP):
 *   {
 *     "1.2.3.4": {
 *       "asn": "AS12345",
 *       "provider": "ExampleISP",
 *       "country": "United States",
 *       "isocode": "US",
 *       "region": "California",
 *       "city": "Los Angeles",
 *       "type": "Hosting" | "Residential" | "Business" | "Mobile" | ...,
 *       "proxy": { "is_proxy": true, "type": "VPN" },
 *       "risk": { "score": 75 }
 *     }
 *   }
 *
 * Note: ProxyCheck has known gaps that the AsnBlacklist overlay (in asnLookup.js) catches.
 * This module never overrides the blacklist — it only provides the first-pass verdict.
 */

const ENDPOINT = 'https://proxycheck.io/v3/lookup';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;  // 6 hours - IPs don't change verdicts often
const CACHE_MAX_SIZE = 50_000;
const CALL_TIMEOUT_MS = 1500;             // fail fast - we'd rather log a click without enrichment than block on a slow lookup

// Simple LRU-ish cache. For a heavier deployment, swap for Redis.
const memCache = new Map();

function cacheGet(ip) {
  const entry = memCache.get(ip);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    memCache.delete(ip);
    return null;
  }
  // Touch for LRU
  memCache.delete(ip);
  memCache.set(ip, entry);
  return entry.data;
}

function cacheSet(ip, data) {
  if (memCache.size >= CACHE_MAX_SIZE) {
    // Drop oldest
    const firstKey = memCache.keys().next().value;
    memCache.delete(firstKey);
  }
  memCache.set(ip, { ts: Date.now(), data });
}

/**
 * Look up a single IP. Returns a normalized verdict object or null on failure.
 *
 * Normalized return shape:
 *   {
 *     ip, asn (number), asn_org, country, region, city,
 *     type,                    // 'hosting' | 'residential' | 'business' | 'mobile' | ...
 *     is_proxy: boolean,
 *     proxy_type: string|null, // 'VPN' | 'TOR' | 'PUB' | 'COM' | ...
 *     risk_score: number,      // 0-100 (ProxyCheck's own score)
 *     source: 'proxycheck' | 'cache',
 *     raw                      // original response for debugging
 *   }
 */
async function lookup(ip) {
  if (!ip) return null;

  const cached = cacheGet(ip);
  if (cached) return { ...cached, source: 'cache' };

  const apiKey = process.env.PROXYCHECK_API_KEY;
  if (!apiKey) {
    // No key configured - we just skip enrichment. The blacklist overlay still runs.
    logger.debug('proxycheck_no_key', { ip });
    return null;
  }

  try {
    const resp = await axios.get(ENDPOINT, {
      params: { ips: ip, key: apiKey, asn: 1, risk: 2, vpn: 3 },
      timeout: CALL_TIMEOUT_MS,
    });

    const data = resp.data || {};
    const ipData = data[ip];
    if (!ipData) {
      logger.warn('proxycheck_no_ip_data', { ip, status: data.status });
      return null;
    }

    const normalized = normalize(ip, ipData);
    cacheSet(ip, normalized);
    return { ...normalized, source: 'proxycheck' };
  } catch (err) {
    logger.warn('proxycheck_lookup_failed', { ip, err: err.message });
    return null;
  }
}

function normalize(ip, raw) {
  // ASN comes back as "AS12345" - strip prefix and parse
  let asn = null;
  if (raw.asn) {
    const m = String(raw.asn).match(/(\d+)/);
    if (m) asn = Number(m[1]);
  }

  const proxy = raw.proxy || {};
  const risk = raw.risk || {};

  return {
    ip,
    asn,
    asn_org: raw.provider || null,
    country: raw.isocode || null,
    country_name: raw.country || null,
    region: raw.region || null,
    city: raw.city || null,
    type: raw.type ? String(raw.type).toLowerCase() : null,
    is_proxy: Boolean(proxy.is_proxy),
    proxy_type: proxy.type || null,
    risk_score: typeof risk.score === 'number' ? risk.score : 0,
    raw,
  };
}

function clearCache() {
  memCache.clear();
}

module.exports = { lookup, clearCache };
