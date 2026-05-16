/**
 * CloudflareRule — edge firewall rules pushed to Cloudflare Workers KV.
 *
 * This is a SEPARATE collection from AsnBlacklist and FirewallEntry.
 * AsnBlacklist/FirewallEntry = internal BotGuard software-level blocking.
 * CloudflareRule = edge-level blocking at Cloudflare before requests reach origin.
 *
 * Rule types:
 *   - ip:    single IP address (e.g. "146.86.149.221")
 *   - cidr:  IP range (e.g. "66.207.24.0/24", "2600:387::/32")
 *   - asn:   autonomous system number (e.g. 7922 = Comcast)
 *
 * Source tracking:
 *   - manual:       added directly via /admin/cloudflare form or CSV upload
 *   - asn_import:   imported from /admin/asn
 *   - intelligence: imported from /admin/intelligence
 *   - csv_upload:   bulk imported from CSV file
 */

'use strict';

const mongoose = require('mongoose');

const RULE_TYPES = ['ip', 'cidr', 'asn'];
const SOURCES    = ['manual', 'asn_import', 'intelligence', 'csv_upload'];
const ACTIONS    = ['block', 'challenge', 'monitor'];

const CloudflareRuleSchema = new mongoose.Schema({
  workspace_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Workspace',
    required: true,
    index: true,
  },

  // Rule type
  rule_type: {
    type: String,
    enum: RULE_TYPES,
    required: true,
    index: true,
  },

  // The value — exactly one of these is set depending on rule_type:
  //   ip:   "146.86.149.221"
  //   cidr: "66.207.24.0/24" or "2600:387::/32"
  //   asn:  stored as number in asn_number field
  value: { type: String, index: true },      // for ip and cidr rules
  asn_number: { type: Number, index: true }, // for asn rules

  // Human-readable context
  label: { type: String, default: '' },      // e.g. "AT&T Enterprises" or "Verizon /32 pool"
  notes: { type: String, default: '' },

  // What action the Worker should take
  action: {
    type: String,
    enum: ACTIONS,
    default: 'block',
  },

  // Where this rule came from
  source: {
    type: String,
    enum: SOURCES,
    default: 'manual',
  },
  source_ref: { type: String, default: '' }, // e.g. AsnBlacklist._id or CidrIntelligence._id

  // Status
  active: { type: Boolean, default: true, index: true },

  // Tracking
  hit_count:   { type: Number, default: 0 },
  last_hit_at: { type: Date },

  // Sync state
  synced_at:    { type: Date },              // last time this rule was pushed to Cloudflare KV
  needs_sync:   { type: Boolean, default: true, index: true },

  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

// Prevent duplicate rules
CloudflareRuleSchema.index(
  { workspace_id: 1, rule_type: 1, value: 1 },
  { unique: true, sparse: true, partialFilterExpression: { value: { $type: 'string' } } }
);
CloudflareRuleSchema.index(
  { workspace_id: 1, rule_type: 1, asn_number: 1 },
  { unique: true, sparse: true, partialFilterExpression: { asn_number: { $type: 'number' } } }
);
CloudflareRuleSchema.index({ workspace_id: 1, active: 1, needs_sync: 1 });

CloudflareRuleSchema.pre('save', function (next) {
  this.updated_at = new Date();
  this.needs_sync = true;
  next();
});

// Convenience: get the display value for any rule type
CloudflareRuleSchema.virtual('display_value').get(function () {
  if (this.rule_type === 'asn') return `AS${this.asn_number}`;
  return this.value || '';
});

CloudflareRuleSchema.set('toObject', { virtuals: true });
CloudflareRuleSchema.set('toJSON', { virtuals: true });

CloudflareRuleSchema.statics.RULE_TYPES = RULE_TYPES;
CloudflareRuleSchema.statics.SOURCES = SOURCES;
CloudflareRuleSchema.statics.ACTIONS = ACTIONS;

module.exports = mongoose.model('CloudflareRule', CloudflareRuleSchema);
