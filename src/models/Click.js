const mongoose = require('mongoose');

const ClickSchema = new mongoose.Schema({
  click_id: { type: String, required: true, unique: true },
  workspace_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },
  campaign_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', required: true, index: true },

  ts: { type: Date, default: Date.now, index: true },

  // Network
  ip: String,
  ip_hash: String,         // sha256 of ip - for privacy-respecting joins
  asn: Number,
  asn_org: String,         // ProxyCheck "provider" field, e.g. "OVH SAS"
  organisation: String,    // ProxyCheck "organisation" field, e.g. "Smtp.fr - Emailing Services"
  operator: String,        // VPN/proxy operator name when ProxyCheck identifies one
  country: String,         // ISO alpha-2
  country_name: String,    // human-readable
  region: String,
  city: String,
  ip_type: String,         // ProxyCheck network.type: 'hosting'|'residential'|'business'|'mobile'|'wireless'|...
  is_proxy: Boolean,       // ANY of {proxy, vpn, tor, compromised, anonymous}
  proxy_type: String,      // 'TOR' | 'VPN' | 'PUB' | 'COM' | null
  hosting: Boolean,        // ProxyCheck detection.hosting (separate from is_proxy)
  scraper: Boolean,        // ProxyCheck detection.scraper
  risk_score: Number,      // ProxyCheck risk 0-100

  // Device / UA
  user_agent: String,
  ua_parsed: {
    browser: String,
    browser_version: String,
    os: String,
    os_version: String,
    device_type: String,    // 'desktop' | 'mobile' | 'tablet' | 'bot'
    device_label: String,   // human-readable: 'iPhone', 'Android phone', 'Windows', 'Mac', etc.
    device_vendor: String,  // 'Apple', 'Samsung', etc. (when known)
    device_model: String,   // 'iPhone', 'SM-G991B', etc. (when known)
    is_bot: Boolean,
  },

  // Referer & in-app browser detection
  referer: String,
  referer_host: String,
  in_app_browser: { type: String, default: null },  // 'fb' | 'ig' | 'tiktok' | 'linkedin' | null

  // Attribution
  utm: {
    source: String,
    medium: String,
    campaign: String,
    term: String,
    content: String,
  },
  external_ids: {
    gclid: String,
    fbclid: String,
    msclkid: String,
    ttclid: String,
    li_fat_id: String,
  },

  // Fingerprint (populated by JS challenge in week 2)
  fingerprint: {
    canvas: String,
    webgl: String,
    screen: String,
    tz: String,
    lang: String,
    hash: String,
  },

  // Scores (week 2 - all zeros for week 1)
  scores: {
    network: { type: Number, default: 0 },
    headers: { type: Number, default: 0 },
    behavior: { type: Number, default: 0 },
    pattern: { type: Number, default: 0 },
    referer: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    profile_used: String,
    flags: [String],       // human-readable flags: 'datacenter_asn', 'missing_accept_lang', etc.
  },

  // Decision
  decision: { type: String, enum: ['allow', 'block', 'would_block'], default: 'allow' },
  decision_reason: String,
  mode_at_decision: String,  // 'log_only' or 'enforce' - so we can replay

  // What happened
  variant_shown: String,
  page_rendered: String,     // 'offer' | 'safe' | 'redirect'
  redirect_url: String,

  // Session linkage
  session_id: { type: String, index: true },
}, {
  // Disable __v and avoid auto-creating updatedAt since this is an append-only event log
  versionKey: false,
});

// Indexes for the queries we'll actually run
ClickSchema.index({ workspace_id: 1, ts: -1 });
ClickSchema.index({ campaign_id: 1, ts: -1 });
ClickSchema.index({ workspace_id: 1, decision: 1, ts: -1 });
ClickSchema.index({ ip_hash: 1, ts: -1 });
ClickSchema.index({ 'utm.source': 1, ts: -1 });
ClickSchema.index({ asn: 1 });

module.exports = mongoose.model('Click', ClickSchema);
