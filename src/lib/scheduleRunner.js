/**
 * scheduleRunner.js — reconciles campaign `status` with the ad schedule.
 *
 * Runs every minute (master process only when clustered). For each campaign
 * with `ad_schedule.enabled`:
 *
 *   Window OPEN  + status 'paused' → set 'active'   (activate)
 *   Window OPEN  + status 'active' → no-op          (already right)
 *   Window CLOSED + status 'active' → set 'paused'  (pause)
 *   Window CLOSED + status 'paused' → no-op         (already right)
 *
 * Idempotent: only writes when the state actually differs, so there's no
 * write churn and no log spam.
 *
 * NOTE: this job is for keeping the stored status (and therefore the admin UI
 * and any external integration) in sync. It is NOT the enforcement mechanism —
 * go.js evaluates the schedule on every request, so serving stays correct even
 * if this job misses a tick (deploy, restart, crash). The job is the
 * convenience layer; the serve-time check is the guarantee.
 *
 * 'archived' campaigns are never touched.
 */

'use strict';

const logger = require('./logger');
const { isInSchedule } = require('./campaignSchedule');

const TICK_MS = 60 * 1000; // check every minute

async function runTick() {
  try {
    const { Campaign } = require('../models');
    const cache = require('./cache');

    const campaigns = await Campaign.find({
      'ad_schedule.enabled': true,
      status: { $ne: 'archived' },
    }).select('name slug workspace_id status ad_schedule').lean();

    if (!campaigns.length) return;

    const now = new Date();
    let activated = 0, paused = 0;

    for (const c of campaigns) {
      const verdict = isInSchedule(c.ad_schedule, now);
      const nowOpen = verdict.inSchedule;
      const wasOpen = c.ad_schedule.last_window_state;

      // First time we've seen this campaign (or after an edit) — record the
      // current window state without touching status, so we don't stomp a
      // deliberate manual setting on the very first tick.
      if (wasOpen === null || wasOpen === undefined) {
        await Campaign.updateOne({ _id: c._id },
          { $set: { 'ad_schedule.last_window_state': nowOpen } });
        continue;
      }

      // No boundary crossed → leave status alone. This is what lets a manual
      // pause (or resume) mid-window persist instead of being reverted.
      if (wasOpen === nowOpen) continue;

      // ── Boundary crossed ────────────────────────────────────────────────
      const isActive = c.status === 'active';
      const update = { 'ad_schedule.last_window_state': nowOpen };

      if (nowOpen && !isActive) {
        // Window just OPENED and campaign is paused → activate.
        update.status = 'active';
        activated++;
        logger.info('schedule_activated', { campaign: c.name, slug: c.slug });
      } else if (!nowOpen && isActive) {
        // Window just CLOSED and campaign is active → pause.
        update.status = 'paused';
        paused++;
        logger.info('schedule_paused', { campaign: c.name, slug: c.slug });
      }
      // else: boundary crossed but campaign already in the desired state
      // (e.g. user manually paused during the window) → just record the state.

      await Campaign.updateOne({ _id: c._id }, { $set: update });
      await cache.invalidateCampaign(c.workspace_id, c.slug).catch(() => {});
    }

    if (activated || paused) {
      logger.info('schedule_tick_applied', { activated, paused, checked: campaigns.length });
    }
  } catch (err) {
    logger.error('schedule_tick_failed', { err: err.message });
  }
}

function startScheduleRunner() {
  // Run once at boot so a restart immediately corrects any drift that happened
  // while the process was down.
  runTick().catch(() => {});
  const timer = setInterval(runTick, TICK_MS);
  if (timer.unref) timer.unref();
  logger.info('schedule_runner_started', { interval_ms: TICK_MS });
  return timer;
}

module.exports = { startScheduleRunner, runTick };
