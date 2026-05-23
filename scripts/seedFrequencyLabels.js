/**
 * Backfill frequency labels onto existing CIDR records.
 *
 * Idempotent. Safe to run on every server boot. The operation:
 *
 *   1. Look at CidrIntelligence and CidrDailySnapshot collections.
 *   2. If there's no data at all → nothing to do, return early.
 *   3. If every record already has a frequency_label → nothing to do.
 *   4. Otherwise: walk records that have data (hits >= 1) but no label,
 *      compute the label from existing fields, write it back.
 *
 * NEVER overwrites a label that's already set. NEVER deletes anything.
 * Designed to run on the first deploy after the labels feature is added,
 * then become a no-op on subsequent boots.
 *
 * Exported as a function so it can be called from server.js bootstrap or
 * standalone via:  node scripts/seedFrequencyLabels.js
 */

'use strict';

const logger = require('../src/lib/logger');
const { computeFrequencyLabel } = require('../src/lib/cidrAnalyser');

async function seedFrequencyLabels(opts = {}) {
  const { dryRun = false, force = false } = opts;
  const { CidrIntelligence, CidrDailySnapshot } = require('../src/models');

  // Quick existence check — if collections are empty there's nothing to do.
  const [intelCount, snapCount] = await Promise.all([
    CidrIntelligence.estimatedDocumentCount(),
    CidrDailySnapshot.estimatedDocumentCount(),
  ]);
  if (intelCount === 0 && snapCount === 0) {
    logger.info('freq_label_seed_skipped', { reason: 'no_data' });
    return { processed: 0, intel_updated: 0, snap_updated: 0, skipped: true };
  }

  // Guard against re-running unnecessarily. If 95%+ of intel docs already
  // have a label, assume the seed has been done. `force: true` overrides
  // this to allow recomputation if the user explicitly asks.
  if (!force) {
    const intelLabelled = await CidrIntelligence.countDocuments({
      frequency_label: { $ne: null },
    });
    const ratio = intelCount > 0 ? intelLabelled / intelCount : 0;
    if (ratio >= 0.95 && intelCount > 0) {
      logger.info('freq_label_seed_skipped', {
        reason: 'already_labelled',
        intel_total: intelCount,
        intel_labelled: intelLabelled,
        ratio: Math.round(ratio * 1000) / 1000,
      });
      return { processed: 0, intel_updated: 0, snap_updated: 0, skipped: true };
    }
  }

  logger.info('freq_label_seed_starting', {
    intel_total: intelCount, snap_total: snapCount, dryRun, force,
  });

  // ── Step 1: snapshots ─────────────────────────────────────────────
  // Walk per-day snapshot rows missing frequency_label. Compute from the
  // snapshot's own metrics (single_day mode). This is fast — one find
  // query plus a bulk update.
  let snapUpdated = 0;
  const snapCursor = CidrDailySnapshot.find({
    frequency_label: null,
    hits: { $gte: 1 },
  }).cursor();

  const snapOps = [];
  for await (const s of snapCursor) {
    const adIds = (s.unique_gclids || 0) + (s.unique_wbraids || 0) +
                  (s.unique_gbraids || 0) + (s.unique_fbclids || 0) +
                  (s.unique_msclkids || 0);
    const evidence = {
      clicks:        s.hits || 0,
      unique_ad_ids: adIds,
      conversions:   s.conversions || 0,
    };
    const label = computeFrequencyLabel(evidence, 'single_day');
    snapOps.push({
      updateOne: {
        filter: { _id: s._id },
        update: { $set: {
          frequency_label: label,
          frequency_evidence: evidence,
        }},
      },
    });
    if (snapOps.length >= 500) {
      if (!dryRun) await CidrDailySnapshot.bulkWrite(snapOps, { ordered: false });
      snapUpdated += snapOps.length;
      snapOps.length = 0;
    }
  }
  if (snapOps.length > 0) {
    if (!dryRun) await CidrDailySnapshot.bulkWrite(snapOps, { ordered: false });
    snapUpdated += snapOps.length;
  }

  // ── Step 2: live intelligence ─────────────────────────────────────
  // For each unlabelled live record we compute the WINDOW label from its
  // own fields. The live record's hit_count covers the last analysis
  // window (typically 24h), so days_in_window = 1 effectively for backfill.
  // After the next analyser pass these will be overwritten with fresh
  // computations — backfill just gives us a non-null starting point.
  let intelUpdated = 0;
  const intelCursor = CidrIntelligence.find({
    frequency_label: null,
    hit_count: { $gte: 1 },
  }).cursor();

  const intelOps = [];
  for await (const r of intelCursor) {
    const adIds = (r.unique_gclids || 0) + (r.unique_wbraids || 0) +
                  (r.unique_gbraids || 0) + (r.unique_fbclids || 0) +
                  (r.unique_msclkids || 0);
    // Use historical_match.total_days_seen as a sensible days approximation
    // since the live record's hit_count is window-scoped. This means the
    // backfill labels reflect "how often we've seen this overall" which is
    // the closest approximation possible from existing fields.
    const days = r.historical_match?.total_days_seen || r.days_seen_count || 1;
    const evidence = {
      days_in_window:          days,
      clicks_in_window:        r.hit_count || 0,
      unique_ad_ids_in_window: adIds,
      conversions_in_window:   r.conversion_count || 0,
      window_hours:            r.analysis_window_hours || 24,
    };
    const label = computeFrequencyLabel({
      clicks:        r.hit_count || 0,
      unique_ad_ids: adIds,
      conversions:   r.conversion_count || 0,
      days,
    }, 'window');
    intelOps.push({
      updateOne: {
        filter: { _id: r._id },
        update: { $set: {
          frequency_label: label,
          frequency_evidence: evidence,
        }},
      },
    });
    if (intelOps.length >= 500) {
      if (!dryRun) await CidrIntelligence.bulkWrite(intelOps, { ordered: false });
      intelUpdated += intelOps.length;
      intelOps.length = 0;
    }
  }
  if (intelOps.length > 0) {
    if (!dryRun) await CidrIntelligence.bulkWrite(intelOps, { ordered: false });
    intelUpdated += intelOps.length;
  }

  logger.info('freq_label_seed_done', {
    intel_updated: intelUpdated, snap_updated: snapUpdated, dryRun,
  });
  return {
    processed: intelUpdated + snapUpdated,
    intel_updated: intelUpdated,
    snap_updated: snapUpdated,
    skipped: false,
  };
}

module.exports = { seedFrequencyLabels };

// Allow standalone invocation: `node scripts/seedFrequencyLabels.js`
if (require.main === module) {
  (async () => {
    require('dotenv').config();
    const mongoose = require('mongoose');
    await mongoose.connect(process.env.MONGO_URI);
    const args = process.argv.slice(2);
    const result = await seedFrequencyLabels({
      dryRun: args.includes('--dry-run'),
      force:  args.includes('--force'),
    });
    console.log(JSON.stringify(result, null, 2));
    await mongoose.disconnect();
    process.exit(0);
  })().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
