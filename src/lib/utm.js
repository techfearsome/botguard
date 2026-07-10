/**
 * Extract UTM params and external ad-platform click IDs from a query object.
 * All fields default to null/undefined - never throws on missing data.
 *
 * IMPORTANT - case sensitivity:
 *   gclid / wbraid / gbraid are CASE-SENSITIVE per Google Ads documentation.
 *   Conversion uploads with case-altered identifiers are silently rejected
 *   by the Google Ads API. We deliberately do NOT .toLowerCase() these
 *   values - they're stored exactly as the ad platform sent them.
 *   Likewise for fbclid, msclkid, ttclid, li_fat_id - all stored verbatim.
 */

const UTM_KEYS = ['source', 'medium', 'campaign', 'term', 'content'];

// External click identifiers from each ad platform. Order matters for
// readability of the click-detail admin view - Google's three are grouped.
const EXTERNAL_ID_KEYS = [
  'gclid',     // Google Ads - non-iOS or iOS-with-ATT-consent
  'wbraid',    // Google Ads - iOS in-app ad → web destination (most common iOS path)
  'gbraid',    // Google Ads - iOS web ad → iOS app destination
  'fbclid',    // Facebook / Instagram
  'msclkid',   // Microsoft Bing
  'ttclid',    // TikTok
  'li_fat_id', // LinkedIn
  'twclid',    // Twitter / X
  'rdt_cid',   // Reddit
];

// Google Ads ValueTrack parameter names. The key in our captured object is
// the parameter name AS IT SHOULD APPEAR in the URL query string. Following
// Google's recommended convention, the URL parameter name matches the
// ValueTrack placeholder name without the braces, e.g. ?campaignid={campaignid}
// places the value in click.valuetrack.google.campaignid.
//
// If an advertiser uses non-conventional URL parameter names (e.g.
// ?my_campaign={campaignid}), the value won't be captured here - that's an
// accepted tradeoff. Following the conventional naming makes the data shape
// predictable and matches every Google template/example in their docs.
//
// Split into "core" (used by every campaign type) and "shopping_travel"
// (only relevant if running shopping ads, hotel ads, or travel ads). We
// capture both - storage is cheap, and admins running shopping campaigns
// will want this data.
const GOOGLE_VALUETRACK_CORE = [
  'campaignid',           // numeric campaign ID
  'adgroupid',            // numeric ad group ID
  'creative',             // ad ID
  'keyword',              // search keyword (search campaigns)
  'matchtype',            // e (exact), p (phrase), b (broad), a (AI Max keywordless)
  'network',              // g (search), s (search partner), d (display), ytv (youtube), gtv (google tv), x (cross-network)
  'device',               // m (mobile), t (tablet), c (computer)
  'devicemodel',          // device model string (Pixel 7, iPhone15,2, etc.)
  'targetid',             // kwd-123:aud-456 type composite
  'placement',            // domain where ad was clicked (display network)
  'adposition',           // "1t2" = page 1, top, position 2
  'loc_physical_ms',      // ID of the geographic location of the click
  'loc_interest_ms',      // ID of the location of interest that triggered the ad
  'feeditemid',           // feed-based extension ID
  'extensionid',          // asset-based extension ID
];
const GOOGLE_VALUETRACK_SHOPPING_TRAVEL = [
  'product_id',
  'product_channel',
  'product_country',
  'product_language',
  'product_partition_id',
  'store_code',
  'merchant_id',
  'hotelcenter_id',
  'hotel_id',
  'rate_rule_id',
  'advanced_booking_window',
  'travel_start_day',
  'travel_start_month',
  'travel_start_year',
];
const GOOGLE_VALUETRACK_KEYS = [...GOOGLE_VALUETRACK_CORE, ...GOOGLE_VALUETRACK_SHOPPING_TRAVEL];

// Custom short-name aliases → canonical ValueTrack field.
// Many advertisers use compact tracking templates like:
//   cid={campaignid}&agid={adgroupid}&aid={creative}&kid={targetid}
//   &kw={keyword}&nw={network}&dv={device}&mt={matchtype}&pl={placement}
// This maps those short names to the standard fields so they're captured
// regardless of which naming convention the tracking template uses.
const GOOGLE_VALUETRACK_ALIASES = {
  cid:  'campaignid',
  agid: 'adgroupid',
  aid:  'creative',
  kid:  'targetid',
  kw:   'keyword',
  nw:   'network',
  dv:   'device',
  mt:   'matchtype',
  pl:   'placement',
  cr:   'creative',
  plc:  'placement',
  loc:  'loc_physical_ms',
  dm:   'devicemodel',
  adpos: 'adposition',
};

