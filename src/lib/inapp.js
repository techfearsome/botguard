/**
 * Detect in-app browsers from User-Agent.
 * These browsers strip cookies, block redirects, and behave oddly with paid traffic.
 * Week 2 will add the escape mechanism (intent:// / x-safari-https://) using these flags.
 */

function detectInAppBrowser(ua = '') {
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

  return null;
}

module.exports = { detectInAppBrowser };
