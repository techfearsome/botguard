/**
 * CIDR snapshot trigger detection — v2.1
 *
 * Eight independent triggers — ANY one fires snapshot inclusion:
 *
 *   1. burst:            3+ hits within any rolling 5-minute window
 *   2. volume:           5+ hits across the day
 *   3. hammer:           any single IP hit 3+ times
 *   4. rapid_duplicate:  same IP within 60 seconds
 *   5. click_id_starved: 10+ hits AND >60% have no click ID
 *   6. sub_second_burst: any two clicks from the block < 1s apart
 *   7. webview_ua:       reordered Mobile/Version tokens or bare WebView
 *   8. slow_drip:        same IP returns across sessions (gap > 30min)
 *                        with zero conversions — stealthy repeat bot
 */

'use strict';

const BURST_WINDOW_MS           = 5 * 60 * 1000;
const BURST_THRESHOLD           = 3;
const VOLUME_THRESHOLD          = 5;
const HAMMER_THRESHOLD          = 3;
const RAPID_DUPLICATE_WINDOW_MS = 60 * 1000;
const CLICK_ID_STARVED_MIN_HITS = 10;
const CLICK_ID_STARVED_RATIO    = 0.60;
const SUB_SECOND_THRESHOLD_MS   = 1000;
const SUB_5S_THRESHOLD_MS       = 5000;

// Same-IP return detection — tiered by gap duration.
//
// The gap between rapid_duplicate (60s) and slow_drip (was 30min) was a dead
// zone where 25% of bot return traffic went undetected. Now we track ALL
// same-IP returns above 60s and score them by tier:
//
//   Tier 1 (1–5 min):   "reclick" — user error or tab-refresh is possible
//                         but 2+ reclicks from same IP = suspicious
//   Tier 2 (5–30 min):  "mid_return" — too slow for accidental, too fast for
//                         a real user re-searching and re-clicking the same ad
//   Tier 3 (30min+):    "slow_drip" — separate sessions entirely, definitive bot
//
// The trigger fires if ANY tier has 2+ returns from the same IP.
const RETURN_TIER1_MIN_MS  = 60 * 1000;          // 1 minute
const RETURN_TIER1_MAX_MS  = 5 * 60 * 1000;       // 5 minutes
const RETURN_TIER2_MAX_MS  = 30 * 60 * 1000;      // 30 minutes
const RETURN_MIN_INSTANCES = 2;                    // 2+ returns = trigger

// WebView bot UA patterns
const WEBVIEW_BOT_RE  = /Mobile\/15E148\s+Version\/\d+\.\d+\.\d+/;
const BARE_WEBVIEW_RE = /Mobile\/15E148$/;

function isWebViewBot(ua) {
  if (!ua) return false;
  if (WEBVIEW_BOT_RE.test(ua)) return true;
  if (BARE_WEBVIEW_RE.test(ua.trim()) && !ua.includes('Safari/')) return true;
  return false;
}

