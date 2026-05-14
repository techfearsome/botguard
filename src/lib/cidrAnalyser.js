/**
 * CIDR Intelligence Analyser - rebuilt for the snapshot-and-correlate design.
 *
 * Two responsibilities:
 *
 *   1. Live state (CidrIntelligence) — updated every 60s by the worker loop.
 *      Reflects "what's been suspicious in the configured analysis window
 *      right now." Refreshed by a full window scan each run.
 *
 *   2. Daily snapshots (CidrDailySnapshot) — persistent record of CIDRs that
 *      triggered detection on a specific day. Written by the per-day grouping
 *      logic inside analyseWorkspace(). Survives forever for historical
 *      correlation.
 *
 * The full-window scan replaces the broken delta-cursor approach. At expected
 * scale (~2,600 allowed clicks/day) the scan completes in well under a second.
 * If volume grows 100x we revisit with incremental aggregation.
 *
 * The previous version had a `cursor` parameter that only processed clicks
 * since the last run - this caused the empty-table bug where each 60s batch
 * had too few clicks to cross any score threshold.
 */

'use strict';

const logger = require('./logger');
const { detectTriggers } = require('./cidrTriggers');

function getModels() {
  const { Click, CidrIntelligence, CidrDailySnapshot, Workspace } = require('../models');
  return { Click, CidrIntelligence, CidrDailySnapshot, Workspace };
}

// ── Fake UA detection ─────────────────────────────────────────────────────
// iOS versions above 18 don't exist as of 2026.
// User confirmed they run iOS-specific campaigns - iPhone UA dominance is
// EXPECTED, so we only flag impossible versions, not iOS in general.
const FAKE_UA_RE = /iPhone OS (1[9]|[2-9]\d)_|Android (1[5-9]|[2-9]\d)\.|HeadlessChrome|PhantomJS|Selenium|puppeteer|python-requests/i;

function isFakeUA(ua) {
  return ua && FAKE_UA_RE.test(ua);
}

// ── Subnet normalisation ──────────────────────────────────────────────────
function getSubnet(ip) {
  if (!ip) return null;
  try {
    if (ip.includes(':')) {
      const parts = ip.split(':');
      const prefix = parts.slice(0, 2).map(p => p || '0').join(':');
      return { cidr: `${prefix}::/32`, version: 'v6' };
    } else {
      const octets = ip.split('.');
      if (octets.length !== 4) return null;
      return { cidr: `${octets[0]}.${octets[1]}.${octets[2]}.0/24`, version: 'v4' };
    }
  } catch { return null; }
}

// ── Scoring (unchanged semantics, kept for the CidrIntelligence record) ──

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
  if (rate < 0.005) return 18;
  if (rate < 0.010) return 10;
  if (rate < 0.020) return 4;
  return 0;
}

function scoreRotation(hits, uniqueIPs) {
  if (uniqueIPs <= 1) {
    if (hits >= 30) return 20;
    if (hits >= 15) return 14;
    if (hits >= 8)  return 8;
    return 0;
  }
  let s = 0;
  if (uniqueIPs >= 100) s += 16;
  else if (uniqueIPs >= 50) s += 12;
  else if (uniqueIPs >= 20) s += 8;
  else if (uniqueIPs >= 10) s += 4;
  const hpi = hits / uniqueIPs;
  if (hpi >= 5) s += 4;
  else if (hpi >= 3) s += 2;
  return Math.min(s, 20);
}

function scoreUAUniformity(uaCounts, totalHits, fakeUACount) {
  if (totalHits < 3) return 0;
  const vals = Object.values(uaCounts);
  if (!vals.length) return 0;
  const top = Math.max(...vals);
  const dom = top / totalHits;
  let s = 0;
  if (dom >= 0.95) s += 12;
  else if (dom >= 0.85) s += 8;
  else if (dom >= 0.70) s += 4;
  if (fakeUACount > 0) s += Math.min(3, Math.ceil(fakeUACount / 5));
  return Math.min(s, 15);
}

