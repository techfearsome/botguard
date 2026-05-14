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

  // Sort by timestamp - all subsequent algorithms need ordered events
  const sorted = clicks
    .filter(c => c && c.ts)
    .map(c => ({ ts: c.ts instanceof Date ? c.ts : new Date(c.ts), ip: c.ip }))
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

  const metrics = {
    hits:                   totalHits,
    unique_ips:             uniqueIps,
    max_burst_5min:         maxBurst,
    rapid_duplicate_count:  rapidDupes,
    rapid_duplicate_pairs:  rapidDupePairs,  // for downstream IP auto-block
    single_ip_hammer_count: hammerIpCount,
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
};
