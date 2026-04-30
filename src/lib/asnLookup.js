const { AsnBlacklist } = require('../models');
const logger = require('./logger');

/**
 * Blacklist lookup overlay for ProxyCheck.io results.
 *
 * Three rule types:
 *   1. ASN rules           - exact match against ProxyCheck-returned ASN number
 *   2. Term rules          - case-insensitive substring match against provider/asn_org
 *   3. CIDR rules          - reserved for week 3 (IP range matching)
 *
 * ProxyCheck has known gaps that this overlay catches:
 *   - Datacenter providers that spin up new ASNs faster than ProxyCheck classifies them
 *   - Smaller / regional VPN services using generic "Hosting" underneath
 *   - Operators that rebrand or shuffle ASNs but keep the same provider name
 *   - Newly-listed Tor exits whose ASN isn't yet in ProxyCheck's set
 *
 * Term rules are powerful but blunt - 'hosting' will match a LOT of providers.
 * Use specific provider names ('m247', 'datacamp', 'cogent') for high-precision rules,
 * and category terms ('vpn', 'tor exit') only when you accept the broad sweep.
 *
 * Order: ASN match runs first (O(1) lookup). If no ASN hit, term rules are scanned.
 * Lookups are cached with a 60s TTL.
 */

const CACHE_TTL_MS = 60_000;
let cache = {
  byAsn: new Map(),     // asn -> entry
  termRules: [],        // [{term_lower, term_field, ...entry}, ...]
  loadedAt: 0,
};

async function loadCache() {
  const entries = await AsnBlacklist.find({ active: true }).lean();
  const byAsn = new Map();
  const termRules = [];

  for (const e of entries) {
    if (e.asn) {
      const existing = byAsn.get(e.asn);
      // Workspace-specific entries win over globals
      if (!existing || (e.workspace_id && !existing.workspace_id)) {
        byAsn.set(e.asn, e);
      }
    } else if (e.term) {
      termRules.push({
        ...e,
        _term_lower: String(e.term).toLowerCase(),
        _term_field: e.term_field || 'any',
      });
    }
    // CIDR rules ignored for now - reserved for week 3
  }

  cache = { byAsn, termRules, loadedAt: Date.now() };
  logger.info('asn_blacklist_loaded', { asn_rules: byAsn.size, term_rules: termRules.length });
}

async function ensureCache() {
  if (Date.now() - cache.loadedAt > CACHE_TTL_MS) {
    await loadCache();
  }
}

/**
 * Look up against the blacklist. Now takes provider strings to support term matching.
 *
 * Args:
 *   asn         - ProxyCheck-returned ASN number (e.g. 9009)
 *   provider    - ProxyCheck-returned provider/org name (e.g. "M247 Europe SRL")
 *   asnOrg      - alternate org name; if provider unset we'll match against this instead
 *   workspaceId - for scoping workspace-specific rules; global rules always apply
 *
 * Returns:
 *   {
 *     match: bool,
 *     entry?,                          // the matched rule
 *     match_kind?: 'asn' | 'term',
 *     matched_value?,                  // what triggered (the term, or the asn)
 *     category, severity, score_weight, override,
 *     flags: [...]
 *   }
 *
 * Multi-rule policy: if both an ASN rule and a term rule match, the ASN rule wins
 * (more specific). The term rule still gets a flag so you can see it would have hit.
 */
async function lookupAsn(asn, workspaceId = null, { provider = '', asnOrg = '' } = {}) {
  await ensureCache();

  // Build the haystack for term matching from whatever we got.
  // We dedupe and lowercase once.
  const providerStr = String(provider || '').toLowerCase();
  const orgStr = String(asnOrg || '').toLowerCase();

  // --- 1. ASN exact match (fast path) ---
  let asnHit = null;
  if (asn) {
    const entry = cache.byAsn.get(Number(asn));
    if (entry && (!entry.workspace_id || !workspaceId ||
                  entry.workspace_id.toString() === workspaceId.toString())) {
      asnHit = entry;
    }
  }

  // --- 2. Term scan (always runs; we want to know if a term would have matched even
  //        when ASN already won, for visibility flags) ---
  const termHits = [];
  for (const rule of cache.termRules) {
    // Workspace scope check
    if (rule.workspace_id && workspaceId &&
        rule.workspace_id.toString() !== workspaceId.toString()) continue;

    const t = rule._term_lower;
    let matched = false;
    if (rule._term_field === 'provider') {
      matched = providerStr && providerStr.includes(t);
    } else if (rule._term_field === 'asn_org') {
      matched = orgStr && orgStr.includes(t);
    } else {
      // 'any' - match against either
      matched = (providerStr && providerStr.includes(t)) || (orgStr && orgStr.includes(t));
    }
    if (matched) termHits.push(rule);
  }

  // --- 3. Pick the winning rule ---
  // Priority: ASN rule > term rule with hard_block > term rule with high > etc.
  const severityRank = { hard_block: 4, high: 3, medium: 2, low: 1 };
  let winner = null;
  let matchKind = null;
  let matchedValue = null;

  if (asnHit) {
    winner = asnHit;
    matchKind = 'asn';
    matchedValue = asnHit.asn;
  } else if (termHits.length > 0) {
    termHits.sort((a, b) =>
      (severityRank[b.severity] || 0) - (severityRank[a.severity] || 0) ||
      (b.score_weight || 0) - (a.score_weight || 0)
    );
    winner = termHits[0];
    matchKind = 'term';
    matchedValue = winner.term;
  } else {
    return { match: false, score_weight: 0, flags: [] };
  }

  // --- 4. Increment hit counters (fire-and-forget) ---
  for (const r of [winner, ...(asnHit && termHits.length ? termHits : [])]) {
    if (!r) continue;
    AsnBlacklist.updateOne(
      { _id: r._id },
      { $inc: { hit_count: 1 }, $set: { last_hit_at: new Date() } }
    ).catch(() => {});
  }

  // --- 5. Build flags ---
  const flags = [
    `${matchKind === 'asn' ? 'asn' : 'term'}_blacklist_${winner.category}`,
    `asn_${winner.severity}`,
  ];
  if (matchKind === 'term') {
    flags.push(`term_match:${winner._term_lower}`);
  }
  // Note when an ASN rule won but a term would also have matched
  if (matchKind === 'asn' && termHits.length > 0) {
    flags.push(`also_term_match:${termHits[0]._term_lower}`);
  }

  return {
    match: true,
    entry: winner,
    match_kind: matchKind,
    matched_value: matchedValue,
    category: winner.category,
    severity: winner.severity,
    score_weight: winner.score_weight || 0,
    override: winner.override,
    flags,
  };
}

function invalidateCache() {
  cache.loadedAt = 0;
}

module.exports = { lookupAsn, loadCache, invalidateCache };
