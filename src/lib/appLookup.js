/**
 * appLookup.js — Mobile app placement enrichment.
 *
 * Google Ads puts the placement app ID in utm_content:
 *   mobileapp::1-1227579630     → iOS (Apple App Store ID)
 *   mobileapp::2-com.example    → Android (Google Play package name)
 *
 * This module resolves those IDs to human-readable app info:
 *   - iOS: calls Apple's free iTunes Lookup API (no auth needed)
 *   - Android: constructs the Play Store URL (no free metadata API)
 *
 * Results are cached in memory (app metadata rarely changes).
 */

'use strict';

const logger = require('./logger');

const ITUNES_LOOKUP = 'https://itunes.apple.com/lookup';
const PLAY_STORE_URL = 'https://play.google.com/store/apps/details';
const APP_STORE_URL = 'https://apps.apple.com/app/id';
const TIMEOUT_MS = 4000;
const CACHE_MAX = 500;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — app names rarely change

// In-memory cache
const cache = new Map();

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) { cache.delete(key); return null; }
  return entry.data;
}

function cacheSet(key, data) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { data, expires: Date.now() + CACHE_TTL_MS });
}

/**
 * Parse utm_content to extract app placement info.
 *
 * @param {string} utmContent — e.g. "mobileapp::1-1227579630"
 * @returns {{ platform: 'ios'|'android'|null, appId: string|null, raw: string }}
 */
function parseAppPlacement(utmContent) {
  if (!utmContent || typeof utmContent !== 'string') return { platform: null, appId: null, raw: '' };

  const match = utmContent.match(/^mobileapp::(\d)-(.+)$/);
  if (!match) return { platform: null, appId: null, raw: utmContent };

  const platformCode = match[1];
  const appId = match[2];

  return {
    platform: platformCode === '1' ? 'ios' : platformCode === '2' ? 'android' : null,
    appId,
    raw: utmContent,
  };
}

/**
 * Look up iOS app metadata from Apple's iTunes Lookup API.
 * Free, no auth, no rate limit (reasonable usage).
 *
 * @param {string} appId — numeric Apple ID, e.g. "1227579630"
 * @returns {Promise<object|null>}
 */
async function lookupIosApp(appId) {
  if (!appId) return null;

  const cached = cacheGet(`ios:${appId}`);
  if (cached) return cached;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${ITUNES_LOOKUP}?id=${encodeURIComponent(appId)}&country=US`, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });
    clearTimeout(timeout);

    if (!res.ok) return null;
    const body = await res.json();
    if (!body.results || body.results.length === 0) return null;

    const app = body.results[0];
    const result = {
      platform: 'ios',
      app_id: appId,
      name: app.trackName || null,
      developer: app.artistName || null,
      icon_url: app.artworkUrl100 || app.artworkUrl60 || null,
      category: app.primaryGenreName || null,
      price: app.price != null ? (app.price === 0 ? 'Free' : `$${app.price}`) : null,
      rating: app.averageUserRating || null,
      rating_count: app.userRatingCount || null,
      bundle_id: app.bundleId || null,
      store_url: `${APP_STORE_URL}${appId}`,
      description: (app.description || '').substring(0, 200),
    };

    cacheSet(`ios:${appId}`, result);
    return result;
  } catch (err) {
    clearTimeout(timeout);
    logger.warn('itunes_lookup_error', { appId, err: err.name === 'AbortError' ? 'timeout' : err.message });
    return null;
  }
}

/**
 * Build Android app info from the package name.
 * Google Play has no free public metadata API, so we return what we can
 * construct from the package name itself.
 *
 * @param {string} packageName — e.g. "com.google.android.youtube"
 * @returns {object}
 */
function buildAndroidAppInfo(packageName) {
  if (!packageName) return null;

  // Extract a readable name from the package name
  // com.google.android.youtube → "youtube"
  // com.facebook.katana → "katana" (Facebook's app)
  const parts = packageName.split('.');
  const lastPart = parts[parts.length - 1] || packageName;
  const readableName = lastPart
    .replace(/([A-Z])/g, ' $1')  // camelCase → words
    .replace(/[_-]/g, ' ')       // underscores/dashes → spaces
    .trim();

  return {
    platform: 'android',
    app_id: packageName,
    name: null, // Can't resolve without a paid API
    package_name: packageName,
    readable_name: readableName,
    store_url: `${PLAY_STORE_URL}?id=${encodeURIComponent(packageName)}`,
  };
}

/**
 * Resolve app placement from utm_content.
 * Returns enriched app info or null if not a mobile app placement.
 *
 * @param {string} utmContent
 * @returns {Promise<object|null>}
 */
async function resolveAppPlacement(utmContent) {
  const parsed = parseAppPlacement(utmContent);
  if (!parsed.platform || !parsed.appId) return null;

  if (parsed.platform === 'ios') {
    return lookupIosApp(parsed.appId);
  }

  if (parsed.platform === 'android') {
    return buildAndroidAppInfo(parsed.appId);
  }

  return null;
}

module.exports = { parseAppPlacement, resolveAppPlacement, lookupIosApp, buildAndroidAppInfo };
