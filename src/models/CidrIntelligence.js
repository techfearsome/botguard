/**
 * CidrIntelligence v2.1 — scored CIDR detection results with dossier fields.
 */

'use strict';

const mongoose = require('mongoose');

const STATUSES = ['new', 'reviewing', 'watchlist', 'blocked', 'exported', 'dismissed', 'archived'];

// Frequency labels are a separate axis from `score`. Score asks "how confident
// are we this is a bot?" — based on signal strength. Frequency asks "how often
// does this CIDR cause us pain?" — based on observed activity. A CIDR can be
// HIGH-confidence (score 90) but LOW-frequency (one-day spike), or vice versa.
//
// Stored as a label string + evidence object so the UI can render the badge
// and explain why without recomputing.
//
// The label here is the WINDOW label computed across the analysis window
// (typically 24h for the live worker, but the analyser can be called with
// any window). The matching SINGLE-DAY label lives on each CidrDailySnapshot
// row for that day. The route handler computes window labels on-the-fly
// when the user views a custom date range, since the operative window
// depends on the date picker.
const FREQUENCY_LABELS = ['high', 'medium', 'low'];

const SignalSchema = new mongoose.Schema({
  volume:      { type: Number, default: 0 },  // 0-15
  conversion:  { type: Number, default: 0 },  // 0-20
  rotation:    { type: Number, default: 0 },  // 0-20
  ua_uniform:  { type: Number, default: 0 },  // 0-15
  persistence: { type: Number, default: 0 },  // 0-15
  fake_ua:     { type: Number, default: 0 },  // 0-5
  click_id:    { type: Number, default: 0 },  // 0-15
  // v2 signals
  temporal:    { type: Number, default: 0 },  // 0-20 (sub-second/sub-5s burst)
  webview_ua:  { type: Number, default: 0 },  // 0-10 (reordered WebView UA)
  behavioral:  { type: Number, default: 0 },  // 0-10 (same-IP+UA repeat, UA diversity)
  slow_drip:   { type: Number, default: 0 },  // 0-10 (same IP returning across sessions)
  bounce:      { type: Number, default: 0 },  // 0-10 (high bounce rate / low dwell time)
  known_list:  { type: Number, default: 0 },  // 0-15 (seeded/exported/blocked cross-ref)
  // v2.2 signals — historical CIDR-with-ad-id and frequency-label feedback.
  // Computed from CidrDailySnapshot history rather than the current window,
  // so they can score CIDRs that hit you days ago and haven't returned.
  historical_ids: { type: Number, default: 0 },  // 0-12 (multi-day ad-id diversity, zero conv)
  frequency:      { type: Number, default: 0 },  // 0-10 (HIGH/MEDIUM/LOW label feedback)
  // v2.3 — cross-campaign correlation
  cross_campaign: { type: Number, default: 0 },  // 0-10 (one CIDR hitting many campaigns)
  // v2.4 — ASN reputation memory
  asn_reputation: { type: Number, default: 0 },  // 0-8 (known-bad ASN association)
}, { _id: false });

