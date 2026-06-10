/**
 * providers/ipinfo.js — ipinfo.io Privacy Detection + Residential Proxy API adapter.
 *
 * Two endpoints called in parallel:
 *   1. GET /{ip}/privacy?token=TOKEN — VPN/proxy/tor/relay/hosting detection
 *   2. GET /{ip}/residential_proxy?token=TOKEN — residential proxy detection
 *
 * ENV: IPINFO_TOKEN
 *
 * Note: The residential proxy endpoint is a separate product from ipinfo.io.
 * If not subscribed, it returns 403 — we handle that gracefully and still
 * use the privacy endpoint data.
 */

'use strict';

const logger = require('../logger');

const API_BASE = 'https://ipinfo.io';
const TIMEOUT_MS = 5000;

async function fetchEndpoint(ip, endpoint, token) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/${encodeURIComponent(ip)}/${endpoint}?token=${token}`, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    clearTimeout(timeout);
    return null;
  }
}

async function checkIP(ip) {
  const token = process.env.IPINFO_TOKEN;
  if (!token || !ip) return null;

  // Call both endpoints in parallel — residential_proxy may 403 if not subscribed
  const [privacy, resiProxy] = await Promise.all([
    fetchEndpoint(ip, 'privacy', token),
    fetchEndpoint(ip, 'residential_proxy', token),
  ]);

  if (!privacy && !resiProxy) {
    logger.warn('ipinfo_api_error', { ip, msg: 'Both endpoints failed' });
    return null;
  }

  const isResiProxy = !!(resiProxy && resiProxy.service);
  const isVpn = !!(privacy?.vpn);
  const isProxy = !!(privacy?.proxy);
  const isTor = !!(privacy?.tor);
  const isRelay = !!(privacy?.relay);
  const isHosting = !!(privacy?.hosting);

  // Provider names
  const proxyProviders = [];
  if (resiProxy?.service) proxyProviders.push(resiProxy.service);
  const vpnProviders = [];
  if (privacy?.service && isVpn) vpnProviders.push(privacy.service);

  // Compute threat score from signals
  let threatScore = 0;
  if (isResiProxy) threatScore += 60;
  if (isVpn) threatScore += 40;
  if (isTor) threatScore += 50;
  if (isProxy) threatScore += 40;
  if (isRelay) threatScore += 20;
  threatScore = Math.min(threatScore, 100);

  // Confidence based on persistence
  let confidence = 0;
  if (resiProxy?.percent_days_seen) {
    confidence = Math.min(resiProxy.percent_days_seen * 2, 100);
  } else if (isResiProxy) {
    confidence = 70; // default when detected but no persistence data
  }

  return {
    provider: 'ipinfo',
    is_residential_proxy: isResiProxy,
    is_vpn: isVpn,
    is_proxy: isProxy,
    is_tor: isTor,
    is_relay: isRelay,
    is_hosting: isHosting,
    is_bot: false,
    threat_score: threatScore,
    proxy_provider_names: proxyProviders,
    vpn_provider_names: vpnProviders,
    confidence: confidence,
    last_seen: resiProxy?.last_seen || '',
    raw: { privacy: privacy || {}, residential_proxy: resiProxy || {} },
  };
}

function isConfigured() { return !!process.env.IPINFO_TOKEN; }

module.exports = { checkIP, isConfigured, name: 'ipinfo' };
