/**
 * iplocate.js — IPLocate.io enrichment provider, used as a FALLBACK for
 * ProxyCheck. Normalizes IPLocate's response into the exact same shape
 * proxycheck.normalize() returns, so the scoring chain and the Level 2 bot
 * guard read identical fields regardless of which provider served the lookup.
 *
 *   GET https://iplocate.io/api/lookup/<ip>?apikey=<key>
 *
 * IPLocate returns boolean privacy flags (is_proxy/is_vpn/is_tor/is_abuser/
 * is_hosting/is_icloud_relay) but NO numeric risk score, so we synthesize one:
 *   proxy | vpn | tor | abuser → 90   (configurable below)
 *   hosting                    → 50
 *   clean                      → 0
 * time_zone is IANA (e.g. "Asia/Tokyo"), which is what the bot guard needs.
 */

'use strict';

const axios = require('axios');
const logger = require('./logger');

const ENDPOINT_BASE = 'https://iplocate.io/api/lookup';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;   // 6h, mirrors proxycheck
const CACHE_MAX_SIZE = 50_000;
const CALL_TIMEOUT_MS = 3500;

// Synthesized risk scores (IPLocate has no numeric score of its own).
const RISK_ANONYMIZER = 90;   // proxy / vpn / tor / abuser
const RISK_HOSTING = 50;      // datacenter / hosting only
const RISK_CLEAN = 0;

const memCache = new Map();
function cacheGet(ip) {
  const entry = memCache.get(ip);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { memCache.delete(ip); return null; }
  return entry.data;
}
function cacheSet(ip, data) {
  if (memCache.size >= CACHE_MAX_SIZE) memCache.delete(memCache.keys().next().value);
  memCache.set(ip, { data, ts: Date.now() });
}

// Map an IPLocate response to ProxyCheck's normalized shape.
function normalize(ip, raw) {
  const asnObj = raw.asn || {};
  const privacy = raw.privacy || {};
  const company = raw.company || {};

  let asn = null;
  if (asnObj.asn) {
    const m = String(asnObj.asn).match(/(\d+)/);
    if (m) asn = Number(m[1]);
  }

  // Surface the most severe anonymizer type when several are true.
  let isProxy = false;
  let proxyType = null;
  if (privacy.is_tor) { isProxy = true; proxyType = 'TOR'; }
  else if (privacy.is_abuser) { isProxy = true; proxyType = 'COM'; }
  else if (privacy.is_vpn) { isProxy = true; proxyType = 'VPN'; }
  else if (privacy.is_proxy) { isProxy = true; proxyType = 'PUB'; }

  let risk = RISK_CLEAN;
  if (privacy.is_proxy || privacy.is_vpn || privacy.is_tor || privacy.is_abuser) risk = RISK_ANONYMIZER;
  else if (privacy.is_hosting) risk = RISK_HOSTING;

  // asn.name carries the network operator (e.g. "iproyal.com" residential-proxy
  // signal) — the more useful field for fraud than company.name, so it feeds
  // asn_org / operator just like ProxyCheck's provider does.
  const operatorName = asnObj.name || null;
  const operator = operatorName ? { name: operatorName, domain: asnObj.domain || null } : null;

  return {
    ip,
    asn,
    asn_org: asnObj.name || null,
    organisation: company.name || null,
    country: raw.country_code || null,
    country_name: raw.country || null,
    region: raw.subdivision || null,
    city: raw.city || null,
    timezone: raw.time_zone || null,   // IANA — used by the bot guard
    type: asnObj.type ? String(asnObj.type).toLowerCase() : null,
    is_proxy: isProxy,
    proxy_type: proxyType,
    operator,
    operator_name: operatorName,
    operator_anonymity: null,          // IPLocate doesn't expose anonymity level
    risk_score: risk,
    confidence: (isProxy || privacy.is_hosting) ? 90 : 0,
    hosting: !!privacy.is_hosting,
    scraper: !!privacy.is_crawler,
    is_icloud_relay: !!privacy.is_icloud_relay,  // extra signal (Apple Private Relay)
    raw,
  };
}

async function lookup(ip) {
  if (!ip) return null;

  const cached = cacheGet(ip);
  if (cached) return { ...cached, source: 'iplocate-cache' };

  const apiKey = process.env.IPLOCATE_API_KEY;
  if (!apiKey) {
    logger.debug('iplocate_no_key', { ip });
    return null;
  }

  try {
    const url = `${ENDPOINT_BASE}/${encodeURIComponent(ip)}`;
    const resp = await axios.get(url, {
      params: { apikey: apiKey },
      timeout: CALL_TIMEOUT_MS,
      validateStatus: () => true,
    });

    const data = resp.data;
    if (!data || typeof data !== 'object' || !data.ip) {
      logger.warn('iplocate_unexpected_body', { ip, status: resp.status });
      return null;
    }

    const normalized = normalize(ip, data);
    cacheSet(ip, normalized);
    return { ...normalized, source: 'iplocate' };
  } catch (err) {
    logger.warn('iplocate_lookup_failed', { ip, err: err.message, code: err.code });
    return null;
  }
}

function clearCache() { memCache.clear(); }

module.exports = { lookup, clearCache, normalize };
