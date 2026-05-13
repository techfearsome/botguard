/**
 * CIDR Intelligence Analyser
 *
 * Background worker that runs on a configurable interval, analyses recent
 * click traffic, scores subnets across 6 signals, and upserts results into
 * the CidrIntelligence collection for display in /admin/intelligence.
 *
 * Architecture:
 *   - Runs as a setInterval loop started once at server boot
 *   - Each run queries clicks since last_run cursor (delta only — fast)
 *   - Aggregates by /24 (IPv4) or /32 (IPv6)
 *   - Scores each subnet and upserts CidrIntelligence documents
 *   - Never blocks the request path — fire-and-forget from server.js
 *
 * Scoring signals (total max = 100):
 *   volume      0-20  hit count relative to time window
 *   conversion  0-25  zero/low conversion rate (strongest signal)
 *   rotation    0-20  many unique IPs per subnet = proxy pool
 *   ua_uniform  0-15  bots reuse same UA string
 *   persistence 0-15  same subnet across multiple days
 *   fake_ua     0-5   impossible iOS/Android versions (iOS 26+)
 *
 * Score thresholds:
 *   80-100  critical — strong recommendation to block
 *   60-79   high     — flag for review
 *   40-59   medium   — watch
 *   0-39    low      — clean (not surfaced in UI)
 */

'use strict';

const mongoose = require('mongoose');
const logger = require('./logger');

// Lazy-require models to avoid circular deps at startup
function getModels() {
  const { Click, CidrIntelligence, Workspace } = require('../models');
  return { Click, CidrIntelligence, Workspace };
}

// ── Fake UA detection ─────────────────────────────────────────────────────
// iOS versions above 18 don't exist as of 2026. Any UA claiming iOS 19+
// is definitively a bot. Zero false positive risk.
const FAKE_UA_RE = /iPhone OS (1[9-9]|[2-9]\d)_|Android (1[5-9]|[2-9]\d)\.|HeadlessChrome|PhantomJS|Selenium|puppeteer|python-requests/i;

function isFakeUA(ua) {
  return ua && FAKE_UA_RE.test(ua);
}

// ── Subnet normalizer ─────────────────────────────────────────────────────
function getSubnet(ip) {
  if (!ip) return null;
  try {
    if (ip.includes(':')) {
      // IPv6 — group at /32 (carrier allocation level)
      const parts = ip.split(':');
      // Take first 2 groups (32 bits) and zero the rest
      const prefix = parts.slice(0, 2).map(p => p || '0').join(':');
      return { cidr: `${prefix}::/32`, version: 'v6' };
    } else {
      // IPv4 — group at /24
      const octets = ip.split('.');
      return { cidr: `${octets[0]}.${octets[1]}.${octets[2]}.0/24`, version: 'v4' };
    }
  } catch {
    return null;
  }
}

// ── Scoring functions ─────────────────────────────────────────────────────

function scoreVolume(hits) {
  if (hits >= 200) return 20;
  if (hits >= 100) return 17;
  if (hits >= 50)  return 13;
  if (hits >= 20)  return 8;
  if (hits >= 10)  return 3;
  return 0;
}

function scoreConversion(hits, conversions) {
  if (hits < 5) return 0;
  if (conversions === 0) return hits >= 10 ? 25 : 12;
  const rate = conversions / hits;
  if (rate < 0.005) return 18;   // <0.5%
  if (rate < 0.010) return 10;   // <1.0%
  if (rate < 0.020) return 4;    // <2.0%
  return 0;
}

function scoreRotation(hits, uniqueIPs) {
  if (uniqueIPs <= 1) {
    // Single IP hammering
    if (hits >= 30) return 20;
    if (hits >= 15) return 14;
    if (hits >= 8)  return 8;
    return 0;
  }
  let score = 0;
  // Many unique IPs = proxy pool rotating
  if (uniqueIPs >= 100) score += 16;
  else if (uniqueIPs >= 50) score += 12;
  else if (uniqueIPs >= 20) score += 8;
  else if (uniqueIPs >= 10) score += 4;
  // High hits-per-IP = each address used multiple times
  const hitsPerIP = hits / uniqueIPs;
  if (hitsPerIP >= 5) score += 4;
  else if (hitsPerIP >= 3) score += 2;
  return Math.min(score, 20);
}

