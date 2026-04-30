const { networkFilter } = require('../filters/network');
const { headersFilter } = require('../filters/headers');
const { patternFilter } = require('../filters/pattern');
const { refererFilter } = require('../filters/referer');
const { behaviorFilter } = require('../filters/behavior');
const { decide } = require('../scoring/decide');
const logger = require('./logger');

/**
 * Run all filters and return a complete scoring + decision payload.
 *
 * Designed to never throw - any filter failure produces a 0-score with a 'filter_error' flag,
 * because we'd rather log a click as "allow / unknown" than 500 the user.
 *
 * Returns a payload that's directly mergeable into the click document:
 *   {
 *     scores: { network, headers, behavior, pattern, referer, total, profile_used, flags },
 *     decision, decision_reason, mode_at_decision,
 *     enrichment: { asn, asn_org, country, region, city, ip_type, is_proxy, ... },
 *     prefetcher: { is_prefetcher, kind } | null
 *   }
 */
async function runFilterChain({
  ip, ipHash, userAgent, headers,
  utm, externalIds, refererHost, inAppBrowser,
  fingerprint,                 // null on first request, populated on /go/fp callback
  workspaceId, campaign,
}) {
  const layerScores = { network: 0, headers: 0, behavior: 0, pattern: 0, referer: 0 };
  const layerFlags = { network: [], headers: [], behavior: [], pattern: [], referer: [] };
  let enrichment = {};
  let prefetcher = null;

  // --- Network (async, may hit ProxyCheck + ASN blacklist Mongo lookup) ---
  try {
    const r = await networkFilter({ ip, userAgent, headers, workspaceId });
    layerScores.network = r.score;
    layerFlags.network = r.flags;
    enrichment = r.enrichment || {};
    prefetcher = r.prefetcher;
  } catch (err) {
    logger.warn('network_filter_error', { err: err.message });
    layerFlags.network = ['filter_error'];
  }

  // --- Headers (sync) ---
  try {
    const r = headersFilter({ headers, userAgent });
    layerScores.headers = r.score;
    layerFlags.headers = r.flags;
  } catch (err) {
    logger.warn('headers_filter_error', { err: err.message });
    layerFlags.headers = ['filter_error'];
  }

  // --- Behavior (sync, scores fingerprint payload) ---
  try {
    const r = behaviorFilter({
      fingerprint,
      isPrefetcher: prefetcher?.is_prefetcher === true,
    });
    layerScores.behavior = r.score;
    layerFlags.behavior = r.flags;
  } catch (err) {
    logger.warn('behavior_filter_error', { err: err.message });
    layerFlags.behavior = ['filter_error'];
  }

  // --- Pattern (async, hits Redis) ---
  try {
    const r = await patternFilter({
      ipHash,
      asn: enrichment.asn,
      fingerprintHash: fingerprint?.hash,
      limits: campaign?.filter_config?.rule_overrides?.rate_limits,
    });
    layerScores.pattern = r.score;
    layerFlags.pattern = r.flags;
  } catch (err) {
    logger.warn('pattern_filter_error', { err: err.message });
    layerFlags.pattern = ['filter_error'];
  }

  // --- Referer (sync) ---
  try {
    const r = refererFilter({ utm, refererHost, externalIds, inAppBrowser });
    layerScores.referer = r.score;
    layerFlags.referer = r.flags;
  } catch (err) {
    logger.warn('referer_filter_error', { err: err.message });
    layerFlags.referer = ['filter_error'];
  }

  // --- Decide ---
  const verdict = decide({
    layerScores,
    layerFlags,
    profile: campaign?.source_profile || 'mixed',
    campaign,
    prefetcher,
  });

  return {
    scores: {
      network: layerScores.network,
      headers: layerScores.headers,
      behavior: layerScores.behavior,
      pattern: layerScores.pattern,
      referer: layerScores.referer,
      total: verdict.total,
      profile_used: verdict.profile_used,
      flags: verdict.flags,
    },
    decision: verdict.decision,
    decision_reason: verdict.decision_reason,
    mode_at_decision: verdict.mode_at_decision,
    enrichment,
    prefetcher,
  };
}

module.exports = { runFilterChain };
