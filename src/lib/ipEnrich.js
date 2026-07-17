/**
 * ipEnrich.js — IP enrichment provider abstraction.
 *
 * ProxyCheck is the primary provider. If it returns no usable data (timeout,
 * network error, non-ok status, or no API key), and the IPLocate fallback is
 * enabled + configured, we fall back to IPLocate. Both providers normalize to
 * the identical shape, so the scoring chain and the Level 2 bot guard behave
 * the same regardless of which one answered.
 *
 * ProxyCheck.lookup() never throws — it returns null on any failure — so the
 * fallback trigger is simply "primary returned null". It returns real data
 * (is_proxy:false) for clean IPs, so the fallback does NOT fire on every clean
 * lookup, only on genuine primary failures.
 *
 * Env:
 *   PROXYCHECK_API_KEY          — primary provider key
 *   IPLOCATE_API_KEY            — fallback provider key
 *   IPLOCATE_FALLBACK_ENABLED   — 'true'|'yes'|'1'|'on' to enable the fallback
 */

'use strict';

const proxycheck = require('./proxycheck');
const iplocate = require('./iplocate');
const logger = require('./logger');

function fallbackEnabled() {
  const v = String(process.env.IPLOCATE_FALLBACK_ENABLED || '').trim().toLowerCase();
  return v === 'true' || v === 'yes' || v === '1' || v === 'on';
}

async function lookup(ip) {
  if (!ip) return null;

  // Primary: ProxyCheck.
  const primary = await proxycheck.lookup(ip);
  if (primary) return primary;

  // Primary produced nothing usable — fall back to IPLocate if enabled.
  if (fallbackEnabled() && process.env.IPLOCATE_API_KEY) {
    const fb = await iplocate.lookup(ip);
    if (fb) {
      logger.info('ip_enrich_fallback_used', { ip, provider: 'iplocate' });
      return fb;
    }
  }

  return null;
}

function clearCache() {
  proxycheck.clearCache();
  iplocate.clearCache();
}

module.exports = { lookup, clearCache, fallbackEnabled };
