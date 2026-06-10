/**
 * providers/ipgeolocation.js — ipgeolocation.io IP Security API adapter.
 *
 * Endpoint: GET /v3/security?apiKey=KEY&ip=IP
 * Cost: 2 credits per lookup
 * ENV: IPGEO_API_KEY
 */

'use strict';

const logger = require('../logger');

const API_BASE = 'https://api.ipgeolocation.io/v3/security';
const TIMEOUT_MS = 5000;

async function checkIP(ip) {
  const apiKey = process.env.IPGEO_API_KEY;
  if (!apiKey || !ip) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${API_BASE}?apiKey=${apiKey}&ip=${encodeURIComponent(ip)}`, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });
    clearTimeout(timeout);
    if (!res.ok) { logger.warn('ipgeo_api_error', { ip, status: res.status }); return null; }

    const d = await res.json();

    // Normalize to unified format
    return {
      provider: 'ipgeolocation',
      is_residential_proxy: !!d.is_residential_proxy,
      is_vpn: !!d.is_vpn,
      is_proxy: !!d.is_proxy,
      is_tor: !!d.is_tor,
      is_relay: !!d.is_relay,
      is_hosting: !!d.is_cloud_provider,
      is_bot: !!d.is_bot,
      threat_score: d.threat_score || 0,
      proxy_provider_names: d.proxy_provider_names || [],
      vpn_provider_names: d.vpn_provider_names || [],
      confidence: d.proxy_confidence_score || 0,
      last_seen: d.proxy_last_seen || '',
      raw: d,
    };
  } catch (err) {
    clearTimeout(timeout);
    logger.warn('ipgeo_api_error', { ip, err: err.name === 'AbortError' ? 'timeout' : err.message });
    return null;
  }
}

function isConfigured() { return !!process.env.IPGEO_API_KEY; }

module.exports = { checkIP, isConfigured, name: 'ipgeolocation' };
