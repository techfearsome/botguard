/**
 * liveSync.js — synchronises LivePresence across cluster workers via Redis
 * pub/sub. Without this, each worker's in-memory visitor Map only sees the
 * visitors whose requests it handled (~1/N of total), so the admin live
 * dashboard shows incomplete data.
 *
 * How it works:
 *   - When a worker records an arrival, heartbeat, conversion, or departure,
 *     it publishes the event to a Redis channel.
 *   - Every worker subscribes to that channel. On receiving an event from
 *     *another* worker, it replays the event into its own LivePresence
 *     instance (without re-publishing, to avoid loops).
 *   - The admin SSE connection (which lands on one worker) now sees the
 *     complete set of visitors.
 *
 * Requires ioredis (already a dependency). Uses a dedicated subscriber
 * connection (ioredis requirement: a client in subscribe mode can't do
 * other commands). Falls back gracefully if Redis is unavailable — each
 * worker still tracks its own visitors locally (pre-clustering behavior).
 */

'use strict';

const cluster = require('cluster');
const logger = require('./logger');

const CHANNEL = 'botguard:live_sync';
let pub = null;
let sub = null;
let localLive = null;
let enabled = false;

// Worker ID used to ignore self-published messages.
const WORKER_ID = cluster.isWorker ? String(cluster.worker.id) : 'master';

function getRedisUrl() {
  return process.env.REDIS_URL || process.env.REDIS_URI || null;
}

/**
 * Start the sync layer. Call once per worker after LivePresence is ready.
 * @param {LivePresence} live — the singleton LivePresence instance.
 */
function start(live) {
  localLive = live;
  const url = getRedisUrl();
  if (!url) {
    logger.debug('live_sync_disabled', { reason: 'no_redis_url' });
    return;
  }

  try {
    const Redis = require('ioredis');

    // Publisher: reuse the main client if available, or create a new one.
    const redisClient = require('./redisClient');
    const existing = redisClient.getClient();
    if (existing && existing.status === 'ready') {
      pub = existing;
    } else {
      pub = new Redis(url, { maxRetriesPerRequest: 1, enableReadyCheck: false, lazyConnect: true });
      pub.connect().catch(() => {});
    }

    // Subscriber: must be a SEPARATE connection (ioredis pub/sub requirement).
    sub = new Redis(url, { maxRetriesPerRequest: 1, enableReadyCheck: false, lazyConnect: true });
    sub.connect().catch(() => {});

    sub.subscribe(CHANNEL, (err) => {
      if (err) {
        logger.warn('live_sync_subscribe_failed', { err: err.message });
        return;
      }
      enabled = true;
      logger.info('live_sync_started', { worker: WORKER_ID });
    });

    sub.on('message', (channel, message) => {
      if (channel !== CHANNEL) return;
      try {
        const evt = JSON.parse(message);
        // Ignore our own messages to avoid loops.
        if (evt._worker === WORKER_ID) return;
        replay(evt);
      } catch (_) { /* malformed message — skip */ }
    });

    // Hook into LivePresence events to broadcast.
    live.on('event', (evt) => broadcast(evt));
    live.on('daily_stats', (evt) => broadcast({ ...evt, type: 'daily_stats' }));
  } catch (err) {
    logger.warn('live_sync_init_failed', { err: err.message });
  }
}

function broadcast(evt) {
  if (!enabled || !pub) return;
  try {
    const msg = JSON.stringify({ ...evt, _worker: WORKER_ID });
    pub.publish(CHANNEL, msg).catch(() => {});
  } catch (_) { /* best-effort */ }
}

/**
 * Replay a remote worker's event into our local LivePresence without
 * re-emitting (which would re-broadcast and loop).
 */
function replay(evt) {
  if (!localLive) return;

  switch (evt.type) {
    case 'arrived':
    case 'updated':
      if (evt.visitor) {
        // Directly set the visitor in the Map (bypass arrived() which would
        // re-emit and re-broadcast).
        localLive.visitors.set(evt.visitor.click_id, evt.visitor);
      }
      break;

    case 'heartbeat':
      if (evt.visitor && evt.visitor.click_id) {
        const v = localLive.visitors.get(evt.visitor.click_id);
        if (v) {
          v.last_seen_at = evt.visitor.last_seen_at || Date.now();
        } else {
          // We didn't have this visitor — add them (they arrived on another worker).
          localLive.visitors.set(evt.visitor.click_id, evt.visitor);
        }
      }
      break;

    case 'converted':
      if (evt.visitor && evt.visitor.click_id) {
        const v = localLive.visitors.get(evt.visitor.click_id);
        if (v) {
          v.converted = true;
          v.converted_at = evt.visitor.converted_at || Date.now();
          v.conversion_term = evt.visitor.conversion_term || null;
          v.conversion_text = evt.visitor.conversion_text || null;
          v.conversion_href = evt.visitor.conversion_href || null;
          v.last_seen_at = evt.visitor.last_seen_at || Date.now();
        }
      }
      // Bump the daily counter on this worker too.
      if (evt.visitor && evt.visitor.workspace_id) {
        const bucket = localLive._getDailyBucket(String(evt.visitor.workspace_id));
        bucket.conversions += 1;
        const globalBucket = localLive._getDailyBucket('global');
        globalBucket.conversions += 1;
      }
      break;

    case 'left':
      if (evt.visitor && evt.visitor.click_id) {
        localLive.visitors.delete(evt.visitor.click_id);
      }
      break;

    case 'daily_stats':
      // Another worker's daily counter changed — sync it.
      if (evt.workspace_id && evt.conversions_today != null) {
        const bucket = localLive._getDailyBucket(String(evt.workspace_id));
        // Take the max to avoid races where two workers both increment.
        if (evt.conversions_today > bucket.conversions) {
          bucket.conversions = evt.conversions_today;
        }
      }
      break;
  }
}

function stop() {
  if (sub) { try { sub.unsubscribe(); sub.disconnect(); } catch (_) {} sub = null; }
  enabled = false;
}

module.exports = { start, stop, broadcast, CHANNEL };
