/**
 * Source profiles - how each filter layer's score gets weighted into the total.
 *
 * The total is computed as:
 *   total = round( sum( layer_score * weight ) / sum( weights ) )
 *
 * Different traffic sources need different sensitivities:
 *
 *   - email: be very forgiving on network/headers/behavior signals because Outlook/Apple/Gmail
 *           proxies hit URLs with bot-like fingerprints. Lean on referrer integrity less since
 *           email clients usually don't send a referer.
 *
 *   - paid_ads: click fraud is the main threat. Trust ad-platform click IDs (gclid/fbclid)
 *           via referer filter; weight network and pattern heavily because click farms
 *           run from datacenters and rotate IPs.
 *
 *   - organic: search engine bots are legit but should be flagged separately. Real organic
 *           visitors have full browser fingerprints. Weight behavior and headers normally.
 *
 *   - affiliate: highest fraud risk. Weight everything aggressively, especially pattern
 *           (affiliates often farm clicks) and referer (mismatches indicate cloaking).
 *
 *   - mixed: balanced default for campaigns serving multiple sources.
 */

const PROFILES = {
  email: {
    weights:   { network: 0.5, headers: 0.5, behavior: 0.5, pattern: 1.0, referer: 0.0 },
    threshold_default: 80,   // very permissive
    notes: 'Forgives prefetcher-like fingerprints. Ignores referer (email rarely sends one).',
  },
  paid_ads: {
    weights:   { network: 1.5, headers: 1.0, behavior: 1.2, pattern: 1.5, referer: 1.0 },
    threshold_default: 65,
    notes: 'Click fraud is the main risk - heavy on network and pattern.',
  },
  organic: {
    weights:   { network: 1.0, headers: 1.0, behavior: 1.0, pattern: 1.0, referer: 0.5 },
    threshold_default: 70,
    notes: 'Balanced; treats known crawlers as flagged-but-allowed.',
  },
  affiliate: {
    weights:   { network: 1.3, headers: 1.0, behavior: 1.0, pattern: 1.5, referer: 1.5 },
    threshold_default: 60,
    notes: 'Highest fraud risk - heavy on pattern and referer integrity.',
  },
  mixed: {
    weights:   { network: 1.0, headers: 1.0, behavior: 1.0, pattern: 1.0, referer: 1.0 },
    threshold_default: 70,
    notes: 'Balanced default.',
  },
};

function getProfile(name) {
  return PROFILES[name] || PROFILES.mixed;
}

module.exports = { PROFILES, getProfile };
