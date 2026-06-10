/**
 * providers/index.js — Residential proxy detection provider router.
 *
 * Selects the appropriate provider adapter based on campaign config
 * and available API keys. Wraps the adapter call with a two-level cache
 * (in-memory LRU + MongoDB) to minimize API costs.
 *
 * Provider selection:
 *   - Campaign specifies a provider → use that one (if key is set)
 *   - Campaign says "auto" (default) → pick first configured provider
 *   - Priority order: ipgeolocation → spur → ipinfo
 *
 * ENV vars (set whichever providers you have):
 *   IPGEO_API_KEY     — ipgeolocation.io
 *   SPUR_API_TOKEN    — Spur
 *   IPINFO_TOKEN      — ipinfo.io
 */

'use strict';

const ipgeolocation = require('./ipgeolocation');
const spur = require('./spur');
const ipinfo = require('./ipinfo');
const logger = require('../logger');

const PROVIDERS = { ipgeolocation, spur, ipinfo };
const PROVIDER_PRIORITY = ['ipgeolocation', 'spur', 'ipinfo'];

// ── In-memory LRU cache ──────────────────────────────────────────────

const LRU_MAX = 2000;
const CLEAN_TTL_MS = 24 * 60 * 60 * 1000;
const FLAGGED_TTL_MS = 6 * 60 * 60 * 1000;
const memCache = new Map();

function memGet(key) {
  const entry = memCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) { memCache.delete(key); return null; }
  return entry.data;
}

function memSet(key, data, ttl) {
  if (memCache.size >= LRU_MAX) memCache.delete(memCache.keys().next().value);
  memCache.set(key, { data, expires: Date.now() + ttl });
}

// ── MongoDB cache ────────────────────────────────────────────────────

async function dbGet(ip, providerName) {
  try {
    const IpgeoCache = require('../../models/IpgeoCache');
    const doc = await IpgeoCache.findOne({ ip }).lean();
    if (doc && doc.provider === providerName && new Date(doc.expires_at) > new Date()) {
      return doc.cached_result ? JSON.parse(doc.cached_result) : null;
    }
  } catch (e) {}
  return null;
}

async function dbSet(ip, providerName, data) {
  const isFlagged = data.is_residential_proxy || data.is_vpn || data.is_proxy;
  const ttl = isFlagged ? FLAGGED_TTL_MS : CLEAN_TTL_MS;
  try {
    const IpgeoCache = require('../../models/IpgeoCache');
    await IpgeoCache.updateOne(
      { ip },
      { $set: {
        ip,
        provider: providerName,
        threat_score: data.threat_score || 0,
        is_proxy: !!data.is_proxy,
        is_residential_proxy: !!data.is_residential_proxy,
        is_vpn: !!data.is_vpn,
        is_tor: !!data.is_tor,
        is_relay: !!data.is_relay,
        is_cloud_provider: !!data.is_hosting,
        proxy_provider_names: data.proxy_provider_names || [],
        vpn_provider_names: data.vpn_provider_names || [],
        proxy_confidence_score: data.confidence || 0,
        proxy_last_seen: data.last_seen || '',
        cached_result: JSON.stringify(data),
        checked_at: new Date(),
        expires_at: new Date(Date.now() + ttl),
      }},
      { upsert: true }
    );
  } catch (e) {}
}

// ── Provider selection ───────────────────────────────────────────────

/**
 * Get the active provider adapter for a campaign.
 *
 * @param {string} preference — 'auto', 'ipgeolocation', 'spur', 'ipinfo'
 * @returns {{ adapter, name }|null}
 */
function resolveProvider(preference) {
  if (preference && preference !== 'auto') {
    const adapter = PROVIDERS[preference];
    if (adapter && adapter.isConfigured()) return { adapter, name: preference };
    return null; // Requested provider not configured
  }

  // Auto: pick first configured
  for (const name of PROVIDER_PRIORITY) {
    if (PROVIDERS[name].isConfigured()) return { adapter: PROVIDERS[name], name };
  }
  return null;
}

// ── Main lookup function ─────────────────────────────────────────────

/**
 * Check an IP against the configured residential proxy detection provider.
 *
 * @param {string} ip
 * @param {string} preference — 'auto', 'ipgeolocation', 'spur', 'ipinfo'
 * @returns {Promise<object|null>} — normalized result or null
 */
async function checkIP(ip, preference) {
  if (!ip) return null;

  const resolved = resolveProvider(preference || 'auto');
  if (!resolved) return null;

  const cacheKey = `${resolved.name}:${ip}`;

  // Layer 1: memory cache
  const mem = memGet(cacheKey);
  if (mem) return mem;

  // Layer 2: MongoDB cache
  const db = await dbGet(ip, resolved.name);
  if (db) {
    const isFlagged = db.is_residential_proxy || db.is_vpn || db.is_proxy;
    memSet(cacheKey, db, isFlagged ? FLAGGED_TTL_MS : CLEAN_TTL_MS);
    return db;
  }

  // Layer 3: API call
  const data = await resolved.adapter.checkIP(ip);
  if (!data) return null;

  const isFlagged = data.is_residential_proxy || data.is_vpn || data.is_proxy;
  memSet(cacheKey, data, isFlagged ? FLAGGED_TTL_MS : CLEAN_TTL_MS);
  await dbSet(ip, resolved.name, data);

  logger.info('resi_proxy_lookup', {
    ip, provider: resolved.name,
    is_residential_proxy: data.is_residential_proxy,
    threat_score: data.threat_score,
    providers: [...(data.proxy_provider_names || []), ...(data.vpn_provider_names || [])].join(', ') || 'none',
  });

  return data;
}

/**
 * Get info about configured providers for admin display.
 */
function getProviderInfo() {
  return {
    configured: PROVIDER_PRIORITY.filter(n => PROVIDERS[n].isConfigured()),
    available: PROVIDER_PRIORITY,
    details: PROVIDER_PRIORITY.map(n => ({
      name: n,
      configured: PROVIDERS[n].isConfigured(),
    })),
  };
}

module.exports = { checkIP, resolveProvider, getProviderInfo };
