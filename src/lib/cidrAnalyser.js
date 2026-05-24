/**
 * CIDR Intelligence Analyser v2.1 — block-level dossier model.
 *
 * KEY CHANGE FROM v1: every block that sends 2+ hits with 0 conversions
 * gets a persistent dossier (CidrIntelligence record + CidrDailySnapshot).
 * Scoring runs against the FULL accumulated history, not just the current
 * 60-second or 24-hour window. Weak signals compound over days.
 *
 * 12 scoring signals (max raw 145, capped at 100):
 *
 *   Signal         Max   Source
 *   ─────────────  ────  ───────────────────────────────────────────
 *   volume          15   Raw hit count
 *   conversion      20   Zero/near-zero conversion on 5+ hits
 *   rotation        20   IP rotation or single-IP hammer
 *   ua_uniform      15   UA dominance + fake UA
 *   persistence     15   Multi-day recurrence from snapshots
 *   fake_ua          5   Impossible versions, headless browsers
 *   click_id        15   Missing/replayed click IDs
 *   temporal        20   Sub-second/sub-5s bursts
 *   webview_ua      10   Reordered WebView UA tokens
 *   behavioral      10   Same-IP+UA repeat, low UA diversity
 *   slow_drip       10   Same IP returning across separate sessions
 *   known_list      15   Cross-reference seeded/exported/blocked status
 */

'use strict';

const logger = require('./logger');
const { detectTriggers, isWebViewBot } = require('./cidrTriggers');

function getModels() {
  const { Click, CidrIntelligence, CidrDailySnapshot, Workspace } = require('../models');
  return { Click, CidrIntelligence, CidrDailySnapshot, Workspace };
}

// ── Fake UA detection ────────────────────────────────────────────────
const FAKE_UA_RE = /iPhone OS (1[9]|[2-9]\d)_|Android (1[5-9]|[2-9]\d)\.|HeadlessChrome|PhantomJS|Selenium|puppeteer|python-requests/i;
function isFakeUA(ua) { return ua && FAKE_UA_RE.test(ua); }

// ── Frequency grading ─────────────────────────────────────────────────
//
// Independent of score. Score says "how confident are we"; frequency says
// "how often does this CIDR cause us pain." A CIDR can score 90 with one
// day of activity (label LOW), or score 40 with sustained multi-day pulses
// (label MEDIUM). Operators want both signals: confidence + pain.
//
// Two evaluation modes:
//
//   single_day — Used when scoring one calendar day in isolation. Lower
//                thresholds because a single day is a smaller observation
//                window. This is what gets stored on each CidrDailySnapshot.
//
//   window     — Used when aggregating across multiple days. Adds a
//                days_active requirement that single_day can't have (the
//                whole point of multi-day analysis is persistence). This
//                is what gets stored on CidrIntelligence using the live
//                worker's window (typically 24h, so days_in_window=1 and
//                the days check effectively reduces to "today"). For
//                past-range views, the route handler computes this on
//                the fly against snapshot aggregates.
//
// Calibration: thresholds came from empirical analysis of the TechFirio
// click data (May 17-23). At these levels the HIGH bucket stays small
// (~5/day single-day, ~6 over 7 days window) and clean enough to act on
// without case-by-case review. MEDIUM is a "review then decide" tier of
// ~27/day single-day, ~80/week window. LOW is the watchlist tier.
//
// All three conditions must hold (AND, not OR). A CIDR with 6 days
// but only 1 click each day stays in LOW because the click bar isn't met.
const LABEL_THRESHOLDS = {
  single_day: {
    high:   { clicks: 5, unique_ad_ids: 4 },
    medium: { clicks: 3, unique_ad_ids: 2 },
    low:    { clicks: 2, unique_ad_ids: 0 },
  },
  window: {
    high:   { days: 3, clicks: 6, unique_ad_ids: 4 },
    medium: { days: 2, clicks: 3, unique_ad_ids: 2 },
    low:    { days: 1, clicks: 2, unique_ad_ids: 0 },
  },
};

// Window mode requires days >= 3 for HIGH and days >= 2 for MED. When the
// caller's window observation is shorter than that (the 24h live worker
// almost always has days=1, sometimes days=2 across midnight; the yesterday
// snapshot view aggregates exactly 1 day), the days gate makes HIGH/MED
// structurally unreachable and every abusive CIDR silently demotes to LOW.
// In that situation fall through to single_day thresholds, which evaluate
// the same click/ad-id evidence without the multi-day persistence gate.
const WINDOW_PERSISTENCE_DAYS = 3;

/**
 * Assign a frequency label given evidence numbers.
 *
 * @param {object} ev   - {clicks, unique_ad_ids, conversions, days?}
 * @param {string} mode - 'single_day' | 'window'
 * @returns {'high'|'medium'|'low'|null}
 *
 * Conversions > 0 always returns null — converting traffic isn't an abuser
 * regardless of frequency.
 */
function computeFrequencyLabel(ev, mode) {
  if (ev.conversions > 0) return null;
  let activeMode = mode;
  if (mode === 'window' && (ev.days || 0) < WINDOW_PERSISTENCE_DAYS) {
    activeMode = 'single_day';
  }
  const T = LABEL_THRESHOLDS[activeMode];
  if (!T) return null;
  const meets = (lbl) => {
    const t = T[lbl];
    if (ev.clicks < t.clicks) return false;
    if (ev.unique_ad_ids < t.unique_ad_ids) return false;
    if (activeMode === 'window' && (ev.days || 0) < t.days) return false;
    return true;
  };
  if (meets('high'))   return 'high';
  if (meets('medium')) return 'medium';
  if (meets('low'))    return 'low';
  return null;
}


// ── Subnet normalisation ────────────────────────────────────────────
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

