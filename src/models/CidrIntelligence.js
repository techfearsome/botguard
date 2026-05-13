/**
 * CidrIntelligence - scored CIDR detection results.
 *
 * One document per (workspace_id, cidr) pair. The background analyser
 * upserts these on every analysis run. The admin /intelligence view
 * reads from this collection.
 *
 * Lifecycle:
 *   new        → freshly detected, not yet reviewed by admin
 *   reviewing  → admin has looked at it, not yet acted
 *   blocked    → added to BotGuard CIDR blacklist
 *   exported   → added to Google Ads export queue
 *   dismissed  → admin decided it's not a threat
 *
 * A single CIDR can be both blocked AND exported - those are independent
 * actions (block at landing page level + block at Google Ads level).
 */

'use strict';

const mongoose = require('mongoose');

const STATUSES = ['new', 'reviewing', 'blocked', 'exported', 'dismissed'];

const SignalSchema = new mongoose.Schema({
  volume:      { type: Number, default: 0 },  // 0-20
  conversion:  { type: Number, default: 0 },  // 0-25
  rotation:    { type: Number, default: 0 },  // 0-20
  ua_uniform:  { type: Number, default: 0 },  // 0-15
  persistence: { type: Number, default: 0 },  // 0-15
  fake_ua:     { type: Number, default: 0 },  // 0-5
}, { _id: false });

const CidrIntelligenceSchema = new mongoose.Schema({
  workspace_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Workspace',
    required: true,
    index: true,
  },

  // The CIDR in normalized form (ipaddr.js output).
  // IPv4: '1.2.3.0/24', IPv6: '2600:387::/32'
  cidr: { type: String, required: true },

  // Human-readable context
  asn_org:  { type: String, default: '' },
  country:  { type: String, default: '' },
  ip_version: { type: String, enum: ['v4', 'v6'], default: 'v4' },

  // ── Scoring ──────────────────────────────────────────────────────────
  score:   { type: Number, default: 0, index: true },   // 0–100
  signals: { type: SignalSchema, default: () => ({}) },

  // ── Evidence ─────────────────────────────────────────────────────────
  hit_count:        { type: Number, default: 0 },
  unique_ip_count:  { type: Number, default: 0 },
  conversion_count: { type: Number, default: 0 },
  conv_rate:        { type: Number, default: 0 },   // 0.0–1.0

  // Top UAs seen — stored for display, capped at 5
  top_uas: [{ ua: String, count: Number }],

  // Sample IPs — first 10 unique IPs seen, for display
  sample_ips: [String],

  // iOS 26+ (fake UA) hit count within this subnet
  fake_ua_count: { type: Number, default: 0 },

  // ── Multi-day persistence ────────────────────────────────────────────
  // Array of 'YYYY-MM-DD' strings - calendar days this subnet was seen
  days_seen_list:    { type: [String], default: [] },
  days_seen_count:   { type: Number, default: 0 },    // len of above
  consecutive_days:  { type: Number, default: 0 },    // max streak

  // ── Timing ───────────────────────────────────────────────────────────
  first_seen:       { type: Date, default: Date.now },
  last_seen:        { type: Date, default: Date.now, index: true },
  last_analysed_at: { type: Date, default: Date.now },

  // Time window this analysis covers
  analysis_window_hours: { type: Number, default: 24 },

  // ── Status ───────────────────────────────────────────────────────────
  status:     { type: String, enum: STATUSES, default: 'new', index: true },
  blocked_at: { type: Date },
  exported_at: { type: Date },
  dismissed_at: { type: Date },
  notes:      { type: String, default: '', maxlength: 500 },
}, {
  timestamps: true,  // adds createdAt, updatedAt
});

// Dedup constraint
CidrIntelligenceSchema.index({ workspace_id: 1, cidr: 1 }, { unique: true });

// Common query patterns
CidrIntelligenceSchema.index({ workspace_id: 1, score: -1, status: 1 });
CidrIntelligenceSchema.index({ workspace_id: 1, last_seen: -1 });

// Convenience: score label for display
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