function scorePersistence(priorDaysSeen, isReturning) {
  // Persistence is now driven by snapshot history, not by computing days
  // from the current window. Prior days seen = how many *previous* calendar
  // days this CIDR has been flagged in CidrDailySnapshot.
  let s = 0;
  if (priorDaysSeen >= 7)       s = 15;
  else if (priorDaysSeen >= 3)  s = 12;
  else if (priorDaysSeen >= 1)  s = 8;
  if (isReturning) s = Math.min(s + 2, 15);
  return s;
}

function scoreFakeUA(fakeUACount) {
  if (fakeUACount >= 10) return 5;
  if (fakeUACount >= 3)  return 4;
  if (fakeUACount >= 1)  return 2;
  return 0;
}

function computeConsecutiveDays(dates) {
  if (!dates.length) return 0;
  const sorted = [...new Set(dates)].sort();
  let max = 1, streak = 1;
  for (let i = 1; i < sorted.length; i++) {
    const a = new Date(sorted[i - 1]);
    const b = new Date(sorted[i]);
    const diff = Math.round((b - a) / (1000 * 60 * 60 * 24));
    if (diff === 1) {
      streak++;
      if (streak > max) max = streak;
    } else {
      streak = 1;
    }
  }
  return max;
}

// ── Main analysis ─────────────────────────────────────────────────────────

/**
 * Analyse a workspace's traffic over a time window.
 *
 * @param {ObjectId|string} workspaceId
 * @param {object} opts
 *   - windowHours    {number}  how far back to look (default 24)
 *   - windowStart    {Date}    explicit start (overrides windowHours)
 *   - windowEnd      {Date}    explicit end (defaults to now)
 *   - writeSnapshots {boolean} upsert CidrDailySnapshot docs (default true)
 *   - writeLiveState {boolean} upsert CidrIntelligence docs (default true).
 *                              Set false for ad-hoc past-range analysis so
 *                              live state isn't polluted by past patterns.
 * @returns {object} run statistics
 */
