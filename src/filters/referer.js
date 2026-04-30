/**
 * Referrer integrity filter.
 *
 * Each utm_source has expectations about where the traffic should be coming from.
 *   - utm_source=facebook  → referer should be facebook.com / m.facebook.com / fb.com / l.facebook.com
 *   - utm_source=google    → referer should be google.* (search) or doubleclick / googleadservices (display)
 *   - utm_source=tiktok    → referer should be tiktok.com or in-app browser
 *   - utm_source=newsletter (email) → referer is usually empty or the email provider's link wrapper
 *
 * Mismatches don't always mean fraud (Safari & strict referrer policies hide referers),
 * but they're a useful signal especially when combined with other flags.
 *
 * Returns: { score, flags }
 */

const SOURCE_REFERER_PATTERNS = {
  facebook: [/facebook\.com$/, /\.facebook\.com$/, /\bfb\.com$/, /messenger\.com$/, /m\.me$/],
  fb: [/facebook\.com$/, /\.facebook\.com$/, /\bfb\.com$/],
  meta: [/facebook\.com$/, /\.facebook\.com$/, /instagram\.com$/, /\.instagram\.com$/],
  instagram: [/instagram\.com$/, /\.instagram\.com$/],
  ig: [/instagram\.com$/, /\.instagram\.com$/],
  google: [/google\./, /doubleclick\.net$/, /googleadservices\.com$/, /googlesyndication\.com$/],
  google_ads: [/google\./, /doubleclick\.net$/, /googleadservices\.com$/],
  youtube: [/youtube\.com$/, /\.youtube\.com$/, /youtu\.be$/],
  bing: [/bing\.com$/, /\.bing\.com$/, /msn\.com$/],
  microsoft_ads: [/bing\.com$/, /msn\.com$/],
  tiktok: [/tiktok\.com$/, /\.tiktok\.com$/],
  twitter: [/twitter\.com$/, /\.twitter\.com$/, /\bt\.co$/, /\bx\.com$/, /\.x\.com$/],
  x: [/twitter\.com$/, /\bt\.co$/, /\bx\.com$/, /\.x\.com$/],
  linkedin: [/linkedin\.com$/, /\.linkedin\.com$/, /\.licdn\.com$/],
  reddit: [/reddit\.com$/, /\.reddit\.com$/, /redd\.it$/],
  pinterest: [/pinterest\.com$/, /\.pinterest\.com$/, /\.pinimg\.com$/],
  snapchat: [/snapchat\.com$/, /\.snapchat\.com$/],
};

function refererFilter({ utm = {}, refererHost = null, externalIds = {}, inAppBrowser = null }) {
  const flags = [];
  let score = 0;

  const source = (utm.source || '').toLowerCase().trim();
  const medium = (utm.medium || '').toLowerCase().trim();

  // Email and direct sources don't have meaningful referer expectations
  if (medium === 'email' || source === 'email' || medium === 'newsletter') {
    if (!refererHost) flags.push('email_no_referer_ok');
    return { score: 0, flags };
  }
  if (source === 'direct' || source === '(direct)' || (!source && !refererHost)) {
    return { score: 0, flags: ['direct_traffic'] };
  }

  // External ad-platform click IDs are very strong attribution signals - if present and matching,
  // we trust the source even if the referer was stripped (common with Safari ITP).
  const hasExternalClickId =
    externalIds.fbclid || externalIds.gclid || externalIds.msclkid || externalIds.ttclid;

  // In-app browser click - referer often missing or unusual but the click is legit if utm matches
  if (inAppBrowser) {
    flags.push(`inapp_${inAppBrowser}`);
    return { score: 0, flags };
  }

  // No referer at all + paid source claim - mild flag, not blocking-grade
  if (!refererHost) {
    if (hasExternalClickId) {
      flags.push('no_referer_but_click_id');
      return { score: 5, flags };
    }
    flags.push('no_referer');
    score += 10;
    return { score, flags };
  }

  // Source claims something specific - check it
  const patterns = SOURCE_REFERER_PATTERNS[source];
  if (patterns) {
    const matched = patterns.some((re) => re.test(refererHost));
    if (matched) {
      flags.push(`referer_matches_${source}`);
      // Negative score is a "trust signal" - we let scoring decide whether to use it
      return { score: 0, flags };
    } else {
      flags.push(`referer_mismatch_${source}`);
      // Strong-ish signal but tempered if click_id present (referrer-policy can hide it)
      score += hasExternalClickId ? 10 : 30;
    }
  }

  // Source not in our table - we don't penalize, just record
  if (!patterns && source) {
    flags.push(`source_unknown:${source}`);
  }

  score = Math.min(100, score);
  return { score, flags };
}

module.exports = { refererFilter, SOURCE_REFERER_PATTERNS };
