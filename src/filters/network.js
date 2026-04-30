const proxycheck = require('../lib/proxycheck');
const { lookupAsn } = require('../lib/asnLookup');
const { detectPrefetcher } = require('../lib/prefetchers');

/**
 * Network filter layer.
 *
 * Order of operations:
 *   1. ProxyCheck.io v3 lookup (gets us ASN, country, type, proxy verdict, risk score)
 *   2. AsnBlacklist overlay (catches what ProxyCheck missed)
 *   3. Prefetcher detection (Apple MPP, Outlook SafeLinks, etc - flips us out of "block" territory)
 *
 * The blacklist can flip a "clean" ProxyCheck verdict to "proxy" but never the reverse.
 * Prefetchers override score-based blocking - they get flagged but allowed.
 *
 * Returns:
 *   {
 *     score: number,             // 0-100, network-layer contribution
 *     flags: [string],           // human-readable signals
 *     enrichment: {              // data merged onto the click record
 *       asn, asn_org, country, region, city,
 *       ip_type, is_proxy, proxy_type, risk_score
 *     },
 *     prefetcher: { is_prefetcher, kind, reason } | null,
 *     overrides: { force_decision?, force_flag? }
 *   }
 */
async function networkFilter({ ip, userAgent, workspaceId }) {
  const flags = [];
  let score = 0;
  const enrichment = {};
  let pcVerdict = null;

  // --- 1. ProxyCheck ---
  if (ip) {
    pcVerdict = await proxycheck.lookup(ip);
    if (pcVerdict) {
      enrichment.asn = pcVerdict.asn;
      enrichment.asn_org = pcVerdict.asn_org;
      enrichment.organisation = pcVerdict.organisation;
      enrichment.country = pcVerdict.country;
      enrichment.country_name = pcVerdict.country_name;
      enrichment.region = pcVerdict.region;
      enrichment.city = pcVerdict.city;
      enrichment.ip_type = pcVerdict.type;
      enrichment.is_proxy = pcVerdict.is_proxy;
      enrichment.proxy_type = pcVerdict.proxy_type;
      enrichment.operator = pcVerdict.operator;
      enrichment.operator_name = pcVerdict.operator_name;
      enrichment.operator_anonymity = pcVerdict.operator_anonymity;
      enrichment.risk_score = pcVerdict.risk_score;
      enrichment.confidence = pcVerdict.confidence;
      enrichment.hosting = pcVerdict.hosting;
      enrichment.scraper = pcVerdict.scraper;

      if (pcVerdict.is_proxy) {
        flags.push(`proxycheck_${pcVerdict.proxy_type?.toLowerCase() || 'proxy'}`);
        // Score scales with risk - VPN gets 60, public proxy gets 80, Tor gets 100
        const t = (pcVerdict.proxy_type || '').toUpperCase();
        if (t === 'TOR') score += 100;
        else if (t === 'PUB' || t === 'PUBLIC') score += 80;
        else if (t === 'COM' || t === 'COMPROMISED') score += 90;
        else if (t === 'VPN') score += 60;
        else score += 70;
      }

      // ProxyCheck's own risk score - blend in at lower weight
      if (pcVerdict.risk_score >= 66) {
        score += 30;
        flags.push('proxycheck_high_risk');
      } else if (pcVerdict.risk_score >= 33) {
        score += 15;
        flags.push('proxycheck_med_risk');
      }

      // Hosting type when not flagged as proxy is a softer signal
      if (pcVerdict.type === 'hosting' && !pcVerdict.is_proxy) {
        score += 25;
        flags.push('hosting_ip');
      }
    } else {
      flags.push('proxycheck_unavailable');
    }
  } else {
    flags.push('no_ip');
  }

  // --- 2. ASN blacklist overlay (the ProxyCheck gap fix) ---
  // Run lookup whenever we have ANY identifying info from ProxyCheck. Term rules can match
  // even when ProxyCheck didn't return an ASN (some lookups give us provider but no ASN).
  // Combine provider + organisation into the haystack since they're often complementary
  // (provider="OVH SAS", organisation="Smtp.fr - Emailing Services" - the term might be in either).
  if (enrichment.asn || enrichment.asn_org || enrichment.organisation) {
    const haystack = [enrichment.asn_org, enrichment.organisation].filter(Boolean).join(' | ');
    const asnHit = await lookupAsn(enrichment.asn || null, workspaceId, {
      provider: haystack,
      asnOrg: enrichment.asn_org,
    });
    if (asnHit.match) {
      flags.push(...asnHit.flags);
      score += asnHit.score_weight;

      // Hard-block override: even in log_only mode the scoring engine sees this
      if (asnHit.severity === 'hard_block') {
        flags.push('asn_hard_block');
      }

      // If ProxyCheck said "clean" but the blacklist matched, mark proxy
      if (!enrichment.is_proxy && asnHit.override === 'mark_proxy') {
        enrichment.is_proxy = true;
        enrichment.proxy_type = `BLACKLIST_${asnHit.category.toUpperCase()}`;
        flags.push('asn_blacklist_promoted_to_proxy');
      }
      if (asnHit.override === 'mark_tor') {
        enrichment.is_proxy = true;
        enrichment.proxy_type = 'TOR';
      }
    }
  }

  // --- 3. Prefetcher detection ---
  const pf = detectPrefetcher({ userAgent, asn: enrichment.asn });
  if (pf.is_prefetcher) {
    flags.push(`prefetcher_${pf.kind}`);
    // Prefetchers should NOT score as bots. Reset network score to 0.
    score = 0;
  }

  // Cap at 100
  score = Math.min(100, score);

  return {
    score,
    flags,
    enrichment,
    prefetcher: pf.is_prefetcher ? pf : null,
  };
}

module.exports = { networkFilter };