async function analyseWorkspace(workspaceId, opts = {}) {
  const { Click, CidrIntelligence, CidrDailySnapshot } = getModels();

  const windowHours = opts.windowHours || 24;
  const windowEnd = opts.windowEnd || new Date();
  const windowStart = opts.windowStart ||
    new Date(windowEnd.getTime() - windowHours * 60 * 60 * 1000);
  const writeSnapshots = opts.writeSnapshots !== false;
  const writeLiveState = opts.writeLiveState !== false;

  // ── Full-window scan (no cursor — re-evaluates every run) ───────────
  const clicks = await Click.find({
    workspace_id: workspaceId,
    decision: { $in: ['allow', 'would_block'] },
    ts: { $gte: windowStart, $lte: windowEnd },
  })
    .select('ip ts decision conversion_count user_agent asn_org country')
    .lean();

  if (!clicks.length) {
    return { processed: 0, subnets: 0, snapshots: 0, upserted: 0 };
  }

  // ── Aggregate by subnet AND by calendar day within the window ──────
  // Map<cidr, Map<date, perDayData>>
  const subnetDayMap = new Map();

  for (const c of clicks) {
    const sub = getSubnet(c.ip);
    if (!sub) continue;
    const ts = c.ts instanceof Date ? c.ts : new Date(c.ts);
    if (isNaN(ts)) continue;
    const date = ts.toISOString().slice(0, 10);

    let bySubnet = subnetDayMap.get(sub.cidr);
    if (!bySubnet) {
      bySubnet = new Map();
      subnetDayMap.set(sub.cidr, bySubnet);
    }
    let day = bySubnet.get(date);
    if (!day) {
      day = {
        clicks: [],
        uaCounts: {},
        fakeUACount: 0,
        conv: 0,
        asn: '',
        country: '',
        version: sub.version,
      };
      bySubnet.set(date, day);
    }

    day.clicks.push({ ts, ip: c.ip });
    day.conv += parseInt(c.conversion_count || 0, 10) || 0;
    day.asn = day.asn || c.asn_org || '';
    day.country = day.country || c.country || '';
    const ua = c.user_agent || '';
    day.uaCounts[ua] = (day.uaCounts[ua] || 0) + 1;
    if (isFakeUA(ua)) day.fakeUACount++;
  }

  // ── Per-day trigger detection + snapshot writes ────────────────────
  let snapshotsWritten = 0;
  const today = new Date().toISOString().slice(0, 10);

  if (writeSnapshots) {
    for (const [cidr, byDay] of subnetDayMap) {
      for (const [date, day] of byDay) {
        const trig = detectTriggers(day.clicks);
        if (!trig.qualifies) continue;

        await CidrDailySnapshot.updateOne(
          { workspace_id: workspaceId, cidr, date },
          {
            $set: {
              ip_version:             day.version,
              triggers:               trig.triggers,
              hits:                   trig.metrics.hits,
              unique_ips:             trig.metrics.unique_ips,
              conversions:            day.conv,
              max_burst_5min:         trig.metrics.max_burst_5min,
              rapid_duplicate_count:  trig.metrics.rapid_duplicate_count,
              single_ip_hammer_count: trig.metrics.single_ip_hammer_count,
              fake_ua_count:          day.fakeUACount,
              asn_org:                day.asn,
              country:                day.country,
            },
            $setOnInsert: {
              workspace_id: workspaceId,
              cidr,
              date,
              source: 'analyser',
            },
          },
          { upsert: true }
        );
        snapshotsWritten++;
      }
    }
  }

  // ── Build per-CIDR aggregates for the live state ───────────────────
  const cidrAggregate = new Map();
  for (const [cidr, byDay] of subnetDayMap) {
    const agg = {
      cidr,
      version: null,
      hits: 0,
      uniqueIps: new Set(),
      conv: 0,
      uaCounts: {},
      fakeUACount: 0,
      asn: '',
      country: '',
      sampleIps: new Set(),
    };
    for (const day of byDay.values()) {
      agg.version = day.version;
      agg.hits += day.clicks.length;
      for (const c of day.clicks) {
        agg.uniqueIps.add(c.ip);
        if (agg.sampleIps.size < 10) agg.sampleIps.add(c.ip);
      }
      agg.conv += day.conv;
      agg.fakeUACount += day.fakeUACount;
      agg.asn = agg.asn || day.asn;
      agg.country = agg.country || day.country;
      for (const [ua, n] of Object.entries(day.uaCounts)) {
        agg.uaCounts[ua] = (agg.uaCounts[ua] || 0) + n;
      }
    }
    cidrAggregate.set(cidr, agg);
  }

  // ── Look up snapshot history for all candidate CIDRs ───────────────
  const cidrs = [...cidrAggregate.keys()];
  let priorSnapshotMap = new Map();
  if (cidrs.length > 0) {
    const priorSnapshots = await CidrDailySnapshot.find({
      workspace_id: workspaceId,
      cidr: { $in: cidrs },
    })
      .select('cidr date source')
      .sort({ cidr: 1, date: 1 })
      .lean();

    for (const ps of priorSnapshots) {
      if (!priorSnapshotMap.has(ps.cidr)) {
        priorSnapshotMap.set(ps.cidr, { dates: [], sources: new Set() });
      }
      const entry = priorSnapshotMap.get(ps.cidr);
      entry.dates.push(ps.date);
      entry.sources.add(ps.source);
    }
  }

  // ── Upsert CidrIntelligence (live state) ───────────────────────────
  // Skipped when writeLiveState=false, used for ad-hoc past-range analysis
  // where we want to populate CidrDailySnapshot without overwriting the
  // current live view.
  let upserted = 0;
  const now = new Date();

  if (writeLiveState) {
  for (const [cidr, agg] of cidrAggregate) {
    const uniqueIps = agg.uniqueIps.size;
    const convRate = agg.hits > 0 ? agg.conv / agg.hits : 0;

    const history = priorSnapshotMap.get(cidr) || { dates: [], sources: new Set() };
    const priorDates = [...new Set(history.dates)].filter(d => d !== today).sort();
    const allDates   = [...new Set([...history.dates, today])].sort();
    const priorDaysSeen = priorDates.length;
    const totalDaysSeen = allDates.length;
    const isReturning   = priorDaysSeen >= 2;
    const isSeeded      = history.sources.has('seed');

    const signals = {
      volume:      scoreVolume(agg.hits),
      conversion:  scoreConversion(agg.hits, agg.conv),
      rotation:    scoreRotation(agg.hits, uniqueIps),
      ua_uniform:  scoreUAUniformity(agg.uaCounts, agg.hits, agg.fakeUACount),
      persistence: scorePersistence(priorDaysSeen, isReturning),
      fake_ua:     scoreFakeUA(agg.fakeUACount),
    };
    const score = Object.values(signals).reduce((a, b) => a + b, 0);

    // Only track subnets that score above min, OR that have history.
    // Low-score with history is still worth surfacing as "returning offender".
    if (score < 10 && !history.dates.length) continue;

    const topUAs = Object.entries(agg.uaCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([ua, count]) => ({ ua: ua.slice(0, 120), count }));

    await CidrIntelligence.updateOne(
      { workspace_id: workspaceId, cidr },
      {
        $set: {
          asn_org:               agg.asn,
          country:               agg.country,
          ip_version:            agg.version,
          score,
          signals,
          hit_count:             agg.hits,
          unique_ip_count:       uniqueIps,
          conversion_count:      agg.conv,
          conv_rate:             convRate,
          top_uas:               topUAs,
          sample_ips:            [...agg.sampleIps],
          fake_ua_count:         agg.fakeUACount,
          days_seen_count:       totalDaysSeen,
          consecutive_days:      computeConsecutiveDays(allDates),
          last_seen:             now,
          last_analysed_at:      now,
          analysis_window_hours: windowHours,
          historical_match: {
            has_history:     history.dates.length > 0,
            total_days_seen: totalDaysSeen,
            prior_days_seen: priorDaysSeen,
            first_seen_date: priorDates[0] || '',
            last_seen_date:  priorDates[priorDates.length - 1] || '',
            is_returning:    isReturning,
            is_seeded:       isSeeded,
          },
        },
        $setOnInsert: {
          workspace_id: workspaceId,
          cidr,
          first_seen:   now,
          status:       'new',
        },
      },
      { upsert: true }
    );
    upserted++;
  }
  }  // end if (writeLiveState)

  return {
    processed: clicks.length,
    subnets: subnetDayMap.size,
    snapshots: snapshotsWritten,
    upserted,
  };
}

