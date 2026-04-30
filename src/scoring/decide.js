const { getProfile } = require('./profiles');

/**
 * Combine layer scores into a final total using source profile weights, then apply
 * the campaign's threshold and mode to produce a decision.
 *
 * Inputs:
 *   layerScores: { network, headers, behavior, pattern, referer } - each 0-100
 *   layerFlags:  { network: [...], headers: [...], ... }          - flag arrays
 *   profile:     'email' | 'paid_ads' | 'organic' | 'affiliate' | 'mixed'
 *   campaign:    { filter_config: { threshold, mode, rule_overrides } }
 *   prefetcher:  { is_prefetcher, kind } | null
 *
 * Output:
 *   {
 *     total:          number 0-100,
 *     profile_used:   string,
 *     flags:          [...] flat list across all layers
 *     decision:       'allow' | 'block' | 'would_block',
 *     decision_reason: string,
 *     mode_at_decision: string
 *   }
 *
 * Decision rules:
 *   1. Hard-block flags (asn_hard_block, ua_obvious_bot at score 90+) → block in enforce, would_block in log_only
 *   2. Prefetcher flag → ALWAYS allow + tag (regardless of score)
 *   3. Otherwise compare total to threshold → block / would_block / allow
 */

const HARD_BLOCK_FLAGS = new Set([
  'asn_hard_block',
  'webdriver_flag',
]);

function decide({ layerScores, layerFlags, profile, campaign, prefetcher }) {
  const profileDef = getProfile(profile);
  const weights = profileDef.weights;

  // Weighted average across layers
  let weightedSum = 0;
  let weightTotal = 0;
  for (const [layer, score] of Object.entries(layerScores)) {
    const w = weights[layer] ?? 1.0;
    weightedSum += (score || 0) * w;
    weightTotal += w;
  }
  const total = weightTotal > 0 ? Math.round(weightedSum / weightTotal) : 0;

  // Flatten all flags
  const allFlags = [];
  for (const fl of Object.values(layerFlags)) {
    if (Array.isArray(fl)) allFlags.push(...fl);
  }

  const threshold = campaign?.filter_config?.threshold ?? profileDef.threshold_default;
  const mode = campaign?.filter_config?.mode || 'log_only';

  // --- 1. Prefetcher always wins (allow + tag, never block) ---
  if (prefetcher && prefetcher.is_prefetcher) {
    return {
      total,
      profile_used: profile,
      flags: allFlags,
      decision: 'allow',
      decision_reason: `prefetcher:${prefetcher.kind}`,
      mode_at_decision: mode,
    };
  }

  // --- 2. Hard-block flags ---
  const hitHardBlock = allFlags.find((f) => HARD_BLOCK_FLAGS.has(f));
  if (hitHardBlock) {
    return {
      total,
      profile_used: profile,
      flags: allFlags,
      decision: mode === 'enforce' ? 'block' : 'would_block',
      decision_reason: `hard_block:${hitHardBlock}`,
      mode_at_decision: mode,
    };
  }

  // --- 3. Threshold check ---
  if (total >= threshold) {
    return {
      total,
      profile_used: profile,
      flags: allFlags,
      decision: mode === 'enforce' ? 'block' : 'would_block',
      decision_reason: `threshold:${total}>=${threshold}`,
      mode_at_decision: mode,
    };
  }

  return {
    total,
    profile_used: profile,
    flags: allFlags,
    decision: 'allow',
    decision_reason: `under_threshold:${total}<${threshold}`,
    mode_at_decision: mode,
  };
}

module.exports = { decide, HARD_BLOCK_FLAGS };
