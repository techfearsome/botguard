/**
 * CidrIntelligence v2.1 — scored CIDR detection results with dossier fields.
 */

'use strict';

const mongoose = require('mongoose');

const STATUSES = ['new', 'reviewing', 'watchlist', 'blocked', 'exported', 'dismissed'];

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

  // ── Evidence ───────────────────────────────────────────────────────
  hit_count:        { type: Number, default: 0 },
  blocked_hits:     { type: Number, default: 0 },
  unique_ip_count:  { type: Number, default: 0 },
  conversion_count: { type: Number, default: 0 },
  conv_rate:        { type: Number, default: 0 },
  top_uas: [{ ua: String, count: Number }],
  sample_ips: [String],
  fake_ua_count: { type: Number, default: 0 },

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

CidrIntelligenceSchema.virtual('score_label').get(function () {
  if (this.score >= 80) return 'critical';
  if (this.score >= 60) return 'high';
  if (this.score >= 40) return 'medium';
  return 'low';
});

CidrIntelligenceSchema.set('toObject', { virtuals: true });
CidrIntelligenceSchema.set('toJSON', { virtuals: true });
CidrIntelligenceSchema.statics.STATUSES = STATUSES;

module.exports = mongoose.model('CidrIntelligence', CidrIntelligenceSchema);
