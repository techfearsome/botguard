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

// Fetch one app from a specific iTunes storefront (country). Returns the parsed
// app object, or null if the app isn't in that storefront / on error.
async function fetchItunes(appId, cc) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ITUNES_LOOKUP + '?id=' + encodeURIComponent(appId) + '&country=' + encodeURIComponent(cc), {
      signal: controller.signal, headers: { 'Accept': 'application/json' },
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const body = await res.json();
    if (!body.results || body.results.length === 0) return null;

    const app = body.results[0];
    return {
      platform: 'ios', app_id: appId,
      name: app.trackName || null,
      developer: app.artistName || null,
      icon_url: app.artworkUrl100 || app.artworkUrl60 || null,
      category: app.primaryGenreName || null,
      price: app.price != null ? (app.price === 0 ? 'Free' : '$' + app.price) : null,
      rating: app.averageUserRating || null,
      rating_count: app.userRatingCount || null,
      bundle_id: app.bundleId || null,
      store_url: 'https://apps.apple.com/' + cc.toLowerCase() + '/app/id' + appId,
      description: (app.description || '').substring(0, 200),
      storefront: cc,
    };
  } catch (err) {
    clearTimeout(timeout);
    logger.warn('itunes_lookup_error', { appId, cc, err: err.message });
    return null;
  }
}

/**
 * Look up an iOS app, trying one or more storefront countries in order until a
 * result is found. Non-US apps don't exist in the US storefront, so passing the
 * click's IP-derived country (e.g. ['AT','US']) is what makes non-US placements
 * enrich. US is always tried last as a fallback. Cached per (storefront, appId).
 */
async function lookupIosApp(appId, countries = ['US']) {
  if (!appId) return null;
  const list = (Array.isArray(countries) ? countries : [countries])
    .map((c) => (c || '').toString().trim().toUpperCase()).filter(Boolean);
  if (!list.includes('US')) list.push('US'); // always fall back to US last

  const tried = new Set();
  for (const cc of list) {
    if (tried.has(cc)) continue;
    tried.add(cc);
    const key = 'ios:' + cc + ':' + appId;
    const cached = cacheGet(key);
    if (cached) return cached;
    const result = await fetchItunes(appId, cc);
    if (result) { cacheSet(key, result); return result; }
  }
  return null;
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

async function resolveAppPlacement(source, countries = ['US']) {
  // Accept a single string or an ordered list of candidate strings, e.g.
  // [utm_content, valuetrack.google.placement]. Use the first that parses to a
  // real mobileapp:: placement. Google sometimes leaves utm_content as the
  // literal "{placement}" token while the actual app placement lands in the
  // ValueTrack placement field — so we fall back to it.
  // `countries` is the ordered list of iTunes storefronts to try for iOS apps
  // (e.g. [clickCountry, 'US']) so non-US placements enrich.
  const candidates = Array.isArray(source) ? source : [source];
  for (const c of candidates) {
    const parsed = parseAppPlacement(c);
    if (parsed.platform && parsed.appId) {
      if (parsed.platform === 'ios') return lookupIosApp(parsed.appId, countries);
      if (parsed.platform === 'android') return buildAndroidAppInfo(parsed.appId);
    }
  }
  return null;
}

module.exports = { parseAppPlacement, resolveAppPlacement, lookupIosApp, buildAndroidAppInfo };
