/**
 * Dwell writeback — persists visit duration to the Click document.
 *
 * When a visitor leaves (explicit /lv/leave or stale sweep), the LivePresence
 * emitter fires a 'left' event with dwell_ms computed from arrived_at to
 * last_seen_at. This listener writes it back to the Click document so the
 * CIDR analyser can score blocks by average dwell time.
 *
 * Design:
 *   - Fire-and-forget: errors are logged but never block the presence system.
 *   - Debounced: writes are batched via setImmediate to avoid hammering Mongo
 *     during a sweep cycle (which can emit 50+ left events in one tick).
 *   - Idempotent: writing dwell_ms to the same click twice is harmless.
 */

'use strict';

const logger = require('./logger');

let pendingWrites = [];
let flushScheduled = false;

function flush() {
  flushScheduled = false;
  if (!pendingWrites.length) return;

  const batch = pendingWrites.splice(0, pendingWrites.length);

  // Lazy-require to avoid circular dependency at module load time
  const Click = require('../models').Click;
  if (!Click) return;

  // Use bulkWrite for efficiency during sweep flushes
  const ops = batch.map(({ click_id, dwell_ms }) => ({
    updateOne: {
      filter: { click_id },
      update: { $set: { dwell_ms } },
    },
  }));

  Click.bulkWrite(ops, { ordered: false }).catch(err => {
    logger.warn('dwell_writeback_error', { err: err.message, count: ops.length });
  });
}

function scheduleFlush() {
  if (!flushScheduled) {
    flushScheduled = true;
    setImmediate(flush);
  }
}

/**
 * Start listening to LivePresence events and writing dwell_ms back.
 * Call once at server startup.
 */
function startDwellWriteback(livePresence) {
  livePresence.on('event', (evt) => {
    if (evt.type !== 'left') return;
    const v = evt.visitor;
    if (!v || !v.click_id || v.dwell_ms == null) return;

    // Only write for 'offer' pages — safe/blocked pages are not real visits
    if (v.page_type !== 'offer') return;

    pendingWrites.push({
      click_id: v.click_id,
      dwell_ms: Math.max(0, Math.round(v.dwell_ms)),
    });
    scheduleFlush();
  });

  logger.info('dwell_writeback_started');
}

module.exports = { startDwellWriteback };