function scoreUAUniformity(uaCounts, totalHits, fakeUACount) {
  if (totalHits < 3) return 0;
  const values = Object.values(uaCounts);
  if (!values.length) return 0;
  const topCount = Math.max(...values);
  const dominance = topCount / totalHits;
  let score = 0;
  if (dominance >= 0.95) score += 12;
  else if (dominance >= 0.85) score += 8;
  else if (dominance >= 0.70) score += 4;
  // Fake UA hits contribute a small bonus here too
  if (fakeUACount > 0) score += Math.min(3, Math.ceil(fakeUACount / 5));
  return Math.min(score, 15);
}

function scorePersistence(daysSeenCount, consecutiveDays) {
  // Multi-day persistence is the strongest signal we have from your data.
  // Same subnet returning 3+ days in a row is almost certainly automated.
  let score = 0;
  if (daysSeenCount >= 5)       score += 15;
  else if (daysSeenCount >= 3)  score += 12;
  else if (daysSeenCount >= 2)  score += 8;
  // Consecutive days bonus
  if (consecutiveDays >= 3)     score += 3;
  else if (consecutiveDays >= 2) score += 1;
  return Math.min(score, 15);
}

function scoreFakeUA(fakeUACount) {
  if (fakeUACount >= 10) return 5;
  if (fakeUACount >= 3)  return 4;
  if (fakeUACount >= 1)  return 2;
  return 0;
}

function computeConsecutiveDays(daysList) {
  if (!daysList || daysList.length === 0) return 0;
  const sorted = [...new Set(daysList)].sort();
  let maxStreak = 1, streak = 1;
  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(sorted[i - 1]);
    const curr = new Date(sorted[i]);
    const diffDays = (curr - prev) / (1000 * 60 * 60 * 24);
    if (Math.round(diffDays) === 1) {
      streak++;
      maxStreak = Math.max(maxStreak, streak);
    } else {
      streak = 1;
    }
  }
  return maxStreak;
}

// ── Main analysis function ────────────────────────────────────────────────

/**
 * Run one analysis pass over clicks in the given time window.
 * @param {ObjectId} workspaceId
 * @param {number} windowHours - how many hours back to look (default 24)
 * @param {Date} cursor - only process clicks newer than this (for delta runs)
 * @returns {object} stats about this run
 */
