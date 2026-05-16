/**
 * CloudflareLog — records every decision made by the Cloudflare Worker.
 *
 * The Worker sends a POST to /admin/cloudflare/api/log after each request
 * with the visitor data and decision. Authenticated via CF_SYNC_KEY header.
 *
 * Kept separate from Click and FirewallLog since these are edge-level
 * events that happen before the request reaches BotGuard's normal pipeline.
 */

'use strict';

const mongoose = require('mongoose');

const CloudflareLogSchema = new mongoose.Schema({
  workspace_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Workspace',
    required: true,
    index: true,
  },

  // Visitor info (from Cloudflare headers)
  ip:         { type: String, required: true, index: true },
  asn:        { type: Number },
  country:    { type: String, default: '' },
  user_agent: { type: String, default: '' },
  url:        { type: String, default: '' },
  method:     { type: String, default: 'GET' },

  // Decision
  action:     { type: String, enum: ['allow', 'block', 'challenge'], required: true, index: true },
  reason:     { type: String, default: '' },  // 'disabled', 'utm_skip', 'no_match', 'ip', 'cidr', 'asn'
  matched_rule: { type: String, default: '' }, // the rule value that matched (e.g. "AS22773" or "66.207.24.0/24")
  scan_mode:  { type: String, default: '' },  // 'all' or 'utm'

  // Timing
  processing_ms: { type: Number, default: 0 },

  ts: { type: Date, default: Date.now, index: true },
}, {
  timestamps: false,
  // Auto-expire logs after 30 days to prevent unbounded growth
  expireAfterSeconds: 30 * 24 * 60 * 60,
});

CloudflareLogSchema.index({ workspace_id: 1, ts: -1 });
CloudflareLogSchema.index({ workspace_id: 1, action: 1, ts: -1 });
CloudflareLogSchema.index({ workspace_id: 1, ip: 1, ts: -1 });
CloudflareLogSchema.index({ ts: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

module.exports = mongoose.model('CloudflareLog', CloudflareLogSchema);
