const logger = require('./logger');

let client = null;
let connectAttempted = false;

function getClient() {
  if (connectAttempted) return client;
  connectAttempted = true;

  const url = process.env.REDIS_URL;
  if (!url) {
    logger.info('redis_disabled', { reason: 'no_url' });
    return null;
  }

  try {
    const Redis = require('ioredis');
    client = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      // If Redis goes down mid-flight, don't take down the whole request path
      retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 2000)),
    });

    client.on('error', (err) => {
      logger.warn('redis_error', { err: err.message });
    });
    client.on('connect', () => logger.info('redis_connected'));

    client.connect().catch((err) => {
      logger.warn('redis_connect_failed', { err: err.message });
      client = null;
    });

    return client;
  } catch (err) {
    logger.warn('redis_init_failed', { err: err.message });
    return null;
  }
}

/**
 * Increment a counter with a TTL. Returns the new value, or 0 if Redis is unavailable.
 * Safe to call even if Redis is down - we just lose rate-limiting for that request.
 */
async function incrWithTtl(key, ttlSeconds) {
  const c = getClient();
  if (!c || c.status !== 'ready') return 0;

  try {
    const pipeline = c.pipeline();
    pipeline.incr(key);
    pipeline.expire(key, ttlSeconds);
    const results = await pipeline.exec();
    return results?.[0]?.[1] || 0;
  } catch (err) {
    logger.warn('redis_incr_failed', { key, err: err.message });
    return 0;
  }
}

async function get(key) {
  const c = getClient();
  if (!c || c.status !== 'ready') return null;
  try { return await c.get(key); }
  catch (err) { return null; }
}

async function set(key, value, ttlSeconds) {
  const c = getClient();
  if (!c || c.status !== 'ready') return false;
  try {
    if (ttlSeconds) await c.set(key, value, 'EX', ttlSeconds);
    else await c.set(key, value);
    return true;
  } catch (err) { return false; }
}

module.exports = { getClient, incrWithTtl, get, set };
