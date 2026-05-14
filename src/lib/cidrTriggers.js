/**
 * CIDR snapshot trigger detection.
 *
 * Given the clicks from one CIDR within one day, decide whether the pattern
 * qualifies for a daily snapshot. Returns the metrics and triggers.
 *
 * Four independent triggers — ANY one fires inclusion:
 *
 *   1. burst:           3+ hits within any rolling 5-minute window
 *      → Coordinated automation - real users don't synchronize
 *
 *   2. volume:          5+ hits across the day
 *      → Sustained activity - one user clicking 5x in a day is rare for ads
 *
 *   3. hammer:          any single IP hit 3+ times alone
 *      → Single-machine automation, not a proxy pool
 *
 *   4. rapid_duplicate: same IP within 60 seconds
 *      → Zero false positives - no human clicks an ad twice in 60s
 *
 * The triggers are deliberately independent so a subnet can fire on the
 * one that matches its specific pattern. A burst-only attack matches #1.
 * A slow-and-low automation matches #2. A single-IP bot matches #3 and #4.
 *
 * Thresholds were tuned from real traffic analysis - see the chat history
 * for the data that justifies each cutoff.
 */

'use strict';

const BURST_WINDOW_MS         = 5 * 60 * 1000;   // 5 minutes
const BURST_THRESHOLD         = 3;
const VOLUME_THRESHOLD        = 5;
const HAMMER_THRESHOLD        = 3;               // same IP hits 3+ times
const RAPID_DUPLICATE_WINDOW_MS = 60 * 1000;     // 60 seconds

// click_id_starved trigger:
//   - 10+ hits AND >60% have no click ID
//   - means: high volume of direct landing-page hits with no ad attribution.
//   Real paid traffic carries a gclid/wbraid/gbraid/fbclid/msclkid on most
//   hits. A bot hitting the landing URL directly or replaying a single
//   captured ID produces this signature.
const CLICK_ID_STARVED_MIN_HITS = 10;
const CLICK_ID_STARVED_RATIO    = 0.60;          // 60%+ with no ID

/**
 * Analyse a list of click events from one CIDR within one day.
 *
 * @param {Array} clicks - objects with { ts: Date, ip: string } at minimum
 * @returns {object} - { triggers: [...], metrics: {...}, qualifies: boolean }
 */