const CidrIntelligenceSchema = new mongoose.Schema({
  workspace_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Workspace',
    required: true,
    index: true,
  },
  cidr: { type: String, required: true },

  // Human-readable context
  asn_org:    { type: String, default: '' },
  country:    { type: String, default: '' },
  ip_version: { type: String, enum: ['v4', 'v6'], default: 'v4' },

  // ── Scoring ────────────────────────────────────────────────────────
  score:   { type: Number, default: 0, index: true },
  signals: { type: SignalSchema, default: () => ({}) },

  // ── Frequency grading ──────────────────────────────────────────────
  // Computed by cidrAnalyser alongside score. 'high'/'medium'/'low'/null.
  // See FREQUENCY_LABELS at top of file for the meaning. Indexed so the
  // /admin/intelligence filter dropdown can query quickly.
  frequency_label:    { type: String, enum: [...FREQUENCY_LABELS, null], default: null, index: true },
  frequency_evidence: {
    // The numbers that drove the label assignment, kept so the UI can
    // explain it ("HIGH: 3 days, 17 clicks, 17 unique ad IDs").
    days_in_window:        { type: Number, default: 0 },
    clicks_in_window:      { type: Number, default: 0 },
    unique_ad_ids_in_window: { type: Number, default: 0 },
    conversions_in_window: { type: Number, default: 0 },
    // The window the label was computed over, in hours. The live worker
    // uses 24h; past-range route renders use whatever the user picked.
    window_hours:          { type: Number, default: 24 },
  },

  // ── Evidence ───────────────────────────────────────────────────────
  hit_count:        { type: Number, default: 0 },
  blocked_hits:     { type: Number, default: 0 },
  unique_ip_count:  { type: Number, default: 0 },
  conversion_count: { type: Number, default: 0 },
  conv_rate:        { type: Number, default: 0 },
  top_uas: [{ ua: String, count: Number }],
  sample_ips: [String],
  fake_ua_count: { type: Number, default: 0 },
  strong_fake_count: { type: Number, default: 0 },  // v2.4: severity-3 fakes
  fake_ua_flags: { type: mongoose.Schema.Types.Mixed, default: {} },  // v2.4: flag → count

  // ── Click-ID correlation ───────────────────────────────────────────
  unique_gclids:         { type: Number, default: 0 },
  unique_wbraids:        { type: Number, default: 0 },
  unique_gbraids:        { type: Number, default: 0 },
  unique_fbclids:        { type: Number, default: 0 },
  unique_msclkids:       { type: Number, default: 0 },
  hits_with_no_click_id: { type: Number, default: 0 },

  // ── v2: Temporal burst evidence ────────────────────────────────────
  sub_second_burst_count:  { type: Number, default: 0 },
  sub_5s_burst_count:      { type: Number, default: 0 },
  min_gap_ms:              { type: Number, default: -1 },

  // ── v2: WebView bot evidence ───────────────────────────────────────
  webview_bot_count: { type: Number, default: 0 },

  // ── v2: Behavioral pattern evidence ────────────────────────────────
  same_ip_ua_repeat_count: { type: Number, default: 0 },
  ua_diversity_ratio:      { type: Number, default: 1 },

  // ── v2: Slow-drip / IP-return evidence ───────────────────────────────
  slow_drip_ip_count: { type: Number, default: 0 },
  ip_return_tier1:    { type: Number, default: 0 },   // 1-5 min returns
  ip_return_tier2:    { type: Number, default: 0 },   // 5-30 min returns
  ip_return_tier3:    { type: Number, default: 0 },   // 30min+ returns
  ip_return_total_ips:{ type: Number, default: 0 },   // IPs with any return
  hits_per_ip:        { type: Number, default: 0 },

  // v2.3: cross-campaign correlation
  campaign_count: { type: Number, default: 0, index: true },
  campaign_ids:   [{ type: mongoose.Schema.Types.ObjectId, ref: 'Campaign' }],

  // ── v2.1: Dwell / bounce evidence ──────────────────────────────────
  avg_dwell_ms:       { type: Number, default: null },   // average time on page (ms)
  bounce_rate_5s:     { type: Number, default: null },   // ratio of visitors leaving < 5s
  dwell_sample_count: { type: Number, default: 0 },      // how many clicks have dwell data

  // ── Multi-day persistence ──────────────────────────────────────────
  days_seen_list:    { type: [String], default: [] },
  days_seen_count:   { type: Number, default: 0 },
  consecutive_days:  { type: Number, default: 0 },

  // ── Timing ─────────────────────────────────────────────────────────
  first_seen:       { type: Date, default: Date.now },
  last_seen:        { type: Date, default: Date.now, index: true },
  last_analysed_at: { type: Date, default: Date.now },
  analysis_window_hours: { type: Number, default: 24 },

  // ── Status ─────────────────────────────────────────────────────────
  status:       { type: String, enum: STATUSES, default: 'new', index: true },
  blocked_at:   { type: Date },
  exported_at:  { type: Date },
  dismissed_at: { type: Date },
  archived_at: { type: Date },
  // v2.5: auto-escalation tracking
  auto_escalated: { type: Boolean, default: false },
  auto_escalated_at: { type: Date },
  watchlisted_at: { type: Date },
  notes:        { type: String, default: '', maxlength: 500 },

  // ── Cloudflare edge firewall status ────────────────────────────────
  cf_exported:    { type: Boolean, default: false, index: true },
  cf_exported_at: { type: Date },

  // ── Historical correlation ─────────────────────────────────────────
  historical_match: {
    has_history:      { type: Boolean, default: false },
    total_days_seen:  { type: Number,  default: 0 },
    prior_days_seen:  { type: Number,  default: 0 },
    first_seen_date:  { type: String,  default: '' },
    last_seen_date:   { type: String,  default: '' },
    is_returning:     { type: Boolean, default: false },
    is_seeded:        { type: Boolean, default: false },
  },
}, {
  timestamps: true,
});

CidrIntelligenceSchema.index({ workspace_id: 1, cidr: 1 }, { unique: true });
CidrIntelligenceSchema.index({ workspace_id: 1, score: -1, status: 1 });
CidrIntelligenceSchema.index({ workspace_id: 1, last_seen: -1 });
// Index for the new frequency filter — most common query is "active CIDRs
// with frequency label X", so a compound index helps.
CidrIntelligenceSchema.index({ workspace_id: 1, frequency_label: 1, status: 1 });

CidrIntelligenceSchema.virtual('score_label').get(function () {
  if (this.score >= 80) return 'critical';
  if (this.score >= 60) return 'high';
  if (this.score >= 40) return 'medium';
  return 'low';
});

CidrIntelligenceSchema.set('toObject', { virtuals: true });
CidrIntelligenceSchema.set('toJSON', { virtuals: true });
CidrIntelligenceSchema.statics.STATUSES = STATUSES;
CidrIntelligenceSchema.statics.FREQUENCY_LABELS = FREQUENCY_LABELS;

module.exports = mongoose.model('CidrIntelligence', CidrIntelligenceSchema);
