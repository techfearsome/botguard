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

  // ProxyCheck "operator" - when the IP is identified as belonging to a known VPN/proxy service,
  // this is a rich object with the operator's profile. Stored as Mixed because the shape varies
  // and we want to preserve everything for forensics.
  // Convenience denormalized fields for quick display:
  operator: { type: mongoose.Schema.Types.Mixed, default: null },
  operator_name: String,   // e.g. "NordVPN", "ExpressVPN", "VPN Unlimited"
  operator_anonymity: String,  // 'low' | 'medium' | 'high'
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

  // Layer 2 residential proxy detection (ipgeolocation.io / Spur / ipinfo.io)
  // Stored as Mixed because the shape varies by provider and includes raw response
  ipgeo_security: { type: mongoose.Schema.Types.Mixed, default: null },

  // Device / UA
  user_agent: String,
  ua_parsed: {
    browser: String,
    browser_version: String,
    os: String,
    os_version: String,
    device_type: String,    // 'desktop' | 'mobile' | 'tablet' | 'bot'
    device_label: String,   // human-readable: 'iPhone', 'Android phone', 'Windows', 'Mac', etc.
    device_class: String,   // routing key: 'iphone'|'android'|'windows'|'mac'|'linux'|'other'
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
    // Google Ads click identifiers. Stored case-sensitive (Google Ads API
    // rejects uploads with case-altered values). gclid is the deterministic
    // per-click identifier; wbraid/gbraid are iOS privacy-preserving
    // aggregate identifiers used when GCLID can't be sent due to App
    // Tracking Transparency. Either wbraid or gbraid may appear instead of
    // or alongside gclid on the same click.
    gclid:  String,    // non-iOS, or iOS with ATT consent (deterministic)
    wbraid: String,    // iOS in-app ad → web (most common iOS pattern)
    gbraid: String,    // iOS web ad → iOS app handoff
    // Other ad platforms - same case-sensitive verbatim-capture rule.
    fbclid: String,    // Facebook / Instagram
    msclkid: String,   // Microsoft Bing
    ttclid: String,    // TikTok
    li_fat_id: String, // LinkedIn
  },

  // Ad-platform ValueTrack parameters - the dynamic placeholders Google
  // Ads and Bing Ads replace with real values at click time (e.g. {keyword},
  // {campaignid}, {matchtype}, {placement}). Captured into a nested subdoc
  // keyed by platform so we can show "Google said this click came from
  // keyword 'cooking school nyc' with match_type 'exact'" in the click
  // detail view.
  //
  // Schema.Types.Mixed because the set of keys varies by ad platform and
  // by campaign type (shopping vs search vs display). The allowlist of
  // valid keys lives in src/lib/utm.js so junk URL params can't pollute
  // this subdoc - parseValueTrack() filters before write.
  //
  // Shape: { google: { campaignid, keyword, matchtype, ... }, bing: {...} }
  valuetrack: {
    google: { type: mongoose.Schema.Types.Mixed, default: undefined },
    bing:   { type: mongoose.Schema.Types.Mixed, default: undefined },
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

  // Conversion tracking - denormalized counters so the click log can show badges without joining
  conversion_count: { type: Number, default: 0 },        // total conversions for this click_id
  auto_conversion_count: { type: Number, default: 0 },   // subset that came from the auto-injection
  last_conversion_at: Date,
  decision: { type: String, enum: ['allow', 'block', 'would_block'], default: 'allow' },
  decision_reason: String,
  mode_at_decision: String,  // 'log_only' or 'enforce' - so we can replay

  // What happened
  variant_shown: String,
  page_rendered: String,     // 'offer' | 'safe' | 'redirect'
  landing_page_id: { type: mongoose.Schema.Types.ObjectId, ref: 'LandingPage' },
  // Diagnostic: was auto-conversion injection actually applied to the response HTML?
  // Useful for confirming the script is reaching the visitor's browser.
  auto_conv_injected: { type: Boolean, default: false },
  redirect_url: String,

  // Session linkage
  session_id: { type: String, index: true },

  // Engagement — written back from LivePresence when visitor leaves.
  // null = visitor hasn't left yet or heartbeat script didn't load (blocked/safe page).
  // 0 = arrived and immediately left (no heartbeat received).
  // Milliseconds from arrived_at to last heartbeat.
  dwell_ms: { type: Number, default: null },
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

// External-click-ID indexes - sparse so the index only stores documents
// where the field is set (most clicks have at most one of these). These
// will be used by the Google Ads conversion uploader to find the matching
// click for a given conversion, and by admins debugging attribution.
ClickSchema.index({ workspace_id: 1, 'external_ids.gclid': 1 }, { sparse: true });
ClickSchema.index({ workspace_id: 1, 'external_ids.wbraid': 1 }, { sparse: true });
ClickSchema.index({ workspace_id: 1, 'external_ids.gbraid': 1 }, { sparse: true });
ClickSchema.index({ workspace_id: 1, 'external_ids.fbclid': 1 }, { sparse: true });
ClickSchema.index({ workspace_id: 1, 'external_ids.msclkid': 1 }, { sparse: true });

module.exports = mongoose.model('Click', ClickSchema);
