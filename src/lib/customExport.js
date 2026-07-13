/**
 * customExport.js — pure helpers for the intelligence Custom Export.
 *
 * Kept separate from the route so the param normalization and the
 * expand/drop/limit shaping can be unit-tested without a DB or an HTTP server.
 */

'use strict';

const { expandForGoogleAds } = require('./gadsFormat');

// Google Ads caps IP exclusions at 500 per campaign — default the limit there-ish.
const CUSTOM_EXPORT_PRESETS = [100, 200, 300, 400, 500];
const CUSTOM_EXPORT_MAX = 5000;

// Parse a free-form list of ISO alpha-2 country codes ("us, de  fr\nGB") into a
// clean, upper-cased, de-duped array of valid 2-letter codes.
function parseCountryCodes(raw) {
  if (!raw) return [];
  const seen = new Set();
  return String(raw)
    .split(/[\s,;]+/)
    .map((s) => s.trim().toUpperCase())
    .filter((s) => /^[A-Z]{2}$/.test(s) && !seen.has(s) && seen.add(s));
}

/**
 * Normalize/clamp query params from the Custom Export form.
 * @returns {{minScore, frequency, version, rank, limit, countryMode, countries}}
 */
function parseCustomExportParams(query = {}) {
  const minScore = Math.min(Math.max(parseInt(query.min_score, 10) || 60, 0), 100);
  const frequency = ['all', 'high', 'medium', 'low', 'labelled', 'unlabelled'].includes(query.frequency)
    ? query.frequency : 'all';
  const version = ['all', 'v4', 'v6'].includes(query.version) ? query.version : 'all';
  const rank = query.rank === 'frequency' ? 'frequency' : 'score';
  let limit = parseInt(query.limit, 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 200;
  limit = Math.min(limit, CUSTOM_EXPORT_MAX);

  // Country include/exclude (ISO alpha-2, matches stored country_code).
  const countryMode = ['include', 'exclude'].includes(query.country_mode) ? query.country_mode : 'off';
  const countries = parseCountryCodes(query.countries);

  return { minScore, frequency, version, rank, limit, countryMode, countries };
}

/**
 * Mutate a Mongo filter object to apply the ISO country include/exclude.
 * - include: keep only listed countries ($in) — entries with no country are dropped.
 * - exclude: drop listed countries ($nin) — entries with no country are KEPT.
 * A mode of 'off' or an empty code list is a no-op (no filtering).
 *
 * Applied to the same filter used for both the docs query and the
 * totalEligible count, so the "top N of M" numbers stay consistent.
 *
 * @returns {object} the same filter (for chaining/clarity)
 */
function applyCountryFilter(filter, params) {
  if (!filter || !params) return filter;
  if (params.countryMode === 'include' && params.countries.length) {
    filter.country = { $in: params.countries };
  } else if (params.countryMode === 'exclude' && params.countries.length) {
    filter.country = { $nin: params.countries };
  }
  return filter;
}

/**
 * Turn raw CidrIntelligence docs (already filtered + sorted by the DB) into
 * export rows: emit Google-Ads-safe form, drop ranges Google Ads can't accept,
 * and cap at `limit`. Input order is preserved (the DB did the ranking).
 *
 * @param {Array<object>} docs
 * @param {number} limit
 * @returns {Array<object>} rows with an added `out` (Google-Ads form)
 */
function shapeCustomExportRows(docs, limit) {
  const rows = [];
  for (const d of docs || []) {
    const out = expandForGoogleAds(d.cidr);
    if (!out) continue; // unsupported mask for Google Ads → drop
    rows.push({
      cidr: d.cidr,
      out,
      score: d.score,
      hit_count: d.hit_count,
      conversion_count: d.conversion_count,
      frequency_label: d.frequency_label,
      ip_version: d.ip_version,
      asn_org: d.asn_org,
      country: d.country,
    });
    if (rows.length >= limit) break;
  }
  return rows;
}

// Mongo sort spec for the chosen ranking.
function rankSort(rank) {
  return rank === 'frequency'
    ? { hit_count: -1, score: -1 }
    : { score: -1, hit_count: -1 };
}

module.exports = {
  CUSTOM_EXPORT_PRESETS,
  CUSTOM_EXPORT_MAX,
  parseCountryCodes,
  parseCustomExportParams,
  applyCountryFilter,
  shapeCustomExportRows,
  rankSort,
};
