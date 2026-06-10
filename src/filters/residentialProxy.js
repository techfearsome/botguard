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

const { checkIP } = require('../lib/providers');
const logger = require('../lib/logger');

const RESI_PROXY_SCORE = 80;
const VPN_SCORE = 60;
const PROXY_SCORE = 70;
const THREAT_SCORE_MULTIPLIER = 0.5;

/**
 * Run residential proxy detection using the configured provider.
 *
 * @param {object} doc — Click document (mutable, adds fields)
 * @param {object} campaign — Campaign document
 * @returns {Promise<{ score: number, flags: string[], ipgeo: object|null }>}
 */
async function residentialProxyFilter(doc, campaign) {
  const result = { score: 0, flags: [], ipgeo: null };

  // Gate 1: Campaign must have the feature enabled
  const resiConfig = campaign.residential_proxy || {};
  if (!resiConfig.enabled && !campaign.residential_proxy_detection) return result;

  // Gate 2: Skip if ProxyCheck already caught this IP
  const existingFlags = doc.scores?.flags || [];
  const alreadyCaught = existingFlags.some(f =>
    f === 'proxy_detected' || f === 'vpn_detected' ||
    f.startsWith('proxy_type:') || f === 'hosting_detected'
  );
  if (alreadyCaught) return result;

  // Gate 3: Must have an IP
  const ip = doc.ip;
  if (!ip) return result;

  // Determine which provider to use
  const preference = resiConfig.provider || 'auto';

  // Call the provider router (handles caching internally)
  const data = await checkIP(ip, preference);
  if (!data) return result;

  result.ipgeo = data;

  // Store on Click document for reporting
  doc.ipgeo_security = {
    provider: data.provider,
    threat_score: data.threat_score,
    is_residential_proxy: data.is_residential_proxy,
    is_vpn: data.is_vpn,
    is_proxy: data.is_proxy,
    is_tor: data.is_tor,
    is_relay: data.is_relay,
    is_hosting: data.is_hosting,
    proxy_provider_names: data.proxy_provider_names,
    vpn_provider_names: data.vpn_provider_names,
    confidence: data.confidence,
    checked_at: new Date(),
    // Store raw provider response for detailed display on click detail page
    // Spur: client, tunnels, risks, infrastructure
    // ipinfo: privacy, residential_proxy
    // ipgeolocation: full security fields
    raw: data.raw || null,
  };

  // ── Score based on findings ────────────────────────────────────────

  if (data.is_residential_proxy) {
    result.score += RESI_PROXY_SCORE;
    result.flags.push('residential_proxy');
    result.flags.push(`resi_provider:${data.provider}`);

    if (data.proxy_provider_names?.length) {
      for (const name of data.proxy_provider_names) {
        result.flags.push(`resi_proxy_provider:${name.toLowerCase().replace(/\s+/g, '_')}`);
      }
    }

    if (data.confidence >= 90) result.flags.push('resi_proxy_high_confidence');

    logger.info('residential_proxy_detected', {
      ip, provider: data.provider,
      proxy_providers: data.proxy_provider_names.join(', '),
      confidence: data.confidence,
      threat_score: data.threat_score,
    });
  }

  if (data.is_vpn && !data.is_residential_proxy) {
    result.score += VPN_SCORE;
    result.flags.push('ipgeo_vpn');
    if (data.vpn_provider_names?.length) {
      for (const name of data.vpn_provider_names) {
        result.flags.push(`vpn_provider:${name.toLowerCase().replace(/\s+/g, '_')}`);
      }
    }
  }

  if (data.is_proxy && !data.is_residential_proxy && !data.is_vpn) {
    result.score += PROXY_SCORE;
    result.flags.push('ipgeo_proxy');
  }

  if (data.is_tor) {
    result.score += PROXY_SCORE;
    result.flags.push('ipgeo_tor');
  }

  if (data.is_relay) {
    result.flags.push('ipgeo_relay');
    result.score += 30;
  }

  if (data.threat_score > 0 && result.score === 0) {
    result.score += Math.round(data.threat_score * THREAT_SCORE_MULTIPLIER);
    if (data.threat_score >= 60) result.flags.push('ipgeo_high_threat');
  }

  if (data.is_hosting) result.flags.push('ipgeo_cloud');

  return result;
}

module.exports = { residentialProxyFilter };
