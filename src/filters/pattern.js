const redis = require('../lib/redisClient');

/**
 * Pattern filter - catches bursts and repeat-visit patterns that indicate scraping or click fraud.
 *
 * Uses Redis when available; gracefully no-ops when not (returns score=0, flag='rate_limit_unavailable').
 *
 * Three rate windows per signal:
 *   - per IP: how many clicks from this IP in the last minute / hour
 *   - per ASN: how many clicks from this ASN in the last minute (catches botnets even with rotating IPs)
 *   - per fingerprint hash: how many sessions with this fingerprint today (week 2 - filled in once we have FP)
 *
 * Thresholds are intentionally lenient for a "permissive log everything" posture.
 * Tighten via campaign filter_config.rule_overrides if needed.
 */

const DEFAULT_LIMITS = {
  ip_per_min: 10,
  ip_per_hour: 60,
  asn_per_min: 200,    // catches botnets rotating IPs within an ASN
  fp_per_day: 30,
};

async function patternFilter({ ipHash, asn, fingerprintHash, limits = {} }) {
  const flags = [];
  let score = 0;
  const L = { ...DEFAULT_LIMITS, ...limits };

  // Bail early if Redis isn't available
  const client = redis.getClient();
  if (!client || client.status !== 'ready') {
    return { score: 0, flags: ['rate_limit_unavailable'] };
  }

  if (ipHash) {
    const minKey = `bg:rl:ip:${ipHash}:m`;
    const hourKey = `bg:rl:ip:${ipHash}:h`;
    const minCount = await redis.incrWithTtl(minKey, 60);
    const hourCount = await redis.incrWithTtl(hourKey, 3600);

    if (minCount > L.ip_per_min) {
      flags.push('rate_ip_minute');
      score += Math.min(40, (minCount - L.ip_per_min) * 5);
    }
    if (hourCount > L.ip_per_hour) {
      flags.push('rate_ip_hour');
      score += Math.min(30, (hourCount - L.ip_per_hour) * 2);
    }
  }

  if (asn) {
    const asnKey = `bg:rl:asn:${asn}:m`;
    const asnCount = await redis.incrWithTtl(asnKey, 60);
    if (asnCount > L.asn_per_min) {
      flags.push('rate_asn_minute');
      score += Math.min(20, Math.floor((asnCount - L.asn_per_min) / 10));
    }
  }

  if (fingerprintHash) {
    const fpKey = `bg:rl:fp:${fingerprintHash}:d`;
    const fpCount = await redis.incrWithTtl(fpKey, 86400);
    if (fpCount > L.fp_per_day) {
      flags.push('rate_fp_day');
      score += Math.min(25, fpCount - L.fp_per_day);
    }
  }

  score = Math.min(100, score);
  return { score, flags };
}

module.exports = { patternFilter, DEFAULT_LIMITS };
