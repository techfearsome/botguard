/**
 * uaParser/inapp.js — In-app browser detection.
 *
 * Detects when a click comes from an in-app browser (Facebook, Instagram,
 * TikTok, etc.). These browsers strip cookies, block redirects, and
 * behave oddly with paid traffic.
 *
 * When Pro InApps extension is loaded, uses v2's browser.type === 'inapp'
 * and browser.name for identification. Falls back to manual UA regex.
 *
 * @returns {string|null} — 'fb', 'ig', 'tiktok', 'linkedin', etc. or null
 */

'use strict';

/**
 * Manual in-app detection from UA string.
 * Always runs as baseline for all tiers.
 */
function detectInAppManual(ua) {
  if (!ua || typeof ua !== 'string') return null;
  const lower = ua.toLowerCase();

  if (lower.includes('fban') || lower.includes('fbav') || lower.includes('fb_iab')) return 'fb';
  if (lower.includes('instagram')) return 'ig';
  if (lower.includes('tiktok') || lower.includes('musical_ly') || lower.includes('bytedancewebview')) return 'tiktok';
  if (lower.includes('linkedinapp')) return 'linkedin';
  if (lower.includes('twitter') || lower.includes('twitterandroid')) return 'twitter';
  if (lower.includes('snapchat')) return 'snapchat';
  if (lower.includes('pinterest')) return 'pinterest';
  if (lower.includes('line/')) return 'line';
  if (lower.includes('micromessenger')) return 'wechat';
  if (lower.includes('telegram')) return 'telegram';
  if (lower.includes('kakaotalk')) return 'kakaotalk';

  return null;
}

/**
 * Detect in-app browser using best available method.
 *
 * @param {string} ua - User-Agent string
 * @param {object} parsedResult - v2 parsed result (may have browser.type)
 * @returns {{ name: string|null, browser_type: string|null }}
 */
function detectInApp(ua, parsedResult) {
  // v2 with InApps extension: browser.type === 'inapp'
  if (parsedResult?.browser?.type === 'inapp') {
    const name = mapBrowserNameToShort(parsedResult.browser.name);
    return { name: name || detectInAppManual(ua), browser_type: 'inapp' };
  }

  // Manual fallback
  const manual = detectInAppManual(ua);
  return { name: manual, browser_type: manual ? 'inapp' : null };
}

/**
 * Map v2's browser.name to our short codes (fb, ig, tiktok, etc.)
 */
function mapBrowserNameToShort(name) {
  if (!name) return null;
  const lower = name.toLowerCase();
  if (lower.includes('facebook')) return 'fb';
  if (lower.includes('instagram')) return 'ig';
  if (lower.includes('tiktok')) return 'tiktok';
  if (lower.includes('linkedin')) return 'linkedin';
  if (lower.includes('twitter') || lower.includes('x app')) return 'twitter';
  if (lower.includes('snapchat')) return 'snapchat';
  if (lower.includes('pinterest')) return 'pinterest';
  if (lower.includes('line')) return 'line';
  if (lower.includes('wechat') || lower.includes('weixin')) return 'wechat';
  if (lower.includes('telegram')) return 'telegram';
  return null;
}

module.exports = { detectInApp, detectInAppManual };
