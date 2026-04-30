const { Click } = require('../models');
const { decide } = require('../scoring/decide');
const { headersFilter } = require('../filters/headers');
const { behaviorFilter } = require('../filters/behavior');
const { refererFilter } = require('../filters/referer');

/**
 * Decision Replay
 *
 * Given a saved click record, re-run the synchronous filters (headers, behavior, referer)
 * against new threshold/profile/mode settings and compare against what was actually decided.
 *
 * We intentionally do NOT re-run network or pattern filters - those depend on time-sensitive
 * external state (ProxyCheck cache, Redis counters) that we can't reproduce.
 * We use the network/pattern scores that were stored at click time.
 *
 * Returns:
 *   {
 *     summary: { allow, block, would_block, total },
 *     deltas:  { stayed_same, became_block, became_allow },
 *     samples: [first 50 changed clicks with both verdicts]
 *   }
 */
async function replay({ workspaceId, filter = {}, hypothetical }) {
  const q = { workspace_id: workspaceId, ...filter };
  const clicks = await Click.find(q).limit(10_000).lean();

  const summary = { allow: 0, block: 0, would_block: 0, total: clicks.length };
  const deltas  = { stayed_same: 0, became_block: 0, became_allow: 0, became_would_block: 0 };
  const samples = [];

  for (const c of clicks) {
    // Recompute headers/behavior/referer scores from stored fingerprint + ua
    // Approximate headers re-score from UA only (we don't store full headers - by design)
    const headersScore = approximateHeadersFromClick(c);
    const refererScore = refererFilter({
      utm: c.utm || {},
      refererHost: c.referer_host,
      externalIds: c.external_ids || {},
      inAppBrowser: c.in_app_browser,
    });
    const behaviorScore = behaviorFilter({
      fingerprint: c.fingerprint || null,
      isPrefetcher: (c.scores?.flags || []).some((f) => f.startsWith('prefetcher_')),
    });

    // Use stored network and pattern scores (can't reproduce live state)
    const layerScores = {
      network: c.scores?.network || 0,
      headers: headersScore.score,
      behavior: behaviorScore.score,
      pattern:  c.scores?.pattern || 0,
      referer:  refererScore.score,
    };
    const layerFlags = {
      network: (c.scores?.flags || []).filter((f) => f.startsWith('proxycheck_') || f.startsWith('asn_') || f === 'hosting_ip' || f === 'no_ip'),
      headers: headersScore.flags,
      behavior: behaviorScore.flags,
      pattern: (c.scores?.flags || []).filter((f) => f.startsWith('rate_')),
      referer: refererScore.flags,
    };

    const verdict = decide({
      layerScores,
      layerFlags,
      profile: hypothetical.profile || c.scores?.profile_used || 'mixed',
      campaign: {
        filter_config: {
          threshold: hypothetical.threshold,
          mode: hypothetical.mode || 'enforce',
        },
        source_profile: hypothetical.profile || c.scores?.profile_used,
      },
      prefetcher: (c.scores?.flags || []).some((f) => f.startsWith('prefetcher_'))
        ? { is_prefetcher: true, kind: 'inferred' } : null,
    });

    // Tally
    summary[verdict.decision] = (summary[verdict.decision] || 0) + 1;

    // Compare
    if (verdict.decision === c.decision) {
      deltas.stayed_same++;
    } else if (verdict.decision === 'block') {
      deltas.became_block++;
      if (samples.length < 50) samples.push({ click_id: c.click_id, ts: c.ts, was: c.decision, now: verdict.decision, total_was: c.scores?.total, total_now: verdict.total });
    } else if (verdict.decision === 'allow') {
      deltas.became_allow++;
      if (samples.length < 50) samples.push({ click_id: c.click_id, ts: c.ts, was: c.decision, now: verdict.decision, total_was: c.scores?.total, total_now: verdict.total });
    } else if (verdict.decision === 'would_block') {
      deltas.became_would_block++;
      if (samples.length < 50) samples.push({ click_id: c.click_id, ts: c.ts, was: c.decision, now: verdict.decision, total_was: c.scores?.total, total_now: verdict.total });
    }
  }

  return { summary, deltas, samples, scanned: clicks.length };
}

// Approximate the headers filter from what we stored on the click (UA only).
// Real-time replay won't be perfect because we don't persist all request headers by design.
function approximateHeadersFromClick(c) {
  return headersFilter({
    headers: {
      // We only have the UA - all other header signals are unknown/empty
      'user-agent': c.user_agent,
    },
    userAgent: c.user_agent || '',
  });
}

module.exports = { replay };
