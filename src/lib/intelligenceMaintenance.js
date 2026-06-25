/**
 * intelligenceMaintenance.js — Periodic housekeeping for CIDR intelligence.
 *
 * Two jobs run on a schedule (called from the analyser interval or a cron):
 *
 * 1. AUTO-ARCHIVE: CIDRs not seen in N days get archived to keep the active
 *    list focused on current threats. Archived entries are preserved (not
 *    deleted) so historical reports still work, but they drop out of the
 *    default "Active" view.
 *
 * 2. AUTO-ESCALATE: CIDRs seen consecutively for N+ days with a high score
 *    auto-promote to 'watchlist' status, surfacing persistent offenders that
 *    might otherwise sit in 'new' forever waiting for manual review.
 *
 * Both are configurable via the workspace's intelligence settings.
 */

'use strict';

const logger = require('./logger');

const DEFAULTS = {
  archive_after_days: 14,      // archive CIDRs not seen in this many days
  escalate_after_days: 5,       // consecutive days before auto-escalation
  escalate_min_score: 70,       // minimum score to auto-escalate
  enabled: true,
};

/**
 * Auto-archive stale CIDRs that haven't been seen recently.
 *
 * @param {ObjectId} workspaceId
 * @param {object} opts — { archive_after_days }
 * @returns {Promise<number>} count archived
 */
async function autoArchive(workspaceId, opts = {}) {
  const CidrIntelligence = require('../models/CidrIntelligence');
  const days = opts.archive_after_days || DEFAULTS.archive_after_days;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  // Archive CIDRs that:
  //   - haven't been seen since the cutoff
  //   - are in a "live" status (new/reviewing/watchlist) — NOT blocked/exported
  //     (those are intentional and should stay), NOT already dismissed/archived
  const result = await CidrIntelligence.updateMany(
    {
      workspace_id: workspaceId,
      last_seen: { $lt: cutoff },
      status: { $in: ['new', 'reviewing', 'watchlist'] },
    },
    {
      $set: { status: 'archived', archived_at: new Date() },
    }
  );

  if (result.modifiedCount > 0) {
    logger.info('intel_auto_archive', { workspace: workspaceId.toString(), archived: result.modifiedCount, cutoff_days: days });
  }
  return result.modifiedCount || 0;
}

/**
 * Auto-escalate persistent high-score offenders to watchlist.
 *
 * @param {ObjectId} workspaceId
 * @param {object} opts — { escalate_after_days, escalate_min_score }
 * @returns {Promise<number>} count escalated
 */
async function autoEscalate(workspaceId, opts = {}) {
  const CidrIntelligence = require('../models/CidrIntelligence');
  const minDays = opts.escalate_after_days || DEFAULTS.escalate_after_days;
  const minScore = opts.escalate_min_score || DEFAULTS.escalate_min_score;

  // Find CIDRs that have been consecutively active for N+ days with a high
  // score but are still sitting in 'new' or 'reviewing' (not yet acted on).
  const candidates = await CidrIntelligence.find({
    workspace_id: workspaceId,
    consecutive_days: { $gte: minDays },
    score: { $gte: minScore },
    status: { $in: ['new', 'reviewing'] },
    auto_escalated: { $ne: true },
  }).select('_id cidr score consecutive_days').lean();

  if (candidates.length === 0) return 0;

  const ids = candidates.map(c => c._id);
  await CidrIntelligence.updateMany(
    { _id: { $in: ids } },
    {
      $set: {
        status: 'watchlist',
        auto_escalated: true,
        auto_escalated_at: new Date(),
      },
    }
  );

  logger.info('intel_auto_escalate', {
    workspace: workspaceId.toString(),
    escalated: candidates.length,
    cidrs: candidates.map(c => c.cidr).slice(0, 5),
  });
  return candidates.length;
}

/**
 * Run all maintenance jobs for a workspace.
 *
 * @param {object} ws — workspace document (lean is fine)
 * @returns {Promise<{ archived: number, escalated: number }>}
 */
async function runMaintenance(ws) {
  const settings = ws.settings?.intelligence_maintenance || {};
  if (settings.enabled === false) return { archived: 0, escalated: 0 };

  const opts = {
    archive_after_days: settings.archive_after_days || DEFAULTS.archive_after_days,
    escalate_after_days: settings.escalate_after_days || DEFAULTS.escalate_after_days,
    escalate_min_score: settings.escalate_min_score || DEFAULTS.escalate_min_score,
  };

  let archived = 0, escalated = 0;
  try {
    archived = await autoArchive(ws._id, opts);
  } catch (e) {
    logger.warn('auto_archive_error', { err: e.message });
  }
  try {
    escalated = await autoEscalate(ws._id, opts);
  } catch (e) {
    logger.warn('auto_escalate_error', { err: e.message });
  }

  return { archived, escalated };
}

module.exports = { runMaintenance, autoArchive, autoEscalate, DEFAULTS };
