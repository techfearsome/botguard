/**
 * UTM gate filter.
 *
 * Some campaigns should ONLY accept traffic that comes through proper attribution
 * (e.g. an actual ad click that preserves utm_source/medium/campaign). When this
 * filter is enabled and any required UTM key is missing or empty, the visit is
 * routed to the campaign's safe page — keeping the offer page hidden from:
 *
 *   - Direct visits (someone typed/pasted the URL)
 *   - Scrapers crawling links found in the wild
 *   - Social shares that strip query strings
 *   - Anyone reverse-engineering your funnel by guessing the URL
 *
 * Crucially, this gate runs BEFORE scoring. A failed UTM gate is a hard block,
 * not a score contribution - the offer simply isn't shown.
 *
 * Returns:
 *   {
 *     blocked: bool,            // true = route to safe page
 *     missing_keys: [...],       // which required keys were absent
 *     flags: [...],
 *   }
 */
function utmGateCheck({ utm = {}, campaign }) {
  const gate = campaign?.filter_config?.utm_gate;
  if (!gate || !gate.enabled) {
    return { blocked: false, missing_keys: [], flags: ['utm_gate_off'] };
  }

  const required = Array.isArray(gate.required_keys) && gate.required_keys.length > 0
    ? gate.required_keys
    : ['source', 'medium', 'campaign'];

  const missing = [];
  for (const key of required) {
    const value = utm?.[key];
    if (!value || typeof value !== 'string' || !value.trim()) {
      missing.push(key);
    }
  }

  if (missing.length === 0) {
    return { blocked: false, missing_keys: [], flags: ['utm_gate_pass'] };
  }

  return {
    blocked: true,
    missing_keys: missing,
    flags: ['utm_gate_fail', ...missing.map((k) => `utm_missing_${k}`)],
  };
}

module.exports = { utmGateCheck };
