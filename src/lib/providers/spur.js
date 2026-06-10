/**
 * providers/spur.js — Spur Context API adapter.
 *
 * Endpoint: GET /v2/context/:ip with Token header
 * ENV: SPUR_API_TOKEN
 *
 * Spur's response structure:
 *   - client.proxies: ["IPROYAL_PROXY", "922PROXY_PROXY"] — residential proxy providers
 *   - risks: ["CALLBACK_PROXY", "TUNNEL", "GEO_MISMATCH"] — risk signals
 *   - tunnels: [{ anonymous, operator, type }] — VPN/tunnel info
 *   - infrastructure: "DATACENTER" | "MOBILE" | "RESIDENTIAL" | "FIXED"
 */

'use strict';

const logger = require('../logger');

const API_BASE = 'https://api.spur.us/v2/context';
const TIMEOUT_MS = 5000;

// Residential proxy risk indicators in Spur's vocabulary
const RESI_PROXY_RISKS = new Set([
  'CALLBACK_PROXY', 'RESIDENTIAL_PROXY', 'P2P_PROXY',
]);

async function checkIP(ip) {
  const token = process.env.SPUR_API_TOKEN;
  if (!token || !ip) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${API_BASE}/${encodeURIComponent(ip)}`, {
      signal: controller.signal,
      headers: { 'Token': token, 'Accept': 'application/json' },
    });
    clearTimeout(timeout);
    if (!res.ok) { logger.warn('spur_api_error', { ip, status: res.status }); return null; }

    const d = await res.json();

    const risks = d.risks || [];
    const tunnels = d.tunnels || [];
    const clientProxies = d.client?.proxies || [];
    const infrastructure = d.infrastructure || '';

    // Detect residential proxy
    const isResiProxy = clientProxies.length > 0 ||
      risks.some(r => RESI_PROXY_RISKS.has(r));

    // Detect VPN
    const isVpn = tunnels.some(t => t.type === 'VPN') ||
      risks.includes('TUNNEL');

    // Detect Tor
    const isTor = tunnels.some(t => t.type === 'TOR') ||
      risks.includes('TOR');

    // Extract provider names from client.proxies (format: "IPROYAL_PROXY" → "IPRoyal")
    const proxyProviders = clientProxies.map(p =>
      p.replace(/_PROXY$/i, '').replace(/_/g, ' ')
    );

    // Extract VPN operators from tunnels
    const vpnProviders = tunnels
      .filter(t => t.operator)
      .map(t => t.operator.replace(/_/g, ' '));

    // Compute a threat score from signals
    let threatScore = 0;
    if (isResiProxy) threatScore += 60;
    if (isVpn) threatScore += 40;
    if (isTor) threatScore += 50;
    if (risks.includes('GEO_MISMATCH')) threatScore += 20;
    if (risks.includes('CALLBACK_PROXY')) threatScore += 20;
    threatScore = Math.min(threatScore, 100);

    return {
      provider: 'spur',
      is_residential_proxy: isResiProxy,
      is_vpn: isVpn,
      is_proxy: isResiProxy || clientProxies.length > 0,
      is_tor: isTor,
      is_relay: false,
      is_hosting: infrastructure === 'DATACENTER',
      is_bot: false,
      threat_score: threatScore,
      proxy_provider_names: proxyProviders,
      vpn_provider_names: vpnProviders,
      confidence: isResiProxy ? 85 : 0, // Spur doesn't give confidence scores
      last_seen: '',
      raw: d,
    };
  } catch (err) {
    clearTimeout(timeout);
    logger.warn('spur_api_error', { ip, err: err.name === 'AbortError' ? 'timeout' : err.message });
    return null;
  }
}

function isConfigured() { return !!process.env.SPUR_API_TOKEN; }

module.exports = { checkIP, isConfigured, name: 'spur' };
