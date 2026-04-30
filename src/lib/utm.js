/**
 * Extract UTM params and external ad-platform click IDs from a query object.
 * All fields default to null/undefined - never throws on missing data.
 */

const UTM_KEYS = ['source', 'medium', 'campaign', 'term', 'content'];
const EXTERNAL_ID_KEYS = ['gclid', 'fbclid', 'msclkid', 'ttclid', 'li_fat_id'];

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
    if (v && typeof v === 'string') ext[key] = v.slice(0, 512);
  }
  return ext;
}

module.exports = { parseUtm, parseExternalIds, UTM_KEYS, EXTERNAL_ID_KEYS };
