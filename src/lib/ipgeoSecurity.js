/**
 * ipgeoSecurity.js — ipgeolocation.io IP Security API client.
 *
 * Second-layer proxy detection for residential proxies that ProxyCheck misses.
 * Each API call costs 2 credits, so caching is critical.
 *
 * Two-level cache:
 *   1. In-memory LRU (100ms lookups, no DB roundtrip for hot IPs)
 *   2. MongoDB (persists across restarts, TTL-based expiry)
 *
 * TTL strategy:
 *   - Clean IPs: 24h (stable — unlikely to become proxies overnight)
 *   - Flagged IPs: 6h (residential proxies rotate fast, need re-checking)
 *
 * ENV:
 *   IPGEO_API_KEY — API key from ipgeolocation.io (required to activate)
 */

'use strict';

const logger = require('./logger');

const API_BASE = 'https://api.ipgeolocation.io/v3/security';
const CLEAN_TTL_MS = 24 * 60 * 60 * 1000;   // 24 hours
const FLAGGED_TTL_MS = 6 * 60 * 60 * 1000;  // 6 hours
const LRU_MAX_SIZE = 2000;
const API_TIMEOUT_MS = 5000;

// ── In-memory LRU cache ──────────────────────────────────────────────

const memCache = new Map();

function memGet(ip) {
  const entry = memCache.get(ip);
  if (!entry) return null;
  if (Date.now() > entry.expires_at) {
    memCache.delete(ip);
    return null;
  }
  return entry.data;
}

function memSet(ip, data, ttlMs) {
  // Evict oldest if full
  if (memCache.size >= LRU_MAX_SIZE) {
    const oldest = memCache.keys().next().value;
    memCache.delete(oldest);
  }
  memCache.set(ip, { data, expires_at: Date.now() + ttlMs });
}

// ── API call ─────────────────────────────────────────────────────────

async function callApi(ip) {
  const apiKey = process.env.IPGEO_API_KEY;
  if (!apiKey) return null;

  const url = `${API_BASE}?apiKey=${apiKey}&ip=${encodeURIComponent(ip)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });
    clearTimeout(timeout);

    if (!res.ok) {
      logger.warn('ipgeo_api_error', { ip, status: res.status });
      return null;
    }

    const body = await res.json();

    // The /v3/security endpoint returns security fields at the top level
    return {
      threat_score:          body.threat_score || 0,
      is_proxy:              !!body.is_proxy,
      is_residential_proxy:  !!body.is_residential_proxy,
      is_vpn:                !!body.is_vpn,
      is_tor:                !!body.is_tor,
      is_relay:              !!body.is_relay,
      is_anonymous:          !!body.is_anonymous,
      is_bot:                !!body.is_bot,
      is_spam:               !!body.is_spam,
      is_known_attacker:     !!body.is_known_attacker,
      is_cloud_provider:     !!body.is_cloud_provider,
      proxy_provider_names:  body.proxy_provider_names || [],
      vpn_provider_names:    body.vpn_provider_names || [],
      cloud_provider_name:   body.cloud_provider_name || '',
      proxy_confidence_score: body.proxy_confidence_score || 0,
      proxy_last_seen:       body.proxy_last_seen || '',
      vpn_confidence_score:  body.vpn_confidence_score || 0,
      vpn_last_seen:         body.vpn_last_seen || '',
    };
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      logger.warn('ipgeo_api_timeout', { ip });
    } else {
      logger.warn('ipgeo_api_error', { ip, err: err.message });
    }
    return null;
  }
}

// ── Main lookup function ─────────────────────────────────────────────

/**
 * Check an IP against ipgeolocation.io's security API.
 *
 * Returns null if:
 *   - IPGEO_API_KEY is not set
 *   - API call fails or times out
 *
 * Returns the security data object otherwise, from cache or fresh API call.
 *
 * @param {string} ip
 * @returns {Promise<object|null>}
 */
async function checkIP(ip) {
  if (!ip || !process.env.IPGEO_API_KEY) return null;

  // Layer 1: in-memory cache
  const mem = memGet(ip);
  if (mem) return mem;

  // Layer 2: MongoDB cache
  let IpgeoCache;
  try {
    IpgeoCache = require('../models/IpgeoCache');
    const cached = await IpgeoCache.findOne({ ip }).lean();
    if (cached && new Date(cached.expires_at) > new Date()) {
      const data = extractData(cached);
      const isFlagged = data.is_proxy || data.is_residential_proxy || data.is_vpn;
      memSet(ip, data, isFlagged ? FLAGGED_TTL_MS : CLEAN_TTL_MS);
      return data;
    }
  } catch (e) {
    // DB error — continue to API call
  }

  // Layer 3: API call
  const data = await callApi(ip);
  if (!data) return null;

  const isFlagged = data.is_proxy || data.is_residential_proxy || data.is_vpn;
  const ttlMs = isFlagged ? FLAGGED_TTL_MS : CLEAN_TTL_MS;

  // Store in both caches
  memSet(ip, data, ttlMs);

  try {
    await IpgeoCache.updateOne(
      { ip },
      {
        $set: {
          ...data,
          ip,
          checked_at: new Date(),
          expires_at: new Date(Date.now() + ttlMs),
        },
      },
      { upsert: true }
    );
  } catch (e) {
    // DB write error — non-fatal, in-memory cache still has it
  }

  logger.info('ipgeo_lookup', {
    ip,
    threat_score: data.threat_score,
    is_residential_proxy: data.is_residential_proxy,
    is_vpn: data.is_vpn,
    is_proxy: data.is_proxy,
    providers: [...data.proxy_provider_names, ...data.vpn_provider_names].join(', ') || 'none',
  });

  return data;
}

/**
 * Extract clean data object from a MongoDB document.
 */
function extractData(doc) {
  return {
    threat_score:          doc.threat_score || 0,
    is_proxy:              !!doc.is_proxy,
    is_residential_proxy:  !!doc.is_residential_proxy,
    is_vpn:                !!doc.is_vpn,
    is_tor:                !!doc.is_tor,
    is_relay:              !!doc.is_relay,
    is_anonymous:          !!doc.is_anonymous,
    is_bot:                !!doc.is_bot,
    is_spam:               !!doc.is_spam,
    is_known_attacker:     !!doc.is_known_attacker,
    is_cloud_provider:     !!doc.is_cloud_provider,
    proxy_provider_names:  doc.proxy_provider_names || [],
    vpn_provider_names:    doc.vpn_provider_names || [],
    cloud_provider_name:   doc.cloud_provider_name || '',
    proxy_confidence_score: doc.proxy_confidence_score || 0,
    proxy_last_seen:       doc.proxy_last_seen || '',
    vpn_confidence_score:  doc.vpn_confidence_score || 0,
    vpn_last_seen:         doc.vpn_last_seen || '',
  };
}

/**
 * Get cache stats for admin display.
 */
function getCacheStats() {
  return {
    memory_size: memCache.size,
    memory_max: LRU_MAX_SIZE,
    api_key_set: !!process.env.IPGEO_API_KEY,
  };
}

/**
 * Clear all caches (for testing or when API key changes).
 */
async function clearCache() {
  memCache.clear();
  try {
    const IpgeoCache = require('../models/IpgeoCache');
    await IpgeoCache.deleteMany({});
  } catch (e) {}
}

module.exports = { checkIP, getCacheStats, clearCache };
