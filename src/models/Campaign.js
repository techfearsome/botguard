const mongoose = require('mongoose');

const CampaignSchema = new mongoose.Schema({
  workspace_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  slug: { type: String, required: true, lowercase: true, trim: true },

  // Optional custom root path - lets a campaign be reached at /<root_path>
  // in addition to the default /go/<slug>. Empty string means no custom path.
  // Validated against a reserved-paths list so campaigns can't shadow system
  // routes like /admin or /privacy. See lib/reservedPaths.js.
  root_path: { type: String, default: '', lowercase: true, trim: true, index: true },
  name: { type: String, required: true },
  status: { type: String, enum: ['active', 'paused', 'archived'], default: 'active' },

  // Whether crawlers may index this campaign's URLs.
  //
  // Default false (paid-traffic destinations should typically NOT be in search
  // results - organic clicks would be unfiltered and could trigger ad-platform
  // quality reviews for cloaking discrepancies). Admins can flip this on for
  // campaigns where organic SEO traffic is desired (e.g. evergreen landing
  // pages, content marketing).
  //
  // Effects when true:
  //   - robots.txt emits Allow: /go/<slug> (overrides the blanket Disallow: /go/)
  //   - root_path Disallow line is omitted
  //   - X-Robots-Tag noindex header is NOT set on the response
  //   - The campaign URLs appear in /sitemap.xml
  //
  // CAVEAT: indexable campaigns still run through the full filter chain.
  // If gates (country, proxy, UTM) reject Googlebot, crawlers see only the
  // safe page or a 404. The admin must consider this when enabling.
  indexable: { type: Boolean, default: false },

  landing_page_id: { type: mongoose.Schema.Types.ObjectId, ref: 'LandingPage' },
  safe_page_id: { type: mongoose.Schema.Types.ObjectId, ref: 'LandingPage' },

  // Per-device-class page overrides. When set, these win over landing_page_id / safe_page_id
  // for that specific device class. When unset, the campaign-level defaults are used.
  // Device classes: 'iphone' | 'android' | 'windows' | 'mac' | 'linux' | 'other'
  device_pages: {
    iphone:  { offer: { type: mongoose.Schema.Types.ObjectId, ref: 'LandingPage' }, safe: { type: mongoose.Schema.Types.ObjectId, ref: 'LandingPage' } },
    android: { offer: { type: mongoose.Schema.Types.ObjectId, ref: 'LandingPage' }, safe: { type: mongoose.Schema.Types.ObjectId, ref: 'LandingPage' } },
    windows: { offer: { type: mongoose.Schema.Types.ObjectId, ref: 'LandingPage' }, safe: { type: mongoose.Schema.Types.ObjectId, ref: 'LandingPage' } },
    mac:     { offer: { type: mongoose.Schema.Types.ObjectId, ref: 'LandingPage' }, safe: { type: mongoose.Schema.Types.ObjectId, ref: 'LandingPage' } },
    linux:   { offer: { type: mongoose.Schema.Types.ObjectId, ref: 'LandingPage' }, safe: { type: mongoose.Schema.Types.ObjectId, ref: 'LandingPage' } },
    other:   { offer: { type: mongoose.Schema.Types.ObjectId, ref: 'LandingPage' }, safe: { type: mongoose.Schema.Types.ObjectId, ref: 'LandingPage' } },
  },

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

    // Click Identifier gate: require a platform click ID (gclid/wbraid/gbraid/msclkid).
    // Every real ad click carries one via auto-tagging. A visit with valid UTMs
    // but no click ID is likely a copy/paste, scraper, or bot replaying a URL.
    clickid_gate: {
      enabled: { type: Boolean, default: false },
      accepted_ids: {
        type: [String],
        enum: ['gclid', 'wbraid', 'gbraid', 'msclkid', 'fbclid', 'ttclid', 'li_fat_id', 'twclid', 'rdt_cid'],
        default: ['gclid', 'wbraid', 'gbraid'],
      },
      // Format validation: 'off' (presence only), 'loose' (length+charset),
      // 'strict' (platform patterns + entropy). Catches lazy fakes like gclid=123.
      validate_format: { type: String, enum: ['off', 'loose', 'strict'], default: 'off' },
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

// Unique within workspace, but only when root_path is set. Two campaigns with
// no custom path are fine; two campaigns claiming the same /promo are not.
CampaignSchema.index(
  { workspace_id: 1, root_path: 1 },
  {
    unique: true,
    partialFilterExpression: { root_path: { $type: 'string', $ne: '' } },
  }
);

CampaignSchema.pre('save', function (next) {
  this.updated_at = new Date();
  next();
});

module.exports = mongoose.model('Campaign', CampaignSchema);
