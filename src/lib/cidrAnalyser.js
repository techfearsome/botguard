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
  if (hits < 10) return 0;
  const noIdRatio = hitsWithNoClickId / hits;
  const hitsWithId = hits - hitsWithNoClickId;
  let score = 0;
  if (noIdRatio >= 0.90) score += 12;
  else if (noIdRatio >= 0.70) score += 8;
  else if (noIdRatio >= 0.50) score += 4;
  if (hitsWithId >= 10) {
    const diversity = totalUniqueIds / hitsWithId;
    if (diversity < 0.30)      score += 8;
    else if (diversity < 0.50) score += 4;
    else if (diversity < 0.70) score += 2;
  }
  return Math.min(score, 15);
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

  const clicks = await Click.find({
    workspace_id: workspaceId,
    ts: { $gte: windowStart, $lte: windowEnd },
  })
    .select('ip ts decision conversion_count user_agent asn_org country external_ids')
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
  }

  // ── Per-day trigger detection + snapshots ──────────────────────────
  let snapshotsWritten = 0;
  const today = new Date().toISOString().slice(0, 10);
  const dayTriggerMetrics = new Map();

  if (writeSnapshots) {
    for (const [cidr, byDay] of subnetDayMap) {
      if (!dayTriggerMetrics.has(cidr)) dayTriggerMetrics.set(cidr, new Map());
      for (const [date, day] of byDay) {
        const trig = detectTriggers(day.clicks);
        dayTriggerMetrics.get(cidr).set(date, trig.metrics);

        // v2: ALWAYS write snapshot if block had 2+ allowed hits with 0 conv
        // even if no trigger fired — this builds the dossier for weak signals
        const forceSnapshot = day.clicks.length >= 2 && day.conv === 0;

        if (!trig.qualifies && !forceSnapshot) continue;

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

  // ── Look up snapshot history ───────────────────────────────────────
  const cidrs = [...cidrAggregate.keys()];
  let priorSnapshotMap = new Map();
  if (cidrs.length > 0) {
    const priorSnapshots = await CidrDailySnapshot.find({
      workspace_id: workspaceId,
      cidr: { $in: cidrs },
    }).select('cidr date source').sort({ cidr: 1, date: 1 }).lean();
    for (const ps of priorSnapshots) {
      if (!priorSnapshotMap.has(ps.cidr)) {
        priorSnapshotMap.set(ps.cidr, { dates: [], sources: new Set() });
      }
      const entry = priorSnapshotMap.get(ps.cidr);
      entry.dates.push(ps.date);
      entry.sources.add(ps.source);
    }
  }

  // ── Look up existing intelligence for known-list status ────────────
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
  const now = new Date();

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
        known_list:  scoreKnownList(isSeeded, wasExported, wasBlocked, priorDaysSeen),
      };
      const score = Math.min(100, Object.values(signals).reduce((a, b) => a + b, 0));

      // v2: Build dossier on ANY block showing weak signals — don't wait
      // for high scores to start tracking.
      const hasWeakSignal = (agg.hits >= 2 && agg.conv === 0);
      const hasTemporal   = agg.totalSubSecond > 0;
      const hasWebView    = agg.webviewBotCount > 0;
      const hasSlowDrip   = agg.slowDripIpCount > 0 || agg.returnTier1 > 0 || agg.returnTier2 > 0;

      if (score < 5 && !history.dates.length && agg.blockedHits < 5
          && !hasWeakSignal && !hasTemporal && !hasWebView && !hasSlowDrip) continue;

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

module.exports = {
  startCidrAnalyser, runAnalysis, analyseWorkspace,
  getSubnet, isFakeUA, isWebViewBot, computeConsecutiveDays,
};
