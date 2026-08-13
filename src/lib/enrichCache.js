/**
 * enrichCache.js — shared cache for IP enrichment results (ProxyCheck + IPLocate).
 *
 * Redis-first, in-memory fallback (mirrors cache.js pattern). When Redis is
 * connected, enrichment results are stored there and shared across all
 * processes / workers / restarts. When Redis is unavailable, falls back to a
 * per-process in-memory LRU map (same behavior as before this change).
 *
 * This is the single biggest lever for the "slows down under heavy traffic"
 * problem: previously each uncached IP held a request open for ~3.5s on an
 * external API call, and the in-memory cache was per-process and lost on
 * restart. Moving to Redis means an IP looked up once stays cached for 6h
 * across all requests.
 */

'use strict';

const redis = require('./redisClient');
const logger = require('./logger');

const CACHE_TTL_SECONDS = 6 * 60 * 60;       // 6 hours (matches previous in-memory TTL)
const CACHE_KEY_PREFIX = 'enrich:';            // Redis key namespace
const MEM_MAX_SIZE = 50_000;                   // in-memory LRU cap (fallback)
const MEM_TTL_MS = CACHE_TTL_SECONDS * 1000;

// ── In-memory LRU fallback (same as before, used when Redis is down) ──────
const memCache = new Map();

function memGet(ip) {
  const entry = memCache.get(ip);
  if (!entry) return null;
  if (Date.now() - entry.ts > MEM_TTL_MS) { memCache.delete(ip); return null; }
  // Refresh LRU position
  memCache.delete(ip);
  memCache.set(ip, entry);
  return entry.data;
}

function memSet(ip, data) {
  if (memCache.size >= MEM_MAX_SIZE) {
    memCache.delete(memCache.keys().next().value);
  }
  memCache.set(ip, { data, ts: Date.now() });
}

function memClear() { memCache.clear(); }

// ── Redis-backed cache with automatic fallback ───────────────────────────

function isRedisReady() {
  try {
    const client = redis.getClient();
    return client && client.status === 'ready';
  } catch (_) {
    return false;
  }
}

/**
 * Get a cached enrichment result for an IP.
 * Tries Redis first; falls back to in-memory if Redis is down or misses.
 * @returns {object|null} the normalized enrichment data, or null for miss.
 */
async function get(ip) {
  if (!ip) return null;

  // Try Redis first
  if (isRedisReady()) {
    try {
      const raw = await redis.get(CACHE_KEY_PREFIX + ip);
      if (raw) {
        const parsed = JSON.parse(raw);
        // Also warm the in-memory cache so subsequent sync reads are fast
        memSet(ip, parsed);
        return parsed;
      }
    } catch (err) {
      logger.debug('enrich_cache_redis_get_err', { ip, err: err.message });
    }
  }

  // Fall back to in-memory
  return memGet(ip);
}

/**
 * Cache an enrichment result.
 * Writes to both Redis (if available) AND in-memory (so the current process
 * has it immediately without a Redis round-trip on the next read).
 */
async function set(ip, data) {
  if (!ip) return;

  // Always write to memory (fast local reads)
  memSet(ip, data);

  // Also write to Redis if available (shared, persistent)
  if (isRedisReady()) {
    try {
      await redis.set(CACHE_KEY_PREFIX + ip, JSON.stringify(data), CACHE_TTL_SECONDS);
    } catch (err) {
      logger.debug('enrich_cache_redis_set_err', { ip, err: err.message });
    }
  }
}

/**
 * Clear both caches. Used by tests and ipEnrich.clearCache().
 */
function clear() {
  memClear();
  // Don't mass-delete Redis keys here — TTL handles expiry naturally,
  // and KEYS/SCAN in production is dangerous. This clears in-memory only,
  // which is sufficient for tests and the rare manual reset.
}

module.exports = { get, set, clear, isRedisReady, CACHE_TTL_SECONDS };
