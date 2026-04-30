const mongoose = require('mongoose');

/**
 * ASN Blacklist - overlay on top of ProxyCheck.io to catch what it misses.
 *
 * ProxyCheck has known gaps:
 *   - Some Tor exit nodes when their ASN rotates
 *   - Smaller/regional VPN providers
 *   - Residential proxy networks that look "clean"
 *   - Newly-registered datacenter ASNs
 *
 * This blacklist runs AFTER ProxyCheck. It can flip a "clean" verdict to "proxy",
 * but never the reverse — ProxyCheck's positive matches are always trusted.
 *
 * Categories let you tune scoring per source profile:
 *   - 'tor' is always bad
 *   - 'datacenter' might be okay for some sources (server-side click tools, etc.)
 *   - 'vpn' depends on the campaign's audience
 */

const AsnBlacklistSchema = new mongoose.Schema({
  workspace_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', index: true },
  // null workspace_id = global rule (applies to all workspaces)

  // Match modes - exactly one of these should be set per rule:
  //   - asn: matches by ProxyCheck-returned ASN number
  //   - cidr: matches by IP range (week 3 - schema reserved)
  //   - term: matches if provider/organization string contains this substring (case-insensitive)
  asn: { type: Number, index: true },
  cidr: String,
  term: { type: String, index: true },              // e.g. 'vpn', 'hosting', 'data center', 'm247'
  term_field: {                                     // which ProxyCheck field to match against
    type: String,
    enum: ['provider', 'asn_org', 'any'],
    default: 'any',
  },

  asn_org: String,                           // human-readable, denormalized for ASN rules

  category: {
    type: String,
    enum: ['tor', 'vpn', 'proxy', 'datacenter', 'hosting', 'scraper', 'spam', 'other'],
    required: true,
    index: true,
  },

  severity: {
    type: String,
    enum: ['hard_block', 'high', 'medium', 'low'],
    default: 'high',
  },

  // Score contribution to add when this rule matches (added to scores.network)
  score_weight: { type: Number, default: 50 },

  // Verdict override - can force a verdict regardless of score
  override: {
    type: String,
    enum: ['none', 'mark_proxy', 'mark_tor', 'mark_clean'],
    default: 'mark_proxy',
  },

  active: { type: Boolean, default: true },
  source: String,           // 'manual', 'spamhaus_drop', 'tor_exits', 'firehol', 'custom'
  notes: String,

  // Track effectiveness
  hit_count: { type: Number, default: 0 },
  last_hit_at: Date,

  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

// Allow same ASN per workspace but not duplicates
AsnBlacklistSchema.index({ workspace_id: 1, asn: 1 }, { unique: true, sparse: true });
AsnBlacklistSchema.index({ workspace_id: 1, cidr: 1 }, { unique: true, sparse: true });
AsnBlacklistSchema.index({ workspace_id: 1, term: 1, term_field: 1 }, { unique: true, sparse: true });
AsnBlacklistSchema.index({ workspace_id: 1, active: 1, category: 1 });

AsnBlacklistSchema.pre('save', function (next) {
  this.updated_at = new Date();
  next();
});

module.exports = mongoose.model('AsnBlacklist', AsnBlacklistSchema);
