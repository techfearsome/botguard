const axios = require('axios');
const logger = require('./logger');

/**
 * ProxyCheck.io v3 integration.
 *
 * v3 endpoint - IP goes in the path, not as a query param:
 *   GET https://proxycheck.io/v3/<ip>?key=...
 *
 * v3 response shape (per IP, nested):
 *   {
 *     "status": "ok",
 *     "1.2.3.4": {
 *       "network": {
 *         "asn": "AS16276",
 *         "range": "37.60.48.0/20",
 *         "hostname": null,
 *         "provider": "OVH SAS",
 *         "organisation": "Smtp.fr - Emailing Services",
 *         "type": "Hosting" | "Residential" | "Business" | "Mobile" | "Wireless" | ...
 *       },
 *       "location": {
 *         "continent_name": "Europe",
 *         "country_name": "France",
 *         "country_code": "FR",
 *         "region_name": "Provence",
 *         "city_name": "Aubagne",
 *         "latitude": 43.3165,
 *         "longitude": 5.5837,
 *         ...
 *       },
 *       "detections": {
 *         "proxy": false,
 *         "vpn": false,
 *         "compromised": false,
 *         "scraper": false,
 *         "tor": false,
 *         "hosting": true,
 *         "anonymous": false,
 *         "risk": 33,
 *         "confidence": 100
 *       },
 *       "operator": null,
 *       "last_updated": "..."
 *     },
 *     "query_time": 5
 *   }
 *
 * Notes:
 *   - The "operator" field, when populated, identifies the VPN/proxy operator
 *     (e.g. "NordVPN", "ExpressVPN") - useful for cross-referencing with the term blacklist.
 *   - is_proxy is determined by ANY of {proxy, vpn, tor, compromised, anonymous} being true.
 *     "scraper" is informational; "hosting" alone is NOT treated as proxy (corporate VPNs land here).
 *   - The `risk` field (0-100) is exposed as `risk_score`.
 *
 * The AsnBlacklist overlay (in asnLookup.js) runs after this and catches gaps.
 */

const ENDPOINT_BASE = 'https://proxycheck.io/v3';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;  // 6 hours
const CACHE_MAX_SIZE = 50_000;
const CALL_TIMEOUT_MS = 3500;             // bumped up - real-world API calls from distant regions can be ~1-2s

const memCache = new Map();

function cacheGet(ip) {
  const entry = memCache.get(ip);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    memCache.delete(ip);
    return null;
  }
  memCache.delete(ip);
  memCache.set(ip, entry);    // refresh LRU position
  return entry.data;
}

function cacheSet(ip, data) {
  if (memCache.size >= CACHE_MAX_SIZE) {
    const firstKey = memCache.keys().next().value;
    memCache.delete(firstKey);
  }
  memCache.set(ip, { ts: Date.now(), data });
}

/**
 * Look up a single IP. Returns a normalized verdict, or null on failure.
 *
 * Normalized return shape (stable across v2/v3 callers):
 *   {
 *     ip,
 *     asn (number),                  // numeric, AS prefix stripped
 *     asn_org,                       // provider field, e.g. "OVH SAS"
 *     organisation,                  // organisation field, e.g. "Smtp.fr - Emailing Services"
 *     country,                       // ISO alpha-2, e.g. "FR"
 *     country_name,                  // human-readable, e.g. "France"
 *     region, city,
 *     type,                          // 'hosting' | 'residential' | 'business' | 'mobile' | 'wireless' | ...
 *     is_proxy: boolean,             // ANY of {proxy, vpn, tor, compromised, anonymous}
 *     proxy_type: string|null,       // 'TOR' | 'VPN' | 'PUB' | 'COM' | null
 *     operator: string|null,         // VPN/proxy operator name when known
 *     risk_score: number,            // 0-100
 *     confidence: number,            // 0-100
 *     hosting: boolean,              // separate from is_proxy - corp VPNs land here
 *     scraper: boolean,
 *     source: 'proxycheck' | 'cache',
 *     raw                            // original response for debugging
 *   }
 */
async function lookup(ip) {
  if (!ip) return null;

  const cached = cacheGet(ip);
  if (cached) return { ...cached, source: 'cache' };

  const apiKey = process.env.PROXYCHECK_API_KEY;
  if (!apiKey) {
    logger.debug('proxycheck_no_key', { ip });
    return null;
  }

  try {
    const url = `${ENDPOINT_BASE}/${encodeURIComponent(ip)}`;
    const resp = await axios.get(url, {
      params: { key: apiKey },
      timeout: CALL_TIMEOUT_MS,
      // Don't throw on 4xx - we want to read status from body
      validateStatus: () => true,
    });

    const data = resp.data;

    if (!data || typeof data !== 'object') {
      logger.warn('proxycheck_unexpected_body', { ip, status: resp.status });
      return null;
    }

    if (data.status && data.status !== 'ok') {
      // status='warning' or 'denied' - log and skip
      logger.warn('proxycheck_non_ok_status', {
        ip,
        status: data.status,
        message: data.message || null,
      });
      // Cache "no data" briefly so we don't hammer the API on errors
      cacheSet(ip, null);
      return null;
    }

    const ipData = data[ip];
    if (!ipData || typeof ipData !== 'object') {
      logger.warn('proxycheck_no_ip_data', { ip });
      return null;
    }

    const normalized = normalize(ip, ipData);
    cacheSet(ip, normalized);
    return { ...normalized, source: 'proxycheck' };
  } catch (err) {
    // axios timeout or network error
    logger.warn('proxycheck_lookup_failed', { ip, err: err.message, code: err.code });
    return null;
  }
}

function normalize(ip, raw) {
  const network = raw.network || {};
  const location = raw.location || {};
  const detections = raw.detections || {};

  // ASN comes back as "AS16276"; strip prefix and parse
  let asn = null;
  if (network.asn) {
    const m = String(network.asn).match(/(\d+)/);
    if (m) asn = Number(m[1]);
  }

  // Determine proxy verdict from individual detection booleans.
  // Order matters - we surface the most severe type when multiple are true.
  let isProxy = false;
  let proxyType = null;
  if (detections.tor) {
    isProxy = true;
    proxyType = 'TOR';
  } else if (detections.compromised) {
    isProxy = true;
    proxyType = 'COM';
  } else if (detections.vpn) {
    isProxy = true;
    proxyType = 'VPN';
  } else if (detections.proxy) {
    isProxy = true;
    proxyType = 'PUB';   // generic proxy
  } else if (detections.anonymous) {
    isProxy = true;
    proxyType = 'PUB';
  }

  return {
    ip,
    asn,
    asn_org: network.provider || null,
    organisation: network.organisation || null,
    country: location.country_code || null,
    country_name: location.country_name || null,
    region: location.region_name || null,
    city: location.city_name || null,
    type: network.type ? String(network.type).toLowerCase() : null,
    is_proxy: isProxy,
    proxy_type: proxyType,
    operator: raw.operator || null,
    risk_score: typeof detections.risk === 'number' ? detections.risk : 0,
    confidence: typeof detections.confidence === 'number' ? detections.confidence : 0,
    hosting: !!detections.hosting,
    scraper: !!detections.scraper,
    raw,
  };
}

function clearCache() {
  memCache.clear();
}

module.exports = { lookup, clearCache, normalize };
