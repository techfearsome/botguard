/**
 * Country gate filter.
 *
 * Cross-checks ProxyCheck's country verdict against a per-campaign allowlist or blocklist.
 * Runs AFTER the network filter so we have an enriched country code to check.
 *
 * Modes:
 *   - whitelist: only listed countries pass; everything else → safe page
 *   - blacklist: listed countries blocked; everything else passes
 *
 * Unknown countries (ProxyCheck unavailable, no API key, IPv6 quirks):
 *   - on_unknown='allow' (default): treat as pass - the click reaches the offer
 *   - on_unknown='block': treat as fail - the click goes to the safe page
 *
 * Country codes are stored uppercase ISO 3166-1 alpha-2 (US, GB, IN, etc.).
 *
 * Returns:
 *   {
 *     blocked: bool,
 *     country: string | null,
 *     mode: 'whitelist' | 'blacklist',
 *     flags: [...]
 *   }
 */
function countryGateCheck({ country, campaign }) {
  const gate = campaign?.filter_config?.country_gate;
  if (!gate || !gate.enabled) {
    return { blocked: false, country: country || null, flags: ['country_gate_off'] };
  }

  const mode = gate.mode === 'blacklist' ? 'blacklist' : 'whitelist';
  const list = (Array.isArray(gate.countries) ? gate.countries : [])
    .map((c) => String(c).toUpperCase().trim())
    .filter(Boolean);

  // No country resolved (lookup failed) - on_unknown decides
  if (!country) {
    if (gate.on_unknown === 'block') {
      return {
        blocked: true,
        country: null,
        mode,
        flags: ['country_gate_unknown_blocked'],
      };
    }
    return { blocked: false, country: null, mode, flags: ['country_gate_unknown_allowed'] };
  }

  const upper = String(country).toUpperCase();
  const inList = list.includes(upper);

  // Whitelist with empty list = nothing passes (probably a misconfig; let it through with a flag)
  if (mode === 'whitelist' && list.length === 0) {
    return { blocked: false, country: upper, mode, flags: ['country_gate_empty_whitelist'] };
  }

  if (mode === 'whitelist') {
    if (inList) {
      return { blocked: false, country: upper, mode, flags: [`country_allowed_${upper}`] };
    }
    return {
      blocked: true,
      country: upper,
      mode,
      flags: ['country_gate_fail', `country_blocked_${upper}`],
    };
  }

  // Blacklist
  if (inList) {
    return {
      blocked: true,
      country: upper,
      mode,
      flags: ['country_gate_fail', `country_blocked_${upper}`],
    };
  }
  return { blocked: false, country: upper, mode, flags: [`country_allowed_${upper}`] };
}

module.exports = { countryGateCheck };