// ── Worker loop ───────────────────────────────────────────────────────────

let workerRunning = false;

async function runAnalysis(opts = {}) {
  if (workerRunning) return;
  workerRunning = true;

  try {
    const { Workspace } = getModels();
    const workspaces = await Workspace.find().select('_id slug').lean();
    const windowHours = parseInt(
      opts.windowHours || process.env.CIDR_ANALYSIS_WINDOW_HOURS || '24', 10
    );

    let totalProcessed = 0, totalSnapshots = 0, totalUpserted = 0;

    for (const ws of workspaces) {
      const result = await analyseWorkspace(ws._id, { windowHours });
      totalProcessed += result.processed || 0;
      totalSnapshots += result.snapshots || 0;
      totalUpserted += result.upserted || 0;
    }

    if (totalProcessed > 0 || totalSnapshots > 0) {
      logger.info('cidr_analysis_run', {
        clicks_processed: totalProcessed,
        snapshots_written: totalSnapshots,
        intelligence_upserted: totalUpserted,
        window_hours: windowHours,
      });
    }
  } catch (err) {
    logger.warn('cidr_analysis_error', { err: err.message });
  } finally {
    workerRunning = false;
  }
}

function startCidrAnalyser() {
  const intervalSeconds = parseInt(
    process.env.CIDR_ANALYSIS_INTERVAL_SECONDS || '60', 10
  );
  logger.info('cidr_analyser_started', {
    interval_seconds: intervalSeconds,
    window_hours: process.env.CIDR_ANALYSIS_WINDOW_HOURS || 24,
  });
  runAnalysis();
  const timer = setInterval(runAnalysis, intervalSeconds * 1000);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = {
  startCidrAnalyser,
  runAnalysis,
  analyseWorkspace,
  getSubnet,
  isFakeUA,
  computeConsecutiveDays,
};
