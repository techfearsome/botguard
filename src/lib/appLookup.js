/**
 * appLookup.js — Mobile app placement enrichment.
 *
 * Google Ads puts the placement app ID in utm_content:
 *   mobileapp::1-1227579630     → iOS (Apple App Store ID)
 *   mobileapp::2-com.example    → Android (Google Play package name)
 *
 * iOS: free Apple iTunes Lookup API (no auth needed)
 * Android: constructs Play Store URL (no free metadata API)
 */

'use strict';

const logger = require('./logger');
const ITUNES_LOOKUP = 'https://itunes.apple.com/lookup';
const TIMEOUT_MS = 4000;
const CACHE_MAX = 500;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const cache = new Map();

function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() > e.expires) { cache.delete(key); return null; }
  return e.data;
}
function cacheSet(key, data) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { data, expires: Date.now() + CACHE_TTL_MS });
}

function parseAppPlacement(utmContent) {
  if (!utmContent || typeof utmContent !== 'string') return { platform: null, appId: null };
  const match = utmContent.match(/^mobileapp::(\d)-(.+)$/);
  if (!match) return { platform: null, appId: null };
  return {
    platform: match[1] === '1' ? 'ios' : match[1] === '2' ? 'android' : null,
    appId: match[2],
  };
}

async function lookupIosApp(appId) {
  if (!appId) return null;
  const cached = cacheGet('ios:' + appId);
  if (cached) return cached;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ITUNES_LOOKUP + '?id=' + encodeURIComponent(appId) + '&country=US', {
      signal: controller.signal, headers: { 'Accept': 'application/json' },
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const body = await res.json();
    if (!body.results || body.results.length === 0) return null;

    const app = body.results[0];
    const result = {
      platform: 'ios', app_id: appId,
      name: app.trackName || null,
      developer: app.artistName || null,
      icon_url: app.artworkUrl100 || app.artworkUrl60 || null,
      category: app.primaryGenreName || null,
      price: app.price != null ? (app.price === 0 ? 'Free' : '$' + app.price) : null,
      rating: app.averageUserRating || null,
      rating_count: app.userRatingCount || null,
      bundle_id: app.bundleId || null,
      store_url: 'https://apps.apple.com/app/id' + appId,
      description: (app.description || '').substring(0, 200),
    };
    cacheSet('ios:' + appId, result);
    return result;
  } catch (err) {
    clearTimeout(timeout);
    logger.warn('itunes_lookup_error', { appId, err: err.message });
    return null;
  }
}

function buildAndroidAppInfo(packageName) {
  if (!packageName) return null;
  const parts = packageName.split('.');
  const readable = parts[parts.length - 1].replace(/([A-Z])/g, ' $1').replace(/[_-]/g, ' ').trim();
  return {
    platform: 'android', app_id: packageName, name: null,
    package_name: packageName, readable_name: readable,
    store_url: 'https://play.google.com/store/apps/details?id=' + encodeURIComponent(packageName),
  };
}

async function resolveAppPlacement(utmContent) {
  const parsed = parseAppPlacement(utmContent);
  if (!parsed.platform || !parsed.appId) return null;
  if (parsed.platform === 'ios') return lookupIosApp(parsed.appId);
  if (parsed.platform === 'android') return buildAndroidAppInfo(parsed.appId);
  return null;
}

module.exports = { parseAppPlacement, resolveAppPlacement, lookupIosApp, buildAndroidAppInfo };
