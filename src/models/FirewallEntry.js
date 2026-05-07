/**
 * FirewallEntry - deduplicated record of every IP that BotGuard flagged as
 * non-human / fraudulent / proxy. One document per unique IP per workspace.
 *
 * Why a separate collection from Click:
 *   - Bot IPs hit hundreds of times per hour. We want one row per IP, not
 *     one per click, so the admin firewall view is browsable and the CSV
 *     export fits in Google Ads' 500-IP cap per exclusion list.
 *   - Repeat hits should accumulate evidence (more reasons, higher count)
 *     not duplicate rows.
 *   - Indexable + filterable by date range without scanning the much-larger
 *     Click collection.
 *   - Some signals (challenge failure, postback abuse) aren't always tied
 *     to a Click document; FirewallEntry is the unified place.
 *
 * What goes in here (high-confidence fraud signals only):
 *   - ProxyCheck flagged: proxy / vpn / tor
 *   - ProxyCheck flagged: datacenter
 *   - Behavioral bot detected (challenge failed, headless markers)
 *   - Source profile mismatch (paid_ads source from organic referer)
 *   - ASN blacklist hit
 *   - Hard-block hits from the scorer
 *
 * What stays OUT (may be added optionally later):
 *   - Country gate blocks (geographic, not fraud)
 *   - UTM gate blocks (often false positives - stripped UTMs from privacy
 *     extensions, copy-paste sharing, etc.)
 *   - Campaign paused / archived (not a signal at all)
 *   - Repeat-visitor session-dedup (same person, by definition)
 *
 * Reason-class taxonomy (used for filtering + export):
 *   'proxy'      - ProxyCheck proxy / vpn / tor
 *   'datacenter' - ProxyCheck flagged ASN type
 *   'bot'        - Behavioral / challenge / headless detection
 *   'asn'        - Manual ASN blacklist hit
 *   'hard_block' - Hard-block rule from scorer
 *   'source'     - Source profile mismatch
 *   'other'      - Anything else flagged the chain
 */

const mongoose = require('mongoose');

// All reason classes we recognize. Used as enum on the entry's reason_class
// arrays and for the export filter UI. Keep this list authoritative - the
// classify() helper below maps raw decision_reason strings to one of these.
const REASON_CLASSES = ['proxy', 'datacenter', 'bot', 'asn', 'hard_block', 'source', 'other'];

const FirewallEntrySchema = new mongoose.Schema({
  workspace_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace', required: true, index: true },

  // The IP itself. We dedupe on (workspace_id, ip) so unique constraint below.
  ip: { type: String, required: true, index: true },

  // Counts and timing
  hit_count:   { type: Number, default: 1 },
  first_seen:  { type: Date, default: Date.now, index: true },
  last_seen:   { type: Date, default: Date.now, index: true },

  // Reasons accumulated over time. Each unique decision_reason is added once.
  // We cap the array length to prevent unbounded growth (rare in practice -
  // most bot IPs trigger the same reason every hit - but defensively capped).
  reasons: [{ type: String }],

  // Reason classes that have been seen for this IP. Used for filter queries
  // (e.g. "show me only proxy/vpn flags") without scanning the reasons array.
  reason_classes: { type: [String], enum: REASON_CLASSES, default: [] },

  // Last-seen device label (iphone/android/windows/mac/linux/other) - useful
  // for understanding what a flagged actor was pretending to be.
  last_device: { type: String, default: '' },

  // Last-seen country (ISO-2). May be blank if ProxyCheck didn't return one
  // or the request was filtered before geo lookup.
  last_country: { type: String, default: '' },

  // Last-seen ASN provider name - "Cloudflare WARP", "DigitalOcean", etc.
  // Useful in the admin view to understand patterns at a glance.
  last_asn: { type: String, default: '' },

  // Last user-agent. Capped at 500 chars to bound document size.
  last_user_agent: { type: String, default: '', maxlength: 500 },

  // Last campaign hit. Just the slug, for display - we don't ref-populate.
  last_campaign_slug: { type: String, default: '' },

  // Whether the admin has reviewed/dismissed this entry. False means
  // "still appearing in the unreviewed list". True means "I've seen it,
  // optionally exported it, hide from default view but keep the data".
  reviewed: { type: Boolean, default: false, index: true },

  // Free-form admin notes. Useful when manually whitelisting (e.g. "this
  // is a customer's office VPN, don't auto-flag").
  notes: { type: String, default: '', maxlength: 500 },
});

// Dedup constraint: one entry per (workspace, IP)
FirewallEntrySchema.index({ workspace_id: 1, ip: 1 }, { unique: true });

// Common query patterns - "what did we flag in the last 7 days, sorted by
// most recently seen" needs an index on (workspace_id, last_seen).
FirewallEntrySchema.index({ workspace_id: 1, last_seen: -1 });

// "Show only proxy hits in the last 30 days"
FirewallEntrySchema.index({ workspace_id: 1, reason_classes: 1, last_seen: -1 });

/**
 * Map a raw decision_reason string (as set in routes/go.js and decide.js)
 * to one of our REASON_CLASSES. Returns null if the reason should NOT be
 * recorded in the firewall (e.g. country gate, UTM gate).
 *
 * This is the gatekeeper for what goes in vs what stays out. If you add
 * a new decision_reason elsewhere in the codebase, update this mapping.
 */
function classify(decision_reason) {
  if (!decision_reason || typeof decision_reason !== 'string') return null;

  // Excluded categories - these are NOT fraud signals and should not pollute
  // the IP exclusion lists we feed back to Google Ads.
  if (decision_reason.startsWith('country_gate:')) return null;
  if (decision_reason.startsWith('utm_gate:')) return null;
  if (decision_reason === 'campaign_paused') return null;
  if (decision_reason === 'campaign_archived') return null;
  if (decision_reason === 'no_filters_yet') return null;
  if (decision_reason === 'allow') return null;
  if (decision_reason.startsWith('under_threshold:')) return null;

  // Included categories
  if (decision_reason.startsWith('proxy_gate:')) {
    // proxy_gate:proxy, proxy_gate:vpn, proxy_gate:tor, proxy_gate:datacenter
    if (/datacenter|hosting/i.test(decision_reason)) return 'datacenter';
    return 'proxy';
  }
  if (decision_reason.startsWith('asn_blacklist:')) return 'asn';
  if (decision_reason.startsWith('hard_block:')) return 'hard_block';
  if (decision_reason.startsWith('prefetcher:')) return 'bot';
  if (decision_reason.startsWith('threshold:')) return 'bot';
  if (decision_reason.startsWith('source_mismatch')) return 'source';
  if (decision_reason.startsWith('challenge_failed')) return 'bot';
  if (decision_reason.startsWith('headless')) return 'bot';

  return 'other';
}

FirewallEntrySchema.statics.classify = classify;
FirewallEntrySchema.statics.REASON_CLASSES = REASON_CLASSES;

module.exports = mongoose.model('FirewallEntry', FirewallEntrySchema);
module.exports.classify = classify;
module.exports.REASON_CLASSES = REASON_CLASSES;