// ══════════════════════════════════════════════════════════════════════
// SCORING FUNCTIONS
// ══════════════════════════════════════════════════════════════════════

function scoreVolume(hits) {
  if (hits >= 200) return 15;
  if (hits >= 100) return 13;
  if (hits >= 50)  return 10;
  if (hits >= 20)  return 6;
  if (hits >= 10)  return 2;
  return 0;
}

function scoreConversion(hits, conversions) {
  if (hits < 5) return 0;
  if (conversions === 0) return hits >= 10 ? 20 : 10;
  const rate = conversions / hits;
  if (rate < 0.005) return 15;
  if (rate < 0.010) return 8;
  if (rate < 0.020) return 3;
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

function scoreClickIdSignal(hits, totalUniqueIds, hitsWithNoClickId) {
  // Lowered threshold from 10 to 3 hits. Most CIDRs in TechFirio's traffic
  // log 3-9 hits per analysis window, so the 10-hit gate kept this signal
  // silent across the entire dossier (0/168 in the May-24 export). Lower
  // tier scores half-strength so the gate-jump from 0→full doesn't create
  // a sudden score spike at the 10-hit boundary.
  if (hits < 3) return 0;
  const noIdRatio = hitsWithNoClickId / hits;
  const hitsWithId = hits - hitsWithNoClickId;
  let score = 0;

  // Missing-click-id ratio — bots often strip or never fetch the gclid,
  // landing on the page with no attribution. Real ad clicks always carry one.
  if (hits >= 10) {
    if (noIdRatio >= 0.90)      score += 12;
    else if (noIdRatio >= 0.70) score += 8;
    else if (noIdRatio >= 0.50) score += 4;
  } else {
    // 3-9 hit tier: gated half-strength so a 3-hit CIDR with all-missing IDs
    // doesn't score the same as a 30-hit CIDR with all-missing IDs.
    if (noIdRatio >= 0.90)      score += 6;
    else if (noIdRatio >= 0.70) score += 4;
    else if (noIdRatio >= 0.50) score += 2;
  }

  // Click-id diversity — many gclids from one block with no conversion is the
  // classic bot-farm pattern (different ad clicks all routing through the
  // same network).
  if (hitsWithId >= 10) {
    const diversity = totalUniqueIds / hitsWithId;
    if (diversity < 0.30)      score += 8;
    else if (diversity < 0.50) score += 4;
    else if (diversity < 0.70) score += 2;
  } else if (hitsWithId >= 3) {
    // 3-9 hit tier: HIGH diversity (lots of distinct ad IDs from few hits)
    // is the stronger pattern, not low diversity. A small block producing
    // many gclids = bot farm. Inverts the >=10 logic deliberately.
    const distinct = totalUniqueIds;
    if (distinct >= hitsWithId)     score += 6;  // every hit a new ad ID
    else if (distinct >= hitsWithId * 0.7) score += 4;
    else if (distinct >= 2)         score += 2;
  }

  return Math.min(score, 15);
}

// ── Historical click-id signal (0–12) ────────────────────────────────
//
// Uses prior CidrDailySnapshot rows to spot CIDRs that have produced many
// distinct ad-click IDs across multiple days WITHOUT converting. This is
// the signal "this network has clicked dozens of different ads in the past
// week, never bought anything" — the closest direct read of bot-farm
// behaviour available from already-collected data.
//
// Why a separate signal from the live click_id one: the live signal only
// sees the current 24h window. A CIDR with 3 hits today and 20 hits across
// the last 7 days are very different threats — this signal makes the
// difference visible in the score.
function scoreHistoricalClickIds(history) {
  // history = { total_ad_ids_prior, total_clicks_prior, total_conv_prior, days_with_activity }
  if (!history) return 0;
  const ids   = history.total_ad_ids_prior || 0;
  const conv  = history.total_conv_prior || 0;
  const days  = history.days_with_activity || 0;
  // Any prior conversion neutralises this signal — converting CIDRs aren't
  // abusers, full stop.
  if (conv > 0) return 0;

  if (ids >= 12 && days >= 5) return 12;
  if (ids >= 8  && days >= 3) return 10;
  if (ids >= 5  && days >= 2) return 6;
  if (ids >= 3  && days >= 2) return 3;
  return 0;
}

// ── Frequency-label feedback (0–10) ──────────────────────────────────
//
// Feeds the frequency_label back into the score. Keeps the weights small
// so this can tilt ranking without dominating — score is still driven
// primarily by the signal evidence. The point of including it is to
// surface MEDIUM/HIGH frequency CIDRs near the top of the Critical bucket
// even when their per-window evidence is split across signals that each
// stay below their full-strength tier.
function scoreFrequencyLabel(label) {
  if (label === 'high')   return 10;
  if (label === 'medium') return 5;
  if (label === 'low')    return 2;
  return 0;
}

// ── Temporal burst scoring (0–20) ────────────────────────────────────
function scoreTemporal(subSecondCount, sub5sCount, minGapMs) {
  let s = 0;
  if (subSecondCount >= 10)     s += 12;
  else if (subSecondCount >= 5) s += 10;
  else if (subSecondCount >= 3) s += 8;
  else if (subSecondCount >= 1) s += 5;
  const sub5sOnly = sub5sCount - subSecondCount;
  if (sub5sOnly >= 10)     s += 8;
  else if (sub5sOnly >= 5) s += 6;
  else if (sub5sOnly >= 3) s += 4;
  else if (sub5sOnly >= 1) s += 2;
  return Math.min(s, 20);
}

// ── WebView UA scoring (0–10) ────────────────────────────────────────
function scoreWebViewUA(webviewBotCount, totalHits) {
  if (webviewBotCount === 0) return 0;
  const ratio = webviewBotCount / totalHits;
  if (ratio >= 0.50) return 10;
  if (ratio >= 0.20) return 7;
  if (webviewBotCount >= 3) return 5;
  if (webviewBotCount >= 1) return 3;
  return 0;
}

// ── Behavioral compound scoring (0–10) ───────────────────────────────
function scoreBehavioral(sameIpUaRepeats, uaDiversityRatio, totalHits) {
  if (totalHits < 3) return 0;
  let s = 0;
  if (sameIpUaRepeats >= 5)      s += 5;
  else if (sameIpUaRepeats >= 3) s += 4;
  else if (sameIpUaRepeats >= 1) s += 2;
  if (uaDiversityRatio <= 0.20)      s += 5;
  else if (uaDiversityRatio <= 0.40) s += 3;
  else if (uaDiversityRatio <= 0.60) s += 1;
  return Math.min(s, 10);
}

// ── IP-return scoring (0–10) — tiered by gap duration ────────────────
// Replaces the old slow_drip signal. Now covers 1min–30min+ returns.
// Tier 1 (1-5min) returns score less than tier 3 (30min+) because
// 1-5min could be a real re-click, but 30min+ is definitively bot.
function scoreIpReturn(tier1, tier2, tier3, returnIps, hitsPerIp) {
  const totalReturns = tier1 + tier2 + tier3;
  if (totalReturns === 0) return 0;
  let s = 0;
  // Tier 3 (30min+ slow drip) — strongest signal (max 5)
  if (tier3 >= 5) s += 5;
  else if (tier3 >= 3) s += 4;
  else if (tier3 >= 1) s += 3;
  // Tier 2 (5-30min mid-return) — strong signal (max 4)
  if (tier2 >= 5) s += 4;
  else if (tier2 >= 3) s += 3;
  else if (tier2 >= 1) s += 2;
  // Tier 1 (1-5min reclick) — moderate signal (max 3)
  if (tier1 >= 5) s += 3;
  else if (tier1 >= 3) s += 2;
  else if (tier1 >= 1) s += 1;
  // Compound: multiple IPs doing returns from same block (max 3 more)
  if (returnIps >= 5) s += 3;
  else if (returnIps >= 3) s += 2;
  else if (returnIps >= 2) s += 1;
  return Math.min(s, 10);
}

// ── Bounce / dwell scoring (0–10) ────────────────────────────────────
// If most visitors from a block leave within 5 seconds, it's bot traffic.
// Real users who clicked an ad and landed on a relevant page stay at least
// 10-15 seconds. Sub-5-second dwell = the page loaded and they bounced
// (or the bot didn't even render it).
function scoreBounce(dwellValues) {
  if (!dwellValues || dwellValues.length < 3) return 0;  // need 3+ samples

  const total = dwellValues.length;
  const bounces_2s  = dwellValues.filter(d => d < 2000).length;
  const bounces_5s  = dwellValues.filter(d => d < 5000).length;
  const bounces_10s = dwellValues.filter(d => d < 10000).length;

  const bounceRate_2s  = bounces_2s / total;
  const bounceRate_5s  = bounces_5s / total;
  const bounceRate_10s = bounces_10s / total;

  // Average dwell
  const avgDwell = dwellValues.reduce((a, b) => a + b, 0) / total;

  let s = 0;
  // Ultra-fast bounce: >80% leave within 2 seconds (max 6)
  if (bounceRate_2s >= 0.80)      s += 6;
  else if (bounceRate_2s >= 0.60) s += 4;
  else if (bounceRate_2s >= 0.40) s += 2;

  // Fast bounce: >80% leave within 5 seconds (max 4 more)
  if (bounceRate_5s >= 0.90)      s += 4;
  else if (bounceRate_5s >= 0.70) s += 3;
  else if (bounceRate_5s >= 0.50) s += 2;

  // Average dwell under 5s is suspicious even without extreme bounce rate
  if (avgDwell < 3000 && total >= 5) s += 2;

  return Math.min(s, 10);
}

// ── Known-list cross-reference scoring (0–15) ────────────────────────
function scoreKnownList(isSeeded, wasExported, wasBlocked, priorDaysSeen) {
  let s = 0;
  if (wasBlocked)              s += 10;
  else if (wasExported)        s += 8;
  else if (isSeeded)           s += 6;
  if (priorDaysSeen >= 5)      s += 5;
  else if (priorDaysSeen >= 3) s += 3;
  return Math.min(s, 15);
}

function computeConsecutiveDays(dates) {
  if (!dates.length) return 0;
  const sorted = [...new Set(dates)].sort();
  let max = 1, streak = 1;
  for (let i = 1; i < sorted.length; i++) {
    const a = new Date(sorted[i - 1]);
    const b = new Date(sorted[i]);
    const diff = Math.round((b - a) / (1000 * 60 * 60 * 24));
    if (diff === 1) { streak++; if (streak > max) max = streak; }
    else { streak = 1; }
  }
  return max;
}

// ══════════════════════════════════════════════════════════════════════
// MAIN ANALYSIS
// ══════════════════════════════════════════════════════════════════════

async function analyseWorkspace(workspaceId, opts = {}) {
  const { Click, CidrIntelligence, CidrDailySnapshot } = getModels();

  const windowHours = opts.windowHours || 24;
  const windowEnd = opts.windowEnd || new Date();
  const windowStart = opts.windowStart ||
    new Date(windowEnd.getTime() - windowHours * 60 * 60 * 1000);
  const writeSnapshots = opts.writeSnapshots !== false;
  const writeLiveState = opts.writeLiveState !== false;
  // referenceDate is the "as-of" date used for the `today` bucket and for the
  // `last_seen`/`last_analysed_at` timestamps written to live state.
  //
  // Defaults to wall-clock now. Pass it explicitly when re-analysing a past
  // window so we don't pollute live state with today's wall clock — e.g. if
  // the user re-runs last Tuesday, snapshots get date=Tuesday but the live
  // record would otherwise still bump last_seen=now and treat Tuesday as a
  // returning-today day. The analyse-range endpoint already disables
  // writeLiveState for past ranges so this is belt-and-braces, but it also
  // matters for `today`'s bucket-key when re-analysing a partial day.
  const referenceDate = opts.referenceDate || windowEnd || new Date();

  const clicks = await Click.find({
    workspace_id: workspaceId,
    ts: { $gte: windowStart, $lte: windowEnd },
  })
    .select('ip ts decision conversion_count user_agent asn_org country external_ids dwell_ms')
    .lean();

  if (!clicks.length) {
    return { processed: 0, subnets: 0, snapshots: 0, upserted: 0 };
  }

  // ── Aggregate by subnet + calendar day ─────────────────────────────
  const subnetDayMap = new Map();

  for (const c of clicks) {
    const sub = getSubnet(c.ip);
    if (!sub) continue;
    const ts = c.ts instanceof Date ? c.ts : new Date(c.ts);
    if (isNaN(ts)) continue;
    const date = ts.toISOString().slice(0, 10);

    let bySubnet = subnetDayMap.get(sub.cidr);
    if (!bySubnet) { bySubnet = new Map(); subnetDayMap.set(sub.cidr, bySubnet); }
    let day = bySubnet.get(date);
    if (!day) {
      day = {
        clicks: [], blockedHits: 0, uaCounts: {},
        fakeUACount: 0, webviewBotCount: 0, conv: 0,
        asn: '', country: '', version: sub.version,
        dwellValues: [],  // v2.1: collect dwell_ms for bounce scoring
      };
      bySubnet.set(date, day);
    }

    day.asn = day.asn || c.asn_org || '';
    day.country = day.country || c.country || '';

    if (c.decision === 'block') { day.blockedHits++; continue; }

    const ua = c.user_agent || '';
    const eid = c.external_ids || {};
    day.clicks.push({
      ts, ip: c.ip, user_agent: ua,
      gclid: eid.gclid || '', wbraid: eid.wbraid || '',
      gbraid: eid.gbraid || '', fbclid: eid.fbclid || '',
      msclkid: eid.msclkid || '',
    });
    day.conv += parseInt(c.conversion_count || 0, 10) || 0;
    day.uaCounts[ua] = (day.uaCounts[ua] || 0) + 1;
    if (isFakeUA(ua)) day.fakeUACount++;
    if (isWebViewBot(ua)) day.webviewBotCount++;
    // v2.1: collect dwell time for bounce scoring
    if (c.dwell_ms != null && c.dwell_ms >= 0) day.dwellValues.push(c.dwell_ms);
  }

  // ── Look up snapshot history ───────────────────────────────────────
  // Needed BEFORE the snapshot-write loop so the snapshot gate can use
  // "has prior history?" as a force-write trigger (a CIDR with prior
  // offences gets a snapshot for any new active day, even if today's
  // hits don't on their own qualify). Also feeds scoreHistoricalClickIds
  // later for the live-state upsert.
  //
  // Keyed off subnetDayMap because cidrAggregate isn't built yet — but
  // they have the same key set (the union of CIDRs touched by this
  // analysis window).
  const priorCidrs = [...subnetDayMap.keys()];
  let priorSnapshotMap = new Map();
  if (priorCidrs.length > 0) {
    const priorSnapshots = await CidrDailySnapshot.find({
      workspace_id: workspaceId,
      cidr: { $in: priorCidrs },
    }).select('cidr date source unique_gclids unique_wbraids unique_gbraids unique_fbclids unique_msclkids hits conversions')
      .sort({ cidr: 1, date: 1 }).lean();
    for (const ps of priorSnapshots) {
      if (!priorSnapshotMap.has(ps.cidr)) {
        priorSnapshotMap.set(ps.cidr, {
          dates: [],
          sources: new Set(),
          // Cumulative figures across all priorSnapshots for this CIDR.
          // "Prior" here means "everything we've ever recorded" — the
          // historical signal in scoreHistoricalClickIds compares against
          // this total, not against today's window.
          total_ad_ids_prior:  0,
          total_clicks_prior:  0,
          total_conv_prior:    0,
          days_with_activity:  0,
        });
      }
      const entry = priorSnapshotMap.get(ps.cidr);
      entry.dates.push(ps.date);
      entry.sources.add(ps.source);
      entry.total_ad_ids_prior += (ps.unique_gclids   || 0)
                                + (ps.unique_wbraids  || 0)
                                + (ps.unique_gbraids  || 0)
                                + (ps.unique_fbclids  || 0)
                                + (ps.unique_msclkids || 0);
      entry.total_clicks_prior += ps.hits || 0;
      entry.total_conv_prior   += ps.conversions || 0;
      if ((ps.hits || 0) >= 1) entry.days_with_activity++;
    }
  }

  // ── Per-day trigger detection + snapshots ──────────────────────────
  let snapshotsWritten = 0;
  const today = referenceDate.toISOString().slice(0, 10);
  const dayTriggerMetrics = new Map();

  if (writeSnapshots) {
    for (const [cidr, byDay] of subnetDayMap) {
      if (!dayTriggerMetrics.has(cidr)) dayTriggerMetrics.set(cidr, new Map());
      for (const [date, day] of byDay) {
        const trig = detectTriggers(day.clicks);
        dayTriggerMetrics.get(cidr).set(date, trig.metrics);

        // Snapshot write gate.
        //
        // Write a snapshot for any (cidr, date) where this block sent at
        // least one allowed click with zero conversions on that day, OR
        // the trigger detector qualified the day on stronger signals.
        // Rationale: a 1-click-per-day slow-drip bot pattern accumulates
        // only across days, so each day on its own looks innocuous. The
        // previous 2+ click gate hid those CIDRs from past-range views
        // entirely (the 7d listing showed ~187 vs ground truth ~1000+).
        const forceSnapshot = day.clicks.length >= 1 && day.conv === 0;

        if (!trig.qualifies && !forceSnapshot) continue;

        // Single-day frequency label for this snapshot. Uses the day's
        // own metrics. Stored alongside the snapshot so historical "how
        // many high-frequency days did this CIDR have" queries are
        // possible without recomputing.
        const daySingleAdIds = trig.metrics.unique_gclids +
                               trig.metrics.unique_wbraids +
                               trig.metrics.unique_gbraids +
                               trig.metrics.unique_fbclids +
                               trig.metrics.unique_msclkids;
        const dayFreqEvidence = {
          clicks:        trig.metrics.hits,
          unique_ad_ids: daySingleAdIds,
          conversions:   day.conv,
        };
        const dayFreqLabel = computeFrequencyLabel(dayFreqEvidence, 'single_day');

        await CidrDailySnapshot.updateOne(
          { workspace_id: workspaceId, cidr, date },
          {
            $set: {
              ip_version:              day.version,
              triggers:                trig.triggers,
              hits:                    trig.metrics.hits,
              unique_ips:              trig.metrics.unique_ips,
              conversions:             day.conv,
              max_burst_5min:          trig.metrics.max_burst_5min,
              rapid_duplicate_count:   trig.metrics.rapid_duplicate_count,
              single_ip_hammer_count:  trig.metrics.single_ip_hammer_count,
              fake_ua_count:           day.fakeUACount,
              unique_gclids:           trig.metrics.unique_gclids,
              unique_wbraids:          trig.metrics.unique_wbraids,
              unique_gbraids:          trig.metrics.unique_gbraids,
              unique_fbclids:          trig.metrics.unique_fbclids,
              unique_msclkids:         trig.metrics.unique_msclkids,
              hits_with_no_click_id:   trig.metrics.hits_with_no_click_id,
              sub_second_burst_count:  trig.metrics.sub_second_burst_count || 0,
              sub_5s_burst_count:      trig.metrics.sub_5s_burst_count || 0,
              min_gap_ms:              trig.metrics.min_gap_ms != null ? trig.metrics.min_gap_ms : -1,
              webview_bot_count:       trig.metrics.webview_bot_count || 0,
              same_ip_ua_repeat_count: trig.metrics.same_ip_ua_repeat_count || 0,
              ua_diversity_ratio:      trig.metrics.ua_diversity_ratio != null ? trig.metrics.ua_diversity_ratio : 1,
              slow_drip_ip_count:      trig.metrics.slow_drip_ip_count || 0,
              hits_per_ip:             trig.metrics.hits_per_ip || 0,
              // v2.1: dwell persistence so past-range bounce scoring works
              avg_dwell_ms:            day.dwellValues.length > 0
                ? Math.round(day.dwellValues.reduce((a, b) => a + b, 0) / day.dwellValues.length)
                : null,
              bounce_rate_5s:          day.dwellValues.length > 0
                ? Math.round(day.dwellValues.filter(d => d < 5000).length / day.dwellValues.length * 1000) / 1000
                : null,
              dwell_sample_count:      day.dwellValues.length,
              frequency_label:         dayFreqLabel,
              frequency_evidence:      dayFreqEvidence,
              asn_org:                 day.asn,
              country:                 day.country,
            },
            $setOnInsert: {
              workspace_id: workspaceId, cidr, date, source: 'analyser',
            },
          },
          { upsert: true }
        );
        snapshotsWritten++;
      }
    }
  }

  // ── Build per-CIDR aggregates ──────────────────────────────────────
  const cidrAggregate = new Map();
  for (const [cidr, byDay] of subnetDayMap) {
    const agg = {
      cidr, version: null, hits: 0, blockedHits: 0,
      uniqueIps: new Set(), conv: 0, uaCounts: {},
      fakeUACount: 0, webviewBotCount: 0,
      asn: '', country: '', sampleIps: new Set(),
      gclids: new Set(), wbraids: new Set(), gbraids: new Set(),
      fbclids: new Set(), msclkids: new Set(), hitsNoClickId: 0,
      totalSubSecond: 0, totalSub5s: 0, globalMinGapMs: Infinity,
      sameIpUaRepeats: 0, uaDiversityRatio: 1,
      slowDripIpCount: 0, hitsPerIp: 0,
      returnTier1: 0, returnTier2: 0, returnTier3: 0, returnTotalIps: 0,
      dwellValues: [],  // all dwell_ms values across days
    };
    for (const [, day] of byDay) {
      agg.version = day.version;
      agg.hits += day.clicks.length;
      agg.blockedHits += day.blockedHits || 0;
      agg.webviewBotCount += day.webviewBotCount || 0;
      for (const c of day.clicks) {
        agg.uniqueIps.add(c.ip);
        if (agg.sampleIps.size < 10) agg.sampleIps.add(c.ip);
        if (c.gclid)   agg.gclids.add(c.gclid);
        if (c.wbraid)  agg.wbraids.add(c.wbraid);
        if (c.gbraid)  agg.gbraids.add(c.gbraid);
        if (c.fbclid)  agg.fbclids.add(c.fbclid);
        if (c.msclkid) agg.msclkids.add(c.msclkid);
        if (!c.gclid && !c.wbraid && !c.gbraid && !c.fbclid && !c.msclkid) {
          agg.hitsNoClickId++;
        }
      }
      agg.conv += day.conv;
      agg.fakeUACount += day.fakeUACount;
      agg.asn = agg.asn || day.asn;
      agg.country = agg.country || day.country;
      // v2.1: merge dwell values
      if (day.dwellValues && day.dwellValues.length) {
        agg.dwellValues.push(...day.dwellValues);
      }
      for (const [ua, n] of Object.entries(day.uaCounts)) {
        agg.uaCounts[ua] = (agg.uaCounts[ua] || 0) + n;
      }
      const dm = dayTriggerMetrics.get(cidr)?.get(Array.from(byDay.keys()).find(k => byDay.get(k) === day));
      if (dm) {
        agg.totalSubSecond += dm.sub_second_burst_count || 0;
        agg.totalSub5s += dm.sub_5s_burst_count || 0;
        if (dm.min_gap_ms >= 0 && dm.min_gap_ms < agg.globalMinGapMs) {
          agg.globalMinGapMs = dm.min_gap_ms;
        }
        agg.sameIpUaRepeats += dm.same_ip_ua_repeat_count || 0;
        agg.slowDripIpCount += dm.slow_drip_ip_count || 0;
        agg.returnTier1 += dm.ip_return_tier1_count || 0;
        agg.returnTier2 += dm.ip_return_tier2_count || 0;
        agg.returnTier3 += dm.ip_return_tier3_count || 0;
        agg.returnTotalIps += dm.ip_return_total_ips || 0;
      }
    }
    const ipsCount = agg.uniqueIps.size;
    agg.uaDiversityRatio = agg.hits > 0 ? Object.keys(agg.uaCounts).length / agg.hits : 1;
    agg.hitsPerIp = ipsCount > 0 ? agg.hits / ipsCount : agg.hits;
    cidrAggregate.set(cidr, agg);
  }

  // ── Look up existing intelligence for known-list status ────────────
  // (priorSnapshotMap already populated above — needed for the snapshot gate)
  const cidrs = [...cidrAggregate.keys()];
  let existingIntelMap = new Map();
  if (cidrs.length > 0) {
    const existing = await CidrIntelligence.find({
      workspace_id: workspaceId,
      cidr: { $in: cidrs },
    }).select('cidr status').lean();
    for (const doc of existing) existingIntelMap.set(doc.cidr, doc);
  }

  // ── Upsert CidrIntelligence (live state) ───────────────────────────
  let upserted = 0;
  const now = referenceDate;

  if (writeLiveState) {
    for (const [cidr, agg] of cidrAggregate) {
      const uniqueIps = agg.uniqueIps.size;

      const history = priorSnapshotMap.get(cidr) || { dates: [], sources: new Set() };
      const priorDates    = [...new Set(history.dates)].filter(d => d !== today).sort();
      const allDates      = [...new Set([...history.dates, today])].sort();
      const priorDaysSeen = priorDates.length;
      const totalDaysSeen = allDates.length;
      const isReturning   = priorDaysSeen >= 2;
      const isSeeded      = history.sources.has('seed');

      const existingDoc = existingIntelMap.get(cidr);
      const wasBlocked  = existingDoc?.status === 'blocked';
      const wasExported = existingDoc?.status === 'exported';

      const totalUniqueIds = agg.gclids.size + agg.wbraids.size + agg.gbraids.size
                           + agg.fbclids.size + agg.msclkids.size;

      // ── Frequency label (window mode) ─────────────────────────────
      // Computed BEFORE the signals object so its value can feed into
      // sig.frequency. The label uses the current analysis window's
      // metrics (days, clicks, ad IDs, conversions). For the 60s live
      // worker that window is 24h; for analyse-range it's whatever the
      // caller specified. See LABEL_THRESHOLDS for the rule.
      const daysInWindow = subnetDayMap.get(cidr)?.size || 1;
      const freqEvidence = {
        days_in_window:          daysInWindow,
        clicks_in_window:        agg.hits,
        unique_ad_ids_in_window: totalUniqueIds,
        conversions_in_window:   agg.conv,
        window_hours:            windowHours,
      };
      const freqLabel = computeFrequencyLabel({
        clicks:        agg.hits,
        unique_ad_ids: totalUniqueIds,
        conversions:   agg.conv,
        days:          daysInWindow,
      }, 'window');

      const signals = {
        volume:      scoreVolume(agg.hits),
        conversion:  scoreConversion(agg.hits, agg.conv),
        rotation:    scoreRotation(agg.hits, uniqueIps),
        ua_uniform:  scoreUAUniformity(agg.uaCounts, agg.hits, agg.fakeUACount),
        persistence: scorePersistence(priorDaysSeen, isReturning),
        fake_ua:     scoreFakeUA(agg.fakeUACount),
        click_id:    scoreClickIdSignal(agg.hits, totalUniqueIds, agg.hitsNoClickId),
        temporal:    scoreTemporal(agg.totalSubSecond, agg.totalSub5s, agg.globalMinGapMs),
        webview_ua:  scoreWebViewUA(agg.webviewBotCount, agg.hits),
        behavioral:  scoreBehavioral(agg.sameIpUaRepeats, agg.uaDiversityRatio, agg.hits),
        slow_drip:   scoreIpReturn(agg.returnTier1, agg.returnTier2, agg.returnTier3, agg.returnTotalIps, agg.hitsPerIp),
        bounce:      scoreBounce(agg.dwellValues),
        known_list:  scoreKnownList(isSeeded, wasExported, wasBlocked, priorDaysSeen),
        // v2.2 — historical & label-feedback signals
        historical_ids: scoreHistoricalClickIds(history),
        frequency:      scoreFrequencyLabel(freqLabel),
      };
      const score = Math.min(100, Object.values(signals).reduce((a, b) => a + b, 0));

      // Evidence flags for the dossier-creation gate below.
      // Any allowed click with zero conversions qualifies — a 1-click-per-day
      // slow-drip bot is still a bot, and the dossier is where past-range
      // views look for the historical record.
      const hasZeroConvActivity = agg.hits >= 1 && agg.conv === 0;
      const hasTemporal         = agg.totalSubSecond > 0;
      const hasWebView          = agg.webviewBotCount > 0;
      const hasSlowDrip         = agg.slowDripIpCount > 0 || agg.returnTier1 > 0 || agg.returnTier2 > 0;

      // ── Dossier creation gate ──────────────────────────────────────
      //
      // Previously: skip if score<5 AND no history AND <5 blocks AND no
      // weak/temporal/webview/slow-drip signal. This was too tight —
      // CIDRs with 3-4 clicks and zero conversions (the MEDIUM-frequency
      // tier) often scored 3-4 and got dropped before the frequency
      // labeller could flag them.
      //
      // New rule: persist a dossier for ANY CIDR that has both
      //   (a) at least 2 allowed hits, AND
      //   (b) zero conversions
      // regardless of score. The frequency labeller decides the grade.
      // This roughly 3-5x's the dossier size but makes the MEDIUM tier
      // visible. Score still drives priority sorting and Critical/High
      // bucket counts; this change only affects which CIDRs are KNOWN
      // to the system at all.
      //
      // Other inclusion paths preserved:
      //   - Any prior history of this CIDR (returning offender)
      //   - 5+ blocked hits (high-signal even without allowed traffic)
      //   - Temporal/webview/slow-drip evidence
      //   - score >= 5 from any other signal
      const qualifies = score >= 5
                     || history.dates.length > 0
                     || agg.blockedHits >= 5
                     || hasZeroConvActivity
                     || hasTemporal
                     || hasWebView
                     || hasSlowDrip;
      if (!qualifies) continue;

      const topUAs = Object.entries(agg.uaCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([ua, count]) => ({ ua: ua.slice(0, 120), count }));

      await CidrIntelligence.updateOne(
        { workspace_id: workspaceId, cidr },
        {
          $set: {
            asn_org: agg.asn, country: agg.country,
            ip_version: agg.version, score, signals,
            frequency_label: freqLabel,
            frequency_evidence: freqEvidence,
            hit_count: agg.hits, blocked_hits: agg.blockedHits,
            unique_ip_count: uniqueIps,
            conversion_count: agg.conv,
            conv_rate: agg.hits > 0 ? agg.conv / agg.hits : 0,
            top_uas: topUAs, sample_ips: [...agg.sampleIps],
            fake_ua_count: agg.fakeUACount,
            unique_gclids: agg.gclids.size, unique_wbraids: agg.wbraids.size,
            unique_gbraids: agg.gbraids.size, unique_fbclids: agg.fbclids.size,
            unique_msclkids: agg.msclkids.size,
            hits_with_no_click_id: agg.hitsNoClickId,
            days_seen_count: totalDaysSeen,
            consecutive_days: computeConsecutiveDays(allDates),
            last_seen: now, last_analysed_at: now,
            analysis_window_hours: windowHours,
            // v2 evidence
            sub_second_burst_count: agg.totalSubSecond,
            sub_5s_burst_count: agg.totalSub5s,
            min_gap_ms: agg.globalMinGapMs === Infinity ? -1 : agg.globalMinGapMs,
            webview_bot_count: agg.webviewBotCount,
            same_ip_ua_repeat_count: agg.sameIpUaRepeats,
            ua_diversity_ratio: Math.round(agg.uaDiversityRatio * 1000) / 1000,
            slow_drip_ip_count: agg.slowDripIpCount,
            ip_return_tier1: agg.returnTier1,
            ip_return_tier2: agg.returnTier2,
            ip_return_tier3: agg.returnTier3,
            ip_return_total_ips: agg.returnTotalIps,
            hits_per_ip: Math.round(agg.hitsPerIp * 100) / 100,
            // v2.1: dwell/bounce evidence
            avg_dwell_ms: agg.dwellValues.length > 0
              ? Math.round(agg.dwellValues.reduce((a, b) => a + b, 0) / agg.dwellValues.length)
              : null,
            bounce_rate_5s: agg.dwellValues.length > 0
              ? Math.round(agg.dwellValues.filter(d => d < 5000).length / agg.dwellValues.length * 1000) / 1000
              : null,
            dwell_sample_count: agg.dwellValues.length,
            historical_match: {
              has_history: history.dates.length > 0,
              total_days_seen: totalDaysSeen,
              prior_days_seen: priorDaysSeen,
              first_seen_date: priorDates[0] || '',
              last_seen_date: priorDates[priorDates.length - 1] || '',
              is_returning: isReturning,
              is_seeded: isSeeded,
            },
          },
          $setOnInsert: {
            workspace_id: workspaceId, cidr,
            first_seen: now, status: 'new',
          },
        },
        { upsert: true }
      );
      upserted++;
    }
  }

  return { processed: clicks.length, subnets: subnetDayMap.size, snapshots: snapshotsWritten, upserted };
}

// ── Worker loop ──────────────────────────────────────────────────────

let workerRunning = false;

async function runAnalysis(opts = {}) {
  if (workerRunning) return;
  workerRunning = true;
  try {
    const { Workspace } = getModels();
    const workspaces = await Workspace.find().select('_id slug').lean();
    const windowHours = parseInt(opts.windowHours || process.env.CIDR_ANALYSIS_WINDOW_HOURS || '24', 10);
    let totalProcessed = 0, totalSnapshots = 0, totalUpserted = 0;
    for (const ws of workspaces) {
      const result = await analyseWorkspace(ws._id, { windowHours });
      totalProcessed += result.processed || 0;
      totalSnapshots += result.snapshots || 0;
      totalUpserted += result.upserted || 0;
    }
    if (totalProcessed > 0 || totalSnapshots > 0) {
      logger.info('cidr_analysis_run', {
        clicks_processed: totalProcessed, snapshots_written: totalSnapshots,
        intelligence_upserted: totalUpserted, window_hours: windowHours,
      });
    }
  } catch (err) {
    logger.warn('cidr_analysis_error', { err: err.message });
  } finally { workerRunning = false; }
}

function startCidrAnalyser() {
  const intervalSeconds = parseInt(process.env.CIDR_ANALYSIS_INTERVAL_SECONDS || '60', 10);
  logger.info('cidr_analyser_started', {
    interval_seconds: intervalSeconds,
    window_hours: process.env.CIDR_ANALYSIS_WINDOW_HOURS || 24,
  });
  runAnalysis();
  const timer = setInterval(runAnalysis, intervalSeconds * 1000);
  if (timer.unref) timer.unref();
  return timer;
}

// ── Weekly refresh worker ────────────────────────────────────────────
//
// The live 60s worker analyses a rolling 24h window. That's the right
// thing for "what's happening RIGHT NOW" but it means a CIDR that hit
// you on Monday with zero conversions, then went quiet, has its score
// frozen at Monday's 24h view of itself for the rest of the week.
//
// This worker fills that gap. Once a week (Sunday 23:59 server local
// time by default — configurable via env vars) it runs a fresh
// 168-hour-window analysis. This:
//   1. Re-aggregates clicks across the past 7 days per CIDR
//   2. Rewrites each snapshot with current evidence + labels
//   3. Recomputes window-mode frequency labels with full week visibility
//
// The pass DOES NOT write live state (`writeLiveState: false`) — that's
// owned by the 60s worker and we don't want to race against it. It only
// refreshes snapshots and their labels. The next 60s pass will then pick
// up the refreshed snapshot history naturally.
//
// Configurable via env vars:
//   CIDR_WEEKLY_REFRESH_DAY     = 0 (Sun) ... 6 (Sat).   Default: 0
//   CIDR_WEEKLY_REFRESH_HOUR    = 0..23 server local.    Default: 23
//   CIDR_WEEKLY_REFRESH_MINUTE  = 0..59 server local.    Default: 59
//   CIDR_WEEKLY_REFRESH_WINDOW_HOURS = window size.       Default: 168
//
// Idempotency: a single in-process flag prevents re-entrance within the
// same minute. If you deploy at 23:55 on Sunday and the server starts
// running, the worker will fire at 23:59 normally. If the deploy lands
// AT 23:59 and the boot path takes a few seconds, the worker will pick
// up the next minute boundary and skip the missed window (intentional —
// better to skip than double-run).

let weeklyRefreshRunning = false;
let weeklyRefreshLastFiredKey = '';

async function runWeeklyRefresh() {
  if (weeklyRefreshRunning) return;
  weeklyRefreshRunning = true;
  const windowHours = parseInt(process.env.CIDR_WEEKLY_REFRESH_WINDOW_HOURS || '168', 10);
  try {
    const { Workspace } = getModels();
    const workspaces = await Workspace.find({}).select('_id slug').lean();
    let totalSnapshots = 0;
    let totalProcessed = 0;
    for (const ws of workspaces) {
      try {
        // `writeLiveState: false` — let the 60s worker keep ownership of
        // CidrIntelligence. We only refresh snapshots and their labels.
        const result = await analyseWorkspace(ws._id, {
          windowHours,
          writeSnapshots: true,
          writeLiveState: false,
        });
        totalProcessed += result.processed || 0;
        totalSnapshots += result.snapshots || 0;
      } catch (err) {
        logger.warn('weekly_refresh_workspace_error', {
          workspace: ws.slug, err: err.message,
        });
      }
    }
    logger.info('weekly_refresh_complete', {
      window_hours: windowHours,
      workspaces: workspaces.length,
      clicks_processed: totalProcessed,
      snapshots_written: totalSnapshots,
    });
  } catch (err) {
    logger.warn('weekly_refresh_error', { err: err.message });
  } finally {
    weeklyRefreshRunning = false;
  }
}

function startWeeklyRefresh() {
  const day    = parseInt(process.env.CIDR_WEEKLY_REFRESH_DAY    || '0',  10); // Sun
  const hour   = parseInt(process.env.CIDR_WEEKLY_REFRESH_HOUR   || '23', 10);
  const minute = parseInt(process.env.CIDR_WEEKLY_REFRESH_MINUTE || '59', 10);
  logger.info('cidr_weekly_refresh_scheduled', { day, hour, minute,
    window_hours: process.env.CIDR_WEEKLY_REFRESH_WINDOW_HOURS || 168 });

  // Check every 60s. Cheap (just a Date comparison) and lets the worker
  // recover if the server starts up between the scheduled time and
  // the next interval check.
  function tick() {
    const now = new Date();
    if (now.getDay() === day && now.getHours() === hour && now.getMinutes() === minute) {
      // The "key" is YYYY-MM-DD — using the date prevents double-fires
      // within the same minute across multiple tick() calls (the
      // interval is 60s, but Date.now() drift means we might tick
      // twice in the same minute on rare occasions).
      const key = now.toISOString().slice(0, 10);
      if (key !== weeklyRefreshLastFiredKey) {
        weeklyRefreshLastFiredKey = key;
        runWeeklyRefresh();
      }
    }
  }
  // First tick immediately so a deploy at 23:59 Sunday triggers the
  // refresh (instead of waiting a full week for the next one).
  tick();
  const timer = setInterval(tick, 60 * 1000);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = {
  startCidrAnalyser, startWeeklyRefresh, runWeeklyRefresh, runAnalysis, analyseWorkspace,
  getSubnet, isFakeUA, isWebViewBot, computeConsecutiveDays,
  computeFrequencyLabel, LABEL_THRESHOLDS,
};
