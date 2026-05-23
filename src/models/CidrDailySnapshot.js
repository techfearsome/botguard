/**
 * CidrDailySnapshot - daily evidence record for CIDRs that triggered suspicion.
 *
 * One document per (workspace_id, cidr, date). Only written when a CIDR
 * matches one of the four detection triggers within that day. Subnets with
 * a single coincidental hit never produce a snapshot.
 *
 * Purpose: Persistent historical record that survives across days, enables
 * "returning offender" detection, and lets us compare today's traffic against
 * accumulated history.
 *
 * Storage estimate: ~150 snapshots/day at production scale, ~400 bytes each,
 * = 60KB/day = 22MB/year. Kept forever - historical signal strengthens over time.
 *
 * Detection triggers (any one qualifies the CIDR for snapshotting):
 *   - burst:           3+ hits within any 5-minute window
 *   - volume:          5+ hits across the day
 *   - hammer:          any single IP hit 3+ times
 *   - rapid_duplicate: same IP within 60 seconds
 */

'use strict';

const mongoose = require('mongoose');

const TRIGGERS = ['burst', 'volume', 'hammer', 'rapid_duplicate', 'click_id_starved', 'seed'];
const SOURCES  = ['analyser', 'seed', 'manual'];

const CidrDailySnapshotSchema = new mongoose.Schema({
  workspace_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Workspace',
    required: true,
    index: true,
  },

  // Subnet identifier: '1.2.3.0/24' or '2600:387::/32'
  cidr: { type: String, required: true },

  // Calendar date as 'YYYY-MM-DD' string in UTC.
  // String not Date because we want exact day-bucket equality, no timezone math.
  date: { type: String, required: true, index: true },

  // IP family for filtering
  ip_version: { type: String, enum: ['v4', 'v6'], required: true },

  // ── Detection evidence ──────────────────────────────────────────────
  // Which triggers fired - typically multiple for actual bot subnets
  triggers: { type: [String], enum: TRIGGERS, default: [] },

  hits:        { type: Number, default: 0 },   // total clicks from this CIDR today
  unique_ips:  { type: Number, default: 0 },   // distinct IP addresses seen
  conversions: { type: Number, default: 0 },   // sum of conversion_count

  // Burst metrics
  max_burst_5min:         { type: Number, default: 0 },  // most hits in any 5-min window
  rapid_duplicate_count:  { type: Number, default: 0 },  // same-IP hits within 60s
  single_ip_hammer_count: { type: Number, default: 0 },  // count of IPs that hit 3+ times alone

  // Bot UA signal (iOS 19+, headless markers, etc.) - lifted from scorer
  fake_ua_count: { type: Number, default: 0 },

  // ── Click-ID correlation ────────────────────────────────────────────
  // Tracks how many *distinct* tracking IDs this CIDR produced today.
  // Real paid ad traffic has a near-1.0 ratio of unique-IDs-to-hits because
  // Google/Bing/Facebook issue a fresh ID per ad click. A CIDR with 100 hits
  // but only 10 unique gclids is replaying captured IDs (bot signature).
  // A CIDR with high hits but zero click IDs is hitting the landing page
  // URL directly, bypassing the ad funnel entirely.
  unique_gclids:   { type: Number, default: 0 },
  unique_wbraids:  { type: Number, default: 0 },
  unique_gbraids:  { type: Number, default: 0 },
  unique_fbclids:  { type: Number, default: 0 },
  unique_msclkids: { type: Number, default: 0 },

  // Count of hits where ALL click-ID fields were empty - direct landing
  // page hits with no ad attribution. Should be near-zero for legitimate
  // paid traffic.
  hits_with_no_click_id: { type: Number, default: 0 },

  // ── v2 temporal / behavioral evidence (persisted historically) ──────
  // Previously these only lived on the live CidrIntelligence doc, which the
  // 60s worker overwrites. Snapshotting them preserves history so re-analysis
  // and past-range views reflect the actual evidence collected on that day.
  sub_second_burst_count:  { type: Number, default: 0 },
  sub_5s_burst_count:      { type: Number, default: 0 },
  min_gap_ms:              { type: Number, default: -1 },
  webview_bot_count:       { type: Number, default: 0 },
  same_ip_ua_repeat_count: { type: Number, default: 0 },
  ua_diversity_ratio:      { type: Number, default: 1 },
  slow_drip_ip_count:      { type: Number, default: 0 },
  hits_per_ip:             { type: Number, default: 0 },

  // ── v2.1: dwell / bounce evidence ──────────────────────────────────
  // Persisted per-day so past-range bounce scoring stays computable.
  avg_dwell_ms:       { type: Number, default: null },
  bounce_rate_5s:     { type: Number, default: null },
  dwell_sample_count: { type: Number, default: 0 },

  // ── Frequency grading (single-day) ────────────────────────────────
  // This is the label computed from THIS DAY's metrics alone. The route
  // handler also computes a WINDOW label across multiple snapshot days
  // when the user views a custom date range — but that's derived on the
  // fly, not stored here. The single-day label is useful for "which days
  // did this CIDR have high-frequency activity" analyses.
  frequency_label: { type: String, enum: ['high', 'medium', 'low', null], default: null, index: true },
  frequency_evidence: {
    clicks:        { type: Number, default: 0 },
    unique_ad_ids: { type: Number, default: 0 },
    conversions:   { type: Number, default: 0 },
  },

  // Context for display
  asn_org: { type: String, default: '' },
  country: { type: String, default: '' },

  // ── Provenance ─────────────────────────────────────────────────────
  // 'analyser': written by the rollup worker from real click data
  // 'seed':     imported from external source (existing exclusion files)
  // 'manual':   added by admin from the UI
  source: { type: String, enum: SOURCES, default: 'analyser' },

  // If source='seed', records where the entry came from
  seed_source: { type: String, default: '' },   // e.g. 'google_ads_account_exclusion'
}, {
  timestamps: true,
});

// Dedup: one snapshot per CIDR per day per workspace
CidrDailySnapshotSchema.index({ workspace_id: 1, cidr: 1, date: 1 }, { unique: true });

// Common query: "all snapshots for this CIDR ordered by date" → persistence calc
CidrDailySnapshotSchema.index({ workspace_id: 1, cidr: 1, date: -1 });

// Common query: "all CIDRs on this date" → daily history view
CidrDailySnapshotSchema.index({ workspace_id: 1, date: -1 });

CidrDailySnapshotSchema.statics.TRIGGERS = TRIGGERS;
CidrDailySnapshotSchema.statics.SOURCES = SOURCES;

module.exports = mongoose.model('CidrDailySnapshot', CidrDailySnapshotSchema);