function detectTriggers(clicks) {
  if (!Array.isArray(clicks) || clicks.length === 0) {
    return { triggers: [], metrics: emptyMetrics(), qualifies: false };
  }

  const sorted = clicks
    .filter(c => c && c.ts)
    .map(c => ({
      ts: c.ts instanceof Date ? c.ts : new Date(c.ts),
      ip: c.ip,
      user_agent: c.user_agent || '',
      gclid:   c.gclid   || '',
      wbraid:  c.wbraid  || '',
      gbraid:  c.gbraid  || '',
      fbclid:  c.fbclid  || '',
      msclkid: c.msclkid || '',
    }))
    .sort((a, b) => a.ts - b.ts);

  if (sorted.length === 0) {
    return { triggers: [], metrics: emptyMetrics(), qualifies: false };
  }

  const triggers = new Set();
  const totalHits = sorted.length;

  // ── Trigger 2: volume ─────────────────────────────────────────────
  if (totalHits >= VOLUME_THRESHOLD) triggers.add('volume');

  // ── Trigger 1: burst (3+ hits in 5-min window) ────────────────────
  let maxBurst = 0, left = 0;
  for (let right = 0; right < sorted.length; right++) {
    while (sorted[right].ts - sorted[left].ts > BURST_WINDOW_MS) left++;
    const ws = right - left + 1;
    if (ws > maxBurst) maxBurst = ws;
  }
  if (maxBurst >= BURST_THRESHOLD) triggers.add('burst');

  // ── Trigger 3: hammer (single IP 3+ times) ────────────────────────
  const ipCounts = {};
  for (const c of sorted) if (c.ip) ipCounts[c.ip] = (ipCounts[c.ip] || 0) + 1;
  let hammerIpCount = 0;
  for (const ip in ipCounts) if (ipCounts[ip] >= HAMMER_THRESHOLD) hammerIpCount++;
  if (hammerIpCount > 0) triggers.add('hammer');

  // ── Trigger 4: rapid_duplicate (same IP < 60s) ────────────────────
  const ipTimestamps = {};
  for (const c of sorted) {
    if (!c.ip) continue;
    if (!ipTimestamps[c.ip]) ipTimestamps[c.ip] = [];
    ipTimestamps[c.ip].push(c.ts);
  }
  let rapidDupes = 0;
  const rapidDupePairs = [];
  for (const ip in ipTimestamps) {
    const times = ipTimestamps[ip];
    for (let i = 1; i < times.length; i++) {
      const gap = times[i] - times[i - 1];
      if (gap < RAPID_DUPLICATE_WINDOW_MS) {
        rapidDupes++;
        rapidDupePairs.push({ ip, ts1: times[i - 1], ts2: times[i], gapMs: gap });
      }
    }
  }
  if (rapidDupes > 0) triggers.add('rapid_duplicate');

  // ── Trigger 5: click_id_starved ───────────────────────────────────
  const gclidSet = new Set(), wbraidSet = new Set(), gbraidSet = new Set();
  const fbclidSet = new Set(), msclkidSet = new Set();
  let hitsWithNoClickId = 0;
  for (const c of sorted) {
    if (c.gclid)   gclidSet.add(c.gclid);
    if (c.wbraid)  wbraidSet.add(c.wbraid);
    if (c.gbraid)  gbraidSet.add(c.gbraid);
    if (c.fbclid)  fbclidSet.add(c.fbclid);
    if (c.msclkid) msclkidSet.add(c.msclkid);
    if (!c.gclid && !c.wbraid && !c.gbraid && !c.fbclid && !c.msclkid) {
      hitsWithNoClickId++;
    }
  }
  const noClickIdRatio = totalHits > 0 ? hitsWithNoClickId / totalHits : 0;
  if (totalHits >= CLICK_ID_STARVED_MIN_HITS && noClickIdRatio >= CLICK_ID_STARVED_RATIO) {
    triggers.add('click_id_starved');
  }

  // ── Trigger 6: sub-second burst (block-level) ─────────────────────
  let subSecondCount = 0, sub5sCount = 0, minGapMs = Infinity;
  for (let i = 1; i < sorted.length; i++) {
    const gapMs = sorted[i].ts - sorted[i - 1].ts;
    if (gapMs < minGapMs) minGapMs = gapMs;
    if (gapMs < SUB_SECOND_THRESHOLD_MS) subSecondCount++;
    if (gapMs < SUB_5S_THRESHOLD_MS) sub5sCount++;
  }
  if (subSecondCount > 0) triggers.add('sub_second_burst');

  // ── Trigger 7: WebView bot UA ─────────────────────────────────────
  let webviewBotCount = 0;
  for (const c of sorted) if (isWebViewBot(c.user_agent)) webviewBotCount++;
  if (webviewBotCount > 0) triggers.add('webview_ua');

  // ── Trigger 8: ip_return (same IP returning at any interval) ────────
  // Covers the FULL spectrum of same-IP returns:
  //   - Tier 1 (1-5min): "reclick" — possible accidental, but 2+ = suspicious
  //   - Tier 2 (5-30min): "mid_return" — too deliberate for accident
  //   - Tier 3 (30min+): "slow_drip" — separate sessions, definitive bot
  // Fires if ANY tier has 2+ returns from the same IP.
  let returnTier1 = 0, returnTier2 = 0, returnTier3 = 0;
  let totalReturnIps = 0;
  const returnDetails = [];
  for (const ip in ipTimestamps) {
    const times = ipTimestamps[ip];
    if (times.length < 2) continue;
    let ipTier1 = 0, ipTier2 = 0, ipTier3 = 0;
    for (let i = 1; i < times.length; i++) {
      const gap = times[i] - times[i - 1];
      if (gap >= RETURN_TIER1_MIN_MS && gap < RETURN_TIER1_MAX_MS) ipTier1++;
      else if (gap >= RETURN_TIER1_MAX_MS && gap < RETURN_TIER2_MAX_MS) ipTier2++;
      else if (gap >= RETURN_TIER2_MAX_MS) ipTier3++;
    }
    const ipTotalReturns = ipTier1 + ipTier2 + ipTier3;
    if (ipTotalReturns > 0) {
      totalReturnIps++;
      returnDetails.push({ ip, tier1: ipTier1, tier2: ipTier2, tier3: ipTier3, totalClicks: times.length });
    }
    returnTier1 += ipTier1;
    returnTier2 += ipTier2;
    returnTier3 += ipTier3;
  }
  // Trigger fires if any single IP has 2+ returns across any tier combination
  const hasReturnBot = returnDetails.some(d => (d.tier1 + d.tier2 + d.tier3) >= RETURN_MIN_INSTANCES);
  if (hasReturnBot) triggers.add('ip_return');
  // Also keep slow_drip as a separate trigger for backwards compat
  if (returnTier3 > 0) triggers.add('slow_drip');

  // ── Supplementary metrics ─────────────────────────────────────────
  // Same IP+UA repeats (3+ hits from identical IP+UA combo)
  let sameIpUaRepeats = 0;
  const ipUaCounts = {};
  for (const c of sorted) {
    const key = `${c.ip}||${c.user_agent}`;
    ipUaCounts[key] = (ipUaCounts[key] || 0) + 1;
  }
  for (const key in ipUaCounts) if (ipUaCounts[key] >= 3) sameIpUaRepeats++;

  // UA diversity
  const uaSet = new Set(sorted.map(c => c.user_agent));
  const uaDiversityRatio = totalHits > 0 ? uaSet.size / totalHits : 1;
  const uniqueIps = Object.keys(ipCounts).length;

  // Hits-per-IP (average)
  const hitsPerIp = uniqueIps > 0 ? totalHits / uniqueIps : totalHits;

  const metrics = {
    hits:                    totalHits,
    unique_ips:              uniqueIps,
    hits_per_ip:             Math.round(hitsPerIp * 100) / 100,
    max_burst_5min:          maxBurst,
    rapid_duplicate_count:   rapidDupes,
    rapid_duplicate_pairs:   rapidDupePairs,
    single_ip_hammer_count:  hammerIpCount,
    // Click-ID
    unique_gclids:           gclidSet.size,
    unique_wbraids:          wbraidSet.size,
    unique_gbraids:          gbraidSet.size,
    unique_fbclids:          fbclidSet.size,
    unique_msclkids:         msclkidSet.size,
    hits_with_no_click_id:   hitsWithNoClickId,
    no_click_id_ratio:       noClickIdRatio,
    // Temporal
    sub_second_burst_count:  subSecondCount,
    sub_5s_burst_count:      sub5sCount,
    min_gap_ms:              minGapMs === Infinity ? -1 : Math.round(minGapMs),
    // WebView
    webview_bot_count:       webviewBotCount,
    // Behavioral
    same_ip_ua_repeat_count: sameIpUaRepeats,
    ua_diversity_ratio:      Math.round(uaDiversityRatio * 1000) / 1000,
    // Slow-drip / IP return (tiered)
    ip_return_tier1_count:   returnTier1,    // 1-5 min returns
    ip_return_tier2_count:   returnTier2,    // 5-30 min returns  
    ip_return_tier3_count:   returnTier3,    // 30min+ returns (slow_drip)
    slow_drip_ip_count:      returnDetails.filter(d => d.tier3 > 0).length,
    ip_return_total_ips:     totalReturnIps,
    ip_return_details:       returnDetails,
  };

  return { triggers: [...triggers], metrics, qualifies: triggers.size > 0 };
}

