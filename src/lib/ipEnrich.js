/**
 * ipEnrich.js — IP enrichment provider abstraction.
 *
 * Two providers, ProxyCheck and IPLocate, both normalize to the identical
 * shape, so the scoring chain and the Level 2 bot guard behave the same
 * regardless of which one answered.
 *
 * Which one is tried first is configurable via IP_PRIMARY_PROVIDER
 * ('proxycheck' (default) | 'iplocate'). The other provider becomes the
 * fallback. If the primary returns no usable data (timeout, network error,
 * non-ok status, or no API key) and the fallback is enabled, we fall back to
 * the secondary provider.
 *
 * Neither provider's lookup() throws — each returns null on any failure
 * (including a missing API key) — so the fallback trigger is simply "primary
 * returned null". Both return real data (is_proxy:false) for clean IPs, so the
 * fallback does NOT fire on every clean lookup, only on genuine primary
 * failures.
 *
 * FIX 2 — Enrichment timeout (fail-open): the entire provider chain is wrapped
 * in a time budget. If ProxyCheck (+ optional IPLocate fallback) doesn't
 * respond within the budget, the click proceeds with null enrichment rather
 * than holding the connection open. This directly stops the pile-up under load:
 * requests no longer queue behind slow API calls.
 *
 * Env:
 *   IP_PRIMARY_PROVIDER         — 'proxycheck' (default) | 'iplocate'
 *   PROXYCHECK_API_KEY          — ProxyCheck key
 *   IPLOCATE_API_KEY            — IPLocate key
 *   IPLOCATE_FALLBACK_ENABLED   — 'true'|'yes'|'1'|'on' to enable the fallback
 *                                 (IP_FALLBACK_ENABLED is accepted as an alias)
 *   ENRICH_TIMEOUT_MS           — max ms to wait for enrichment (default 2000)
 *                                 0 = no timeout (previous behavior)
 */

'use strict';

const proxycheck = require('./proxycheck');
const iplocate = require('./iplocate');
const logger = require('./logger');

function fallbackEnabled() {
  const raw = process.env.IP_FALLBACK_ENABLED || process.env.IPLOCATE_FALLBACK_ENABLED || '';
  const v = String(raw).trim().toLowerCase();
  return v === 'true' || v === 'yes' || v === '1' || v === 'on';
}

// Which provider is tried first. Defaults to ProxyCheck for backward compat.
function primaryProvider() {
  const v = String(process.env.IP_PRIMARY_PROVIDER || 'proxycheck').trim().toLowerCase();
  return v === 'iplocate' ? 'iplocate' : 'proxycheck';
}

const PROVIDERS = { proxycheck, iplocate };

function getTimeoutMs() {
  const v = parseInt(process.env.ENRICH_TIMEOUT_MS, 10);
  return Number.isFinite(v) && v >= 0 ? v : 2000;
}

// The actual provider chain — called inside the timeout wrapper.
async function _lookupProviders(ip) {
  const primaryName = primaryProvider();
  const fallbackName = primaryName === 'iplocate' ? 'proxycheck' : 'iplocate';

  // Primary.
  const primary = await PROVIDERS[primaryName].lookup(ip);
  if (primary) return primary;

  // Primary produced nothing usable — fall back to the other provider if enabled.
  // Each provider's lookup() returns null (no network call) when its own API key
  // is missing, so no explicit key check is needed here.
  if (fallbackEnabled()) {
    const fb = await PROVIDERS[fallbackName].lookup(ip);
    if (fb) {
      logger.info('ip_enrich_fallback_used', { ip, provider: fallbackName });
      return fb;
    }
  }

  return null;
}

/**
 * Look up IP enrichment with a time budget. If the providers don't respond
 * within ENRICH_TIMEOUT_MS, return null (fail-open) so the click proceeds
 * unenriched rather than holding the connection.
 */
async function lookup(ip) {
  if (!ip) return null;

  const budget = getTimeoutMs();
  if (budget <= 0) {
    // Timeout disabled — previous behavior (wait as long as the provider takes).
    return _lookupProviders(ip);
  }

  try {
    const result = await Promise.race([
      _lookupProviders(ip),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('enrich_timeout')), budget)
      ),
    ]);
    return result;
  } catch (err) {
    if (err.message === 'enrich_timeout') {
      logger.warn('enrich_timeout', { ip, budget_ms: budget });
    } else {
      logger.warn('enrich_lookup_error', { ip, err: err.message });
    }
    return null;
  }
}

function clearCache() {
  proxycheck.clearCache();
  iplocate.clearCache();
}

module.exports = { lookup, clearCache, fallbackEnabled, primaryProvider, getTimeoutMs };
