/**
 * syncMatch.js — the decision brain for imported sync data. Pure functions, no
 * I/O, so the risky "should this remote entry touch my firewall?" logic is
 * fully unit-testable.
 *
 * Two responsibilities:
 *   1. classifyMatch()  — given an incoming entry and what we know locally,
 *      label it new / match / duplicate and attach local evidence.
 *   2. decideEntryFate() — given the partner's per-source rules and the match
 *      result, decide: implement | stage | ignore.
 *
 * Safety posture: the ONLY way an entry gets 'implement' is if the partner's
 * disposition is explicitly 'implement' AND the promotion rules pass. Anything
 * already active locally is 'duplicate' → ignored (never re-added). Monitor and
 * quarantine NEVER implement, regardless of promotion_mode.
 */

'use strict';

/**
 * @param {object} entry   incoming { kind, value }
 * @param {object} local   what we know locally:
 *   { active: bool,        — already in our ACTIVE firewall data
 *     known: bool,         — we have a record (any status)
 *     score: number,       — our local score (CIDR) or 0
 *     hits: number }       — our local hit_count or 0
 * @returns {{match_status:'new'|'match'|'duplicate', local_score:number, local_hits:number}}
 */
function classifyMatch(entry, local = {}) {
  if (local.active) {
    return { match_status: 'duplicate', local_score: local.score || 0, local_hits: local.hits || 0 };
  }
  if (local.known) {
    return { match_status: 'match', local_score: local.score || 0, local_hits: local.hits || 0 };
  }
  return { match_status: 'new', local_score: 0, local_hits: 0 };
}

/**
 * Decide what to do with one classified entry.
 *
 * @param {object} partner  the import SyncPartner (disposition, promotion_mode, thresholds)
 * @param {object} m         result of classifyMatch()
 * @param {object} [ctx]     { batchTrusted?: bool } — for percentage mode, whether
 *                           the batch's overall match ratio cleared the threshold
 * @returns {'implement'|'stage'|'ignore'}
 */
function decideEntryFate(partner, m, ctx = {}) {
  // Already active locally → nothing to do.
  if (m.match_status === 'duplicate') return 'ignore';

  const disposition = partner.disposition || 'monitor';

  // Monitor and quarantine never implement — they only ever stage for review.
  if (disposition !== 'implement') return 'stage';

  const mode = partner.promotion_mode || 'corroboration';
  const t = partner.thresholds || {};

  if (mode === 'full') return 'implement';

  if (mode === 'percentage') {
    // Whole-list trust: if the batch cleared the ratio, implement everything
    // (except duplicates, handled above); otherwise stage it all for review.
    return ctx.batchTrusted ? 'implement' : 'stage';
  }

  // corroboration (default, safest): implement only entries we've independently
  // seen at/above our local thresholds. New (unseen) entries stay staged.
  if (m.match_status === 'match') {
    const minScore = t.min_local_score ?? 60;
    const minHits = t.min_local_hits ?? 0;
    if (m.local_score >= minScore && m.local_hits >= minHits) return 'implement';
  }
  return 'stage';
}

/**
 * For percentage mode, compute whether a batch is "trusted" from its match ratio.
 * Duplicates count as matches for the ratio (we've clearly seen them).
 *
 * @param {Array} classified  array of classifyMatch() results
 * @param {number} pct        required match percentage (0-100)
 * @returns {{trusted:boolean, ratio:number, matched:number, total:number}}
 */
function batchMatchRatio(classified, pct) {
  const total = classified.length;
  if (total === 0) return { trusted: false, ratio: 0, matched: 0, total: 0 };
  const matched = classified.filter((c) => c.match_status !== 'new').length;
  const ratio = (matched / total) * 100;
  return { trusted: ratio >= (pct ?? 50), ratio, matched, total };
}

module.exports = { classifyMatch, decideEntryFate, batchMatchRatio };
