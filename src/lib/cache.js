const redis = require('./redisClient');
const logger = require('./logger');

/**
 * Campaign / Workspace cache.
 *
 * Every /go/:slug request resolves:
 *   - Workspace by slug
 *   - Campaign by (workspace_id, slug)
 *
 * At high click rates these become hot Mongo queries. Caching them in Redis with
 * a short TTL keeps the hot path off Mongo for repeated traffic to the same campaign.
 *
 * Falls back to in-memory cache when Redis is unavailable, so local dev still works.
 *
 * Invalidation:
 *   - TTL-based by default (60s) - admin edits propagate within a minute
 *   - Explicit invalidate() called by admin routes when a campaign is updated
 *
 * Cache key format:
 *   bg:cache:ws:<slug>          → JSON workspace doc (lean)
 *   bg:cache:camp:<wsId>:<slug> → JSON campaign doc (lean, populated)
 */

const TTL_SECONDS = 60;
const memCache = new Map();
const MEM_MAX = 5000;

function memGet(key) {
  const e = memCache.get(key);
  if (!e) return null;
  if (Date.now() > e.expires) { memCache.delete(key); return null; }
  // LRU bump
  memCache.delete(key);
  memCache.set(key, e);
  return e.value;
}

function memSet(key, value, ttlSec) {
  if (memCache.size >= MEM_MAX) {
    const firstKey = memCache.keys().next().value;
    memCache.delete(firstKey);
  }
  memCache.set(key, { value, expires: Date.now() + ttlSec * 1000 });
}

async function getCached(key) {
  const client = redis.getClient();
  if (client && client.status === 'ready') {
    try {
      const raw = await redis.get(key);
      if (raw) return JSON.parse(raw);
    } catch (err) {
      logger.warn('cache_get_failed', { key, err: err.message });
    }
  }
  return memGet(key);
}

async function setCached(key, value, ttlSec = TTL_SECONDS) {
  const json = JSON.stringify(value);
  const client = redis.getClient();
  if (client && client.status === 'ready') {
    try {
      await redis.set(key, json, ttlSec);
    } catch (err) {
      logger.warn('cache_set_failed', { key, err: err.message });
    }
  }
  memSet(key, value, ttlSec);
}

async function invalidateCached(key) {
  const client = redis.getClient();
  if (client && client.status === 'ready') {
    try {
      const c = redis.getClient();
      await c.del(key);
    } catch (err) {
      logger.warn('cache_del_failed', { key, err: err.message });
    }
  }
  memCache.delete(key);
}

// ----- Workspace -----
async function getWorkspaceBySlug(slug, fetcher) {
  const key = `bg:cache:ws:${slug}`;
  const cached = await getCached(key);
  if (cached) return cached;
  const fresh = await fetcher();
  if (fresh) await setCached(key, fresh);
  return fresh;
}

async function invalidateWorkspace(slug) {
  await invalidateCached(`bg:cache:ws:${slug}`);
}

// ----- Campaign -----
async function getCampaignBySlug(workspaceId, slug, fetcher) {
  const key = `bg:cache:camp:${workspaceId}:${slug}`;
  const cached = await getCached(key);
  if (cached) return cached;
  const fresh = await fetcher();
  if (fresh) await setCached(key, fresh);
  return fresh;
}

async function invalidateCampaign(workspaceId, slug) {
  await invalidateCached(`bg:cache:camp:${workspaceId}:${slug}`);
}

// Clear all in-memory cache - mainly useful for tests
function clearAll() {
  memCache.clear();
}

module.exports = {
  getWorkspaceBySlug,
  getCampaignBySlug,
  invalidateWorkspace,
  invalidateCampaign,
  clearAll,
};