async function analyseWorkspace(workspaceId, windowHours = 24, cursor = null) {
  const { Click, CidrIntelligence } = getModels();

  const windowStart = new Date(Date.now() - windowHours * 60 * 60 * 1000);

  // Build click query
  const query = {
    workspace_id: workspaceId,
    decision: { $in: ['allow', 'would_block'] },
    ts: { $gte: cursor || windowStart },
  };

  // Fetch clicks — only the fields we need for scoring
  const clicks = await Click.find(query)
    .select('ip ts decision conversion_count user_agent asn_org country')
    .lean();

  if (!clicks.length) return { processed: 0, upserted: 0 };

  // ── Aggregate by subnet ───────────────────────────────────────────────
  const subnetMap = new Map();

  for (const c of clicks) {
    const sub = getSubnet(c.ip);
    if (!sub) continue;

    if (!subnetMap.has(sub.cidr)) {
      subnetMap.set(sub.cidr, {
        cidr: sub.cidr,
        version: sub.version,
        hits: 0,
        ips: new Set(),
        conversions: 0,
        uaCounts: {},
        fakeUACount: 0,
        asn_org: '',
        country: '',
        days: new Set(),
        timestamps: [],
      });
    }

    const s = subnetMap.get(sub.cidr);
    s.hits++;
    s.ips.add(c.ip);
    s.conversions += parseInt(c.conversion_count || 0, 10);
    s.asn_org = s.asn_org || c.asn_org || '';
    s.country = s.country || c.country || '';

    const ua = c.user_agent || '';
    s.uaCounts[ua] = (s.uaCounts[ua] || 0) + 1;
    if (isFakeUA(ua)) s.fakeUACount++;

    // Track calendar days (UTC date string)
    if (c.ts) s.days.add(c.ts.toISOString().slice(0, 10));
    s.timestamps.push(c.ts);
  }

  // ── Load existing persistence data (days seen across ALL time) ────────
  const existingDocs = await CidrIntelligence.find({
    workspace_id: workspaceId,
    cidr: { $in: [...subnetMap.keys()] },
  }).select('cidr days_seen_list').lean();

  const existingDaysMap = new Map(existingDocs.map(d => [d.cidr, d.days_seen_list || []]));

  // ── Score and upsert ──────────────────────────────────────────────────
  let upserted = 0;
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  for (const [cidr, s] of subnetMap) {
    const uniqueIPs = s.ips.size;
    const convRate = s.hits > 0 ? s.conversions / s.hits : 0;

    // Merge today's days with historical days from DB
    const historicalDays = existingDaysMap.get(cidr) || [];
    const allDays = [...new Set([...historicalDays, ...s.days, today])].sort();
    const consecutiveDays = computeConsecutiveDays(allDays);

    // Compute signals
    const signals = {
      volume:      scoreVolume(s.hits),
      conversion:  scoreConversion(s.hits, s.conversions),
      rotation:    scoreRotation(s.hits, uniqueIPs),
      ua_uniform:  scoreUAUniformity(s.uaCounts, s.hits, s.fakeUACount),
      persistence: scorePersistence(allDays.length, consecutiveDays),
      fake_ua:     scoreFakeUA(s.fakeUACount),
    };

    const score = Object.values(signals).reduce((a, b) => a + b, 0);

    // Only track subnets that score above minimum threshold
    if (score < 20) continue;

    // Top UAs (max 5)
    const topUAs = Object.entries(s.uaCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([ua, count]) => ({ ua: ua.slice(0, 120), count }));

    // Sample IPs (first 10 unique)
    const sampleIPs = [...s.ips].slice(0, 10);

    await CidrIntelligence.updateOne(
      { workspace_id: workspaceId, cidr },
      {
        $set: {
          asn_org:              s.asn_org,
          country:              s.country,
          ip_version:           s.version,
          score,
          signals,
          hit_count:            s.hits,
          unique_ip_count:      uniqueIPs,
          conversion_count:     s.conversions,
          conv_rate:            convRate,
          top_uas:              topUAs,
          sample_ips:           sampleIPs,
          fake_ua_count:        s.fakeUACount,
          days_seen_count:      allDays.length,
          consecutive_days:     consecutiveDays,
          last_seen:            now,
          last_analysed_at:     now,
          analysis_window_hours: windowHours,
        },
        $setOnInsert: {
          workspace_id: workspaceId,
          cidr,
          first_seen:   now,
          status:       'new',
        },
        $addToSet: {
          days_seen_list: { $each: allDays },
        },
      },
      { upsert: true }
    );
    upserted++;
  }

  return { processed: clicks.length, subnets: subnetMap.size, upserted };
}

// ── Worker loop ───────────────────────────────────────────────────────────

let workerRunning = false;
let lastRunAt = null;

async function runAnalysis() {
  if (workerRunning) return;  // skip if previous run is still going
  workerRunning = true;

  try {
    const { Workspace } = getModels();
    const workspaces = await Workspace.find().select('_id slug').lean();

    const windowHours = parseInt(process.env.CIDR_ANALYSIS_WINDOW_HOURS || '24', 10);
    let totalProcessed = 0, totalUpserted = 0;

    for (const ws of workspaces) {
      const result = await analyseWorkspace(ws._id, windowHours, lastRunAt);
      totalProcessed += result.processed || 0;
      totalUpserted += result.upserted || 0;
    }

    if (totalProcessed > 0 || totalUpserted > 0) {
      logger.info('cidr_analysis_run', {
        clicks_processed: totalProcessed,
        subnets_upserted: totalUpserted,
        window_hours: windowHours,
      });
    }

    lastRunAt = new Date();
  } catch (err) {
    logger.warn('cidr_analysis_error', { err: err.message });
  } finally {
    workerRunning = false;
  }
}

/**
 * Start the background CIDR analysis worker.
 * Called once from server.js after Mongo connects.
 *
 * Interval configurable via CIDR_ANALYSIS_INTERVAL_SECONDS env var.
 * Default: 60 seconds.
 */
function startCidrAnalyser() {
  const intervalSeconds = parseInt(
    process.env.CIDR_ANALYSIS_INTERVAL_SECONDS || '60', 10
  );

  logger.info('cidr_analyser_started', {
    interval_seconds: intervalSeconds,
    window_hours: process.env.CIDR_ANALYSIS_WINDOW_HOURS || 24,
  });

  // Run immediately on start (catches up on any missed analysis)
  runAnalysis();

  // Then run on interval
  const timer = setInterval(runAnalysis, intervalSeconds * 1000);

  // Don't let this timer prevent Node from exiting on shutdown
  if (timer.unref) timer.unref();

  return timer;
}

module.exports = { startCidrAnalyser, runAnalysis, analyseWorkspace };
