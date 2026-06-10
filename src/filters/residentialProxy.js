/**
 * filters/residentialProxy.js — Second-layer residential proxy detection.
 *
 * Runs AFTER the network filter (ProxyCheck). Only fires when:
 *   1. Campaign has residential_proxy_detection enabled
 *   2. IPGEO_API_KEY is set in .env
 *   3. ProxyCheck did NOT already flag the IP as proxy/VPN
 *      (no point double-spending API credits on already-caught IPs)
 *
 * When ipgeolocation.io detects a residential proxy:
 *   - Adds 'residential_proxy' flag → triggers safe page
 *   - Adds provider names as flags (e.g. 'resi_proxy_provider:IPRoyal')
 *   - Score weight: 80 (high enough to trigger safe page on its own)
 *   - Stores full security response on the Click document for reporting
 *
 * The CIDR analyser picks up the 'residential_proxy' flag from clicks
 * and factors it into intelligence scoring.
 */

'use strict';

const { checkIP } = require('../lib/ipgeoSecurity');
const logger = require('../lib/logger');

const RESI_PROXY_SCORE = 80;  // High enough to trigger safe page alone
const VPN_SCORE = 60;
const PROXY_SCORE = 70;
const THREAT_SCORE_MULTIPLIER = 0.5;  // ipgeo threat_score 80 → +40 BotGuard score

/**
 * Run residential proxy detection.
 *
 * @param {object} doc — Click document (mutable, adds fields)
 * @param {object} campaign — Campaign document
 * @returns {Promise<{ score: number, flags: string[], ipgeo: object|null }>}
 */
async function residentialProxyFilter(doc, campaign) {
  const result = { score: 0, flags: [], ipgeo: null };

  // Gate 1: Campaign must have the feature enabled
  if (!campaign.residential_proxy_detection) return result;

  // Gate 2: API key must be configured
  if (!process.env.IPGEO_API_KEY) return result;

  // Gate 3: Skip if ProxyCheck already caught this IP
  // (check existing flags from the network filter)
  const existingFlags = doc.scores?.flags || [];
  const alreadyCaught = existingFlags.some(f =>
    f === 'proxy_detected' || f === 'vpn_detected' ||
    f.startsWith('proxy_type:') || f === 'hosting_detected'
  );
  if (alreadyCaught) return result;

  // Gate 4: Must have an IP
  const ip = doc.ip;
  if (!ip) return result;

  // Call ipgeolocation.io
  const ipgeo = await checkIP(ip);
  if (!ipgeo) return result;

  result.ipgeo = ipgeo;

  // Store on Click document for reporting
  doc.ipgeo_security = {
    threat_score: ipgeo.threat_score,
    is_residential_proxy: ipgeo.is_residential_proxy,
    is_vpn: ipgeo.is_vpn,
    is_proxy: ipgeo.is_proxy,
    is_tor: ipgeo.is_tor,
    is_relay: ipgeo.is_relay,
    is_anonymous: ipgeo.is_anonymous,
    is_bot: ipgeo.is_bot,
    is_cloud_provider: ipgeo.is_cloud_provider,
    proxy_provider_names: ipgeo.proxy_provider_names,
    vpn_provider_names: ipgeo.vpn_provider_names,
    proxy_confidence_score: ipgeo.proxy_confidence_score,
    checked_at: new Date(),
  };

  // ── Score based on findings ────────────────────────────────────────

  if (ipgeo.is_residential_proxy) {
    result.score += RESI_PROXY_SCORE;
    result.flags.push('residential_proxy');

    // Provider attribution
    if (ipgeo.proxy_provider_names?.length) {
      for (const name of ipgeo.proxy_provider_names) {
        result.flags.push(`resi_proxy_provider:${name.toLowerCase().replace(/\s+/g, '_')}`);
      }
    }

    // Confidence-based bonus
    if (ipgeo.proxy_confidence_score >= 90) {
      result.flags.push('resi_proxy_high_confidence');
    }

    logger.info('residential_proxy_detected', {
      ip,
      providers: ipgeo.proxy_provider_names.join(', '),
      confidence: ipgeo.proxy_confidence_score,
      threat_score: ipgeo.threat_score,
    });
  }

  if (ipgeo.is_vpn && !ipgeo.is_residential_proxy) {
    result.score += VPN_SCORE;
    result.flags.push('ipgeo_vpn');
    if (ipgeo.vpn_provider_names?.length) {
      for (const name of ipgeo.vpn_provider_names) {
        result.flags.push(`vpn_provider:${name.toLowerCase().replace(/\s+/g, '_')}`);
      }
    }
  }

  if (ipgeo.is_proxy && !ipgeo.is_residential_proxy && !ipgeo.is_vpn) {
    result.score += PROXY_SCORE;
    result.flags.push('ipgeo_proxy');
  }

  if (ipgeo.is_tor) {
    result.score += PROXY_SCORE;
    result.flags.push('ipgeo_tor');
  }

  if (ipgeo.is_relay) {
    result.flags.push('ipgeo_relay');
    result.score += 30;
  }

  // Threat score contribution (additive, not replacing)
  if (ipgeo.threat_score > 0 && result.score === 0) {
    // Even if no specific flag fired, a high threat score adds some weight
    result.score += Math.round(ipgeo.threat_score * THREAT_SCORE_MULTIPLIER);
    if (ipgeo.threat_score >= 60) result.flags.push('ipgeo_high_threat');
  }

  if (ipgeo.is_known_attacker) result.flags.push('ipgeo_known_attacker');
  if (ipgeo.is_spam) result.flags.push('ipgeo_spam');
  if (ipgeo.is_cloud_provider) result.flags.push('ipgeo_cloud');

  return result;
}

module.exports = { residentialProxyFilter };
