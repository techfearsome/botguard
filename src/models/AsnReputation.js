/**
 * AsnReputation — running reputation score per ASN.
 *
 * Tracks how many confirmed-bad CIDRs each ASN has produced over time.
 * A new CIDR from an ASN that's already given you 20 confirmed bots
 * should start with elevated suspicion instead of a clean slate.
 *
 * Updated by the CIDR analyser as CIDRs get scored/blocked/exported.
 */

'use strict';

const mongoose = require('mongoose');

const AsnReputationSchema = new mongoose.Schema({
  workspace_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },

  // ASN identity — we key on the org name since ProxyCheck gives us that
  // reliably (the numeric ASN isn't always present).
  asn_org: { type: String, required: true },
  asn_number: { type: Number, default: null },

  // Reputation counters
  total_cidrs_seen:      { type: Number, default: 0 },  // distinct CIDRs from this ASN
  flagged_cidrs:         { type: Number, default: 0 },  // CIDRs that scored >= 60
  blocked_cidrs:         { type: Number, default: 0 },  // CIDRs exported/blocked
  total_bot_hits:        { type: Number, default: 0 },  // sum of hits across flagged CIDRs
  total_conversions:     { type: Number, default: 0 },  // conversions from this ASN (legitimacy signal)

  // Derived reputation score 0-100 (higher = worse)
  reputation_score: { type: Number, default: 0, index: true },

  // The CIDRs we've counted (so we don't double-count on re-analysis)
  counted_cidrs: [{ type: String }],

  first_seen: { type: Date, default: Date.now },
  last_updated: { type: Date, default: Date.now },
}, {
  timestamps: false,
});

AsnReputationSchema.index({ workspace_id: 1, asn_org: 1 }, { unique: true });

module.exports = mongoose.model('AsnReputation', AsnReputationSchema);
