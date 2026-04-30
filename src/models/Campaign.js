const mongoose = require('mongoose');

const CampaignSchema = new mongoose.Schema({
  workspace_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  slug: { type: String, required: true, lowercase: true, trim: true },
  name: { type: String, required: true },
  status: { type: String, enum: ['active', 'paused', 'archived'], default: 'active' },

  landing_page_id: { type: mongoose.Schema.Types.ObjectId, ref: 'LandingPage' },
  safe_page_id: { type: mongoose.Schema.Types.ObjectId, ref: 'LandingPage' },

  // Which profile to apply for scoring
  source_profile: {
    type: String,
    enum: ['email', 'paid_ads', 'organic', 'affiliate', 'mixed'],
    default: 'mixed',
  },

  filter_config: {
    threshold: { type: Number, default: 70, min: 0, max: 100 },
    mode: { type: String, enum: ['log_only', 'enforce'], default: 'log_only' },
    rule_overrides: { type: mongoose.Schema.Types.Mixed, default: {} },

    // UTM gate: when enabled, visits missing required UTM keys are routed to safe page.
    // Useful to keep direct/scraped visits off the offer.
    utm_gate: {
      enabled: { type: Boolean, default: false },
      required_keys: {
        type: [String],
        enum: ['source', 'medium', 'campaign', 'term', 'content'],
        default: ['source', 'medium', 'campaign'],
      },
    },

    // Country gate: cross-check ProxyCheck's country verdict against an allowlist or blocklist.
    // Stored as ISO 3166-1 alpha-2 codes (e.g. 'US', 'GB', 'IN').
    country_gate: {
      enabled: { type: Boolean, default: false },
      mode: { type: String, enum: ['whitelist', 'blacklist'], default: 'whitelist' },
      countries: { type: [String], default: [] },
      // What to do when ProxyCheck doesn't return a country (lookup failed, no key, etc.)
      // 'allow' = treat as pass (permissive), 'block' = treat as fail (strict)
      on_unknown: { type: String, enum: ['allow', 'block'], default: 'allow' },
    },

    // Proxy gate: tighter version of network scoring - hard route to safe page on detection.
    // Reads from the network filter's enrichment (ProxyCheck verdict + ASN/term blacklist match).
    proxy_gate: {
      enabled: { type: Boolean, default: false },
      // Which kinds of proxies to block - finer-grained than just "is_proxy"
      block_vpn: { type: Boolean, default: true },
      block_tor: { type: Boolean, default: true },
      block_public_proxy: { type: Boolean, default: true },
      block_compromised: { type: Boolean, default: true },
      // Datacenter/hosting IPs are a softer signal - not always bad (corporate VPNs, etc.)
      block_hosting: { type: Boolean, default: false },
      // Use ProxyCheck's own risk score (0-100) as a separate threshold
      max_risk_score: { type: Number, default: 100, min: 0, max: 100 },
    },
  },

  // Conversion tracking
  postback_url: String,
  conversion_pixel: String,

  // Optional cost & metadata
  notes: String,
  tags: [String],

  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

CampaignSchema.index({ workspace_id: 1, slug: 1 }, { unique: true });
CampaignSchema.index({ workspace_id: 1, status: 1 });

CampaignSchema.pre('save', function (next) {
  this.updated_at = new Date();
  next();
});

module.exports = mongoose.model('Campaign', CampaignSchema);