// Extra custom tracking parameters (not ValueTrack, but useful to capture).
const GOOGLE_CUSTOM_KEYS = [
  'tm', 'ap', 'aaid', 'sub', 'sub_id',
  's1', 's2', 's3', 's4', 's5',
  'clickid', 'source_id',
];

// Microsoft (Bing) Ads ValueTrack-style parameters. Bing uses CamelCase
// placeholder names ({MatchType}, {QueryString}, etc.) but advertisers
// typically use lowercase URL parameter names. We capture both common
// case variants in case the URL template uses one or the other.
const BING_VALUETRACK_KEYS = [
  // Lowercase variants (most common in URL templates)
  'querystring',          // raw search query
  'matchtype',            // e/p/b - Bing returns these the same as Google
  'network',              // o (Bing/Yahoo), s (syndicated), c (content)
  'device',               // m/t/c
  'adid',                 // Bing ad ID
  'campaignid',
  'adgroupid',
  'targetid',
  'orderitemid',
];

function parseUtm(query) {
  const utm = {};
  if (!query || typeof query !== 'object') return utm;
  for (const key of UTM_KEYS) {
    const v = query[`utm_${key}`];
    if (v && typeof v === 'string') utm[key] = v.slice(0, 256);
  }
  return utm;
}

function parseExternalIds(query) {
  const ext = {};
  if (!query || typeof query !== 'object') return ext;
  for (const key of EXTERNAL_ID_KEYS) {
    const v = query[key];
    // Verbatim capture - NO normalization. See the case-sensitivity note above.
    if (v && typeof v === 'string') ext[key] = v.slice(0, 512);
  }
  return ext;
}

/**
 * Capture Google Ads + Bing Ads ValueTrack parameters from the URL.
 *
 * Returns the nested shape:
 *   { google: { campaignid, keyword, matchtype, ... }, bing: { adid, ... } }
 *
 * Both subdocs only include keys that were actually present in the query
 * (empty values are excluded so the Click document stays small for the
 * common case of "no ValueTrack tagging on this URL").
 *
 * The Bing/Google key namespaces deliberately don't overlap with each
 * other in our schema even when the parameter names coincide (e.g. both
 * platforms have a 'campaignid' parameter) - we never see both on the
 * same URL since they come from different ad platforms.
 *
 * Disambiguation when names collide: we assume the click is Google if any
 * of (gclid, wbraid, gbraid) is present, Bing if msclkid is present, or
 * both buckets get populated if we can't tell (rare).
 */
function parseValueTrack(query) {
  const vt = {};
  if (!query || typeof query !== 'object') return vt;

  // Sniff which platform this click is from. Used only to avoid populating
  // BOTH buckets when a parameter name like 'campaignid' is ambiguous.
  const hasGoogleClickId = !!(query.gclid || query.wbraid || query.gbraid);
  const hasBingClickId = !!query.msclkid;

  // Default to Google semantics unless we definitively see a Bing click ID
  // and NOT a Google one. This optimizes for the more common case.
  const isGoogle = hasGoogleClickId || (!hasBingClickId);
  const isBing = hasBingClickId && !hasGoogleClickId;

  if (isGoogle) {
    const google = {};
    // Standard ValueTrack keys
    for (const key of GOOGLE_VALUETRACK_KEYS) {
      const v = query[key];
      if (v && typeof v === 'string') google[key] = v.slice(0, 512);
    }
    // Custom short-name aliases (cid, agid, aid, kw, etc.)
    for (const [alias, canonical] of Object.entries(GOOGLE_VALUETRACK_ALIASES)) {
      const v = query[alias];
      if (v && typeof v === 'string' && !google[canonical]) {
        google[canonical] = v.slice(0, 512);
      }
    }
    // Extra custom tracking parameters (tm, ap, aaid, sub-ids, etc.)
    for (const key of GOOGLE_CUSTOM_KEYS) {
      const v = query[key];
      if (v && typeof v === 'string') google[key] = v.slice(0, 512);
    }
    if (Object.keys(google).length > 0) vt.google = google;
  }
  if (isBing) {
    const bing = {};
    for (const key of BING_VALUETRACK_KEYS) {
      const v = query[key];
      if (v && typeof v === 'string') bing[key] = v.slice(0, 512);
    }
    if (Object.keys(bing).length > 0) vt.bing = bing;
  }

  return vt;
}

module.exports = {
  parseUtm,
  parseExternalIds,
  parseValueTrack,
  UTM_KEYS,
  EXTERNAL_ID_KEYS,
  GOOGLE_VALUETRACK_KEYS,
  GOOGLE_VALUETRACK_CORE,
  GOOGLE_VALUETRACK_SHOPPING_TRAVEL,
  BING_VALUETRACK_KEYS,
};
