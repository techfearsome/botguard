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

module.exports = { parseUtm, parseExternalIds, UTM_KEYS, EXTERNAL_ID_KEYS };