function detectTriggers(clicks) {
  if (!Array.isArray(clicks) || clicks.length === 0) {
    return { triggers: [], metrics: emptyMetrics(), qualifies: false };
  }

  // Sort by timestamp - all subsequent algorithms need ordered events.
  // Carry through click-ID fields when present so we can compute diversity.
  const sorted = clicks
    .filter(c => c && c.ts)
    .map(c => ({
      ts: c.ts instanceof Date ? c.ts : new Date(c.ts),
      ip: c.ip,
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

  // ── Trigger 2: volume ──────────────────────────────────────────────
  // Cheapest check - just count
  if (totalHits >= VOLUME_THRESHOLD) {
    triggers.add('volume');
  }

  // ── Trigger 1: burst (3+ hits within 5-minute rolling window) ──────
  // Two-pointer sliding window over sorted timestamps
  let maxBurst = 0;
  let left = 0;
  for (let right = 0; right < sorted.length; right++) {
    while (sorted[right].ts - sorted[left].ts > BURST_WINDOW_MS) {
      left++;
    }
    const windowSize = right - left + 1;
    if (windowSize > maxBurst) maxBurst = windowSize;
  }
  if (maxBurst >= BURST_THRESHOLD) {
    triggers.add('burst');
  }

  // ── Trigger 3: hammer (single IP hit 3+ times) ─────────────────────
  // Count hits per IP, find IPs that exceed threshold
  const ipCounts = {};
  for (const c of sorted) {
    if (c.ip) ipCounts[c.ip] = (ipCounts[c.ip] || 0) + 1;
  }
  let hammerIpCount = 0;
  for (const ip in ipCounts) {
    if (ipCounts[ip] >= HAMMER_THRESHOLD) hammerIpCount++;
  }
  if (hammerIpCount > 0) {
    triggers.add('hammer');
  }

  // ── Trigger 4: rapid_duplicate (same IP within 60s) ────────────────
  // Group by IP, check consecutive timestamps
  const ipTimestamps = {};
  for (const c of sorted) {
    if (!c.ip) continue;
    if (!ipTimestamps[c.ip]) ipTimestamps[c.ip] = [];
    ipTimestamps[c.ip].push(c.ts);
  }
  let rapidDupes = 0;
  const rapidDupePairs = [];  // [{ ip, ts1, ts2, gapMs }] - useful for downstream actions
  for (const ip in ipTimestamps) {
    const times = ipTimestamps[ip]; // already sorted (since sorted is sorted)
    for (let i = 1; i < times.length; i++) {
      const gap = times[i] - times[i - 1];
      if (gap < RAPID_DUPLICATE_WINDOW_MS) {
        rapidDupes++;
        rapidDupePairs.push({ ip, ts1: times[i - 1], ts2: times[i], gapMs: gap });
      }
    }
  }
  if (rapidDupes > 0) {
    triggers.add('rapid_duplicate');
  }

  // Unique IPs - used for display and for "rotation" detection downstream
  const uniqueIps = Object.keys(ipCounts).length;

  // ── Trigger 5: click_id_starved (mostly direct/no-ID hits) ─────────
  // Count distinct values for each click-ID type, plus hits with no ID at all.
  // The trigger fires when the no-click-ID ratio is high on meaningful volume.
  const gclidSet   = new Set();
  const wbraidSet  = new Set();
  const gbraidSet  = new Set();
  const fbclidSet  = new Set();
  const msclkidSet = new Set();
  let hitsWithNoClickId = 0;

  for (const c of sorted) {
    if (c.gclid)   gclidSet.add(c.gclid);
    if (c.wbraid)  wbraidSet.add(c.wbraid);
    if (c.gbraid)  gbraidSet.add(c.gbraid);
    if (c.fbclid)  fbclidSet.add(c.fbclid);
    if (c.msclkid) msclkidSet.add(c.msclkid);
    // Counts as "no click ID" only if ALL five fields are empty.
    // This is deliberately strict - if any one tracking ID is present we
    // assume the click had some attribution.
    if (!c.gclid && !c.wbraid && !c.gbraid && !c.fbclid && !c.msclkid) {
      hitsWithNoClickId++;
    }
  }

  const noClickIdRatio = totalHits > 0 ? hitsWithNoClickId / totalHits : 0;
  if (totalHits >= CLICK_ID_STARVED_MIN_HITS && noClickIdRatio >= CLICK_ID_STARVED_RATIO) {
    triggers.add('click_id_starved');
  }

  const metrics = {
    hits:                   totalHits,
    unique_ips:             uniqueIps,
    max_burst_5min:         maxBurst,
    rapid_duplicate_count:  rapidDupes,
    rapid_duplicate_pairs:  rapidDupePairs,  // for downstream IP auto-block
    single_ip_hammer_count: hammerIpCount,
    // Click-ID diversity metrics
    unique_gclids:          gclidSet.size,
    unique_wbraids:         wbraidSet.size,
    unique_gbraids:         gbraidSet.size,
    unique_fbclids:         fbclidSet.size,
    unique_msclkids:        msclkidSet.size,
    hits_with_no_click_id:  hitsWithNoClickId,
    no_click_id_ratio:      noClickIdRatio,
  };

  return {
    triggers: [...triggers],
    metrics,
    qualifies: triggers.size > 0,
  };
}

function emptyMetrics() {
  return {
    hits: 0,
    unique_ips: 0,
    max_burst_5min: 0,
    rapid_duplicate_count: 0,
    rapid_duplicate_pairs: [],
    single_ip_hammer_count: 0,
    unique_gclids: 0,
    unique_wbraids: 0,
    unique_gbraids: 0,
    unique_fbclids: 0,
    unique_msclkids: 0,
    hits_with_no_click_id: 0,
    no_click_id_ratio: 0,
  };
}

module.exports = {
  detectTriggers,
  // Exposed for testing and tuning
  BURST_WINDOW_MS,
  BURST_THRESHOLD,
  VOLUME_THRESHOLD,
  HAMMER_THRESHOLD,
  RAPID_DUPLICATE_WINDOW_MS,
  CLICK_ID_STARVED_MIN_HITS,
  CLICK_ID_STARVED_RATIO,
};
