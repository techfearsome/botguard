/**
 * UTM gate filter.
 *
 * Some campaigns should ONLY accept traffic that comes through proper attribution
 * (e.g. an actual ad click that preserves utm_source/medium/campaign). When this
 * filter is enabled and any required UTM key is missing or empty, the visit is
 * (in enforce mode) routed to the campaign's safe page — keeping the offer page
 * hidden from:
 *
 *   - Direct visits (someone typed/pasted the URL)
 *   - Scrapers crawling links found in the wild
 *   - Social shares that strip query strings
 *   - Anyone reverse-engineering your funnel by guessing the URL
 *
 * Crucially, this gate runs BEFORE scoring. In enforce mode a failed UTM gate is
 * a hard block, not a score contribution - the offer simply isn't shown.
 *
 * Modes (gate.mode):
 *   - 'enforce' (default): missing required keys → block to safe page.
 *   - 'monitor'          : missing required keys → DO NOT block. The click still
 *                          reaches the offer, but the missing keys are flagged on
 *                          the click so you can audit attribution in the Click Log
 *                          before committing to enforcement. Nothing is hidden.
 *
 * Returns:
 *   {
 *     blocked: bool,            // true = route to safe page (enforce + missing only)
 *     missing_keys: [...],       // which required keys were absent
 *     flags: [...],
 *     mode: 'off'|'enforce'|'monitor',
 *   }
 */
function utmGateCheck({ utm = {}, campaign }) {
  const gate = campaign?.filter_config?.utm_gate;
  if (!gate || !gate.enabled) {
    return { blocked: false, missing_keys: [], flags: ['utm_gate_off'], mode: 'off' };
  }

  // Default to 'enforce' so existing enabled gates keep their block behavior.
  const mode = gate.mode === 'monitor' ? 'monitor' : 'enforce';

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
    return { blocked: false, missing_keys: [], flags: ['utm_gate_pass'], mode };
  }

  // Missing keys. In monitor mode we flag but let the visit through; in enforce
  // mode we block to the safe page.
  const missingFlags = missing.map((k) => `utm_missing_${k}`);
  if (mode === 'monitor') {
    return {
      blocked: false,
      missing_keys: missing,
      // Distinct flag so the Click Log shows "would have blocked, but monitoring".
      flags: ['utm_gate_monitor_would_block', ...missingFlags],
      mode,
    };
  }

  return {
    blocked: true,
    missing_keys: missing,
    flags: ['utm_gate_fail', ...missingFlags],
    mode,
  };
}

module.exports = { utmGateCheck };