function emptyMetrics() {
  return {
    hits: 0, unique_ips: 0, hits_per_ip: 0, max_burst_5min: 0,
    rapid_duplicate_count: 0, rapid_duplicate_pairs: [],
    single_ip_hammer_count: 0,
    unique_gclids: 0, unique_wbraids: 0, unique_gbraids: 0,
    unique_fbclids: 0, unique_msclkids: 0,
    hits_with_no_click_id: 0, no_click_id_ratio: 0,
    sub_second_burst_count: 0, sub_5s_burst_count: 0, min_gap_ms: -1,
    webview_bot_count: 0,
    same_ip_ua_repeat_count: 0, ua_diversity_ratio: 1,
    slow_drip_ip_count: 0, ip_return_tier1_count: 0,
    ip_return_tier2_count: 0, ip_return_tier3_count: 0,
    ip_return_total_ips: 0, ip_return_details: [],
  };
}

module.exports = {
  detectTriggers, isWebViewBot,
  BURST_WINDOW_MS, BURST_THRESHOLD, VOLUME_THRESHOLD,
  HAMMER_THRESHOLD, RAPID_DUPLICATE_WINDOW_MS,
  CLICK_ID_STARVED_MIN_HITS, CLICK_ID_STARVED_RATIO,
  SUB_SECOND_THRESHOLD_MS, SUB_5S_THRESHOLD_MS,
  SLOW_DRIP_GAP_MS: 30 * 60 * 1000, // kept for compat
  RETURN_TIER1_MIN_MS, RETURN_TIER1_MAX_MS, RETURN_TIER2_MAX_MS,
  RETURN_MIN_INSTANCES,
  WEBVIEW_BOT_RE, BARE_WEBVIEW_RE,
};
