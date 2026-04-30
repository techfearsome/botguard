/**
 * Header analysis filter.
 *
 * Bots are sloppy with headers. Real browsers send a consistent set:
 *   - User-Agent
 *   - Accept (with text/html)
 *   - Accept-Language
 *   - Accept-Encoding (with gzip at minimum)
 *   - Connection
 *
 * Headless tools, scrapers, and curl/python-requests typically miss several of these
 * or send them in an unusual order/format.
 *
 * NOTE: This is intentionally conservative. We don't try to fingerprint header order
 * (TLS fingerprinting is more reliable for that and it's a Cloudflare-layer concern).
 *
 * Returns: { score, flags, signals }
 */

const OBVIOUS_BOT_UAS = [
  /^curl\//i,
  /^wget\//i,
  /^python-requests/i,
  /^python-urllib/i,
  /^go-http-client/i,
  /^java\//i,
  /^okhttp/i,
  /^apache-httpclient/i,
  /^httpclient/i,
  /^lwp/i,
  /^node-fetch/i,
  /^axios\//i,
  /headless/i,
  /phantomjs/i,
  /electron/i,         // not always a bot but rarely a real ad click
];

const KNOWN_GOOD_BOT_UAS = [
  /googlebot/i,
  /bingbot/i,
  /yandexbot/i,
  /duckduckbot/i,
  /baiduspider/i,
  /applebot/i,
  /facebookexternalhit/i,    // these go through the prefetcher path; included here as fallback
];

const SUSPICIOUS_UA_PATTERNS = [
  /\bbot\b/i,
  /\bcrawler\b/i,
  /\bspider\b/i,
  /\bscraper\b/i,
  /\bscanner\b/i,
];

function headersFilter({ headers = {}, userAgent = '' }) {
  const flags = [];
  let score = 0;
  const ua = String(userAgent || '');

  // --- UA presence and shape ---
  if (!ua) {
    flags.push('ua_missing');
    score += 80;       // very strong signal
  } else if (ua.length < 20) {
    flags.push('ua_too_short');
    score += 50;
  } else if (ua.length > 600) {
    flags.push('ua_too_long');
    score += 30;
  }

  // Obvious bot UA libraries
  for (const re of OBVIOUS_BOT_UAS) {
    if (re.test(ua)) {
      flags.push('ua_obvious_bot');
      score += 90;
      break;
    }
  }

  // Generic "bot" / "crawler" mentions
  if (!flags.includes('ua_obvious_bot')) {
    for (const re of SUSPICIOUS_UA_PATTERNS) {
      if (re.test(ua)) {
        // Only flag if it isn't a known-good bot (which gets handled separately)
        const isKnownGood = KNOWN_GOOD_BOT_UAS.some((r) => r.test(ua));
        if (!isKnownGood) {
          flags.push('ua_suspicious');
          score += 40;
        }
        break;
      }
    }
  }

  // Known crawlers - we want to flag these, not score them as adversarial
  for (const re of KNOWN_GOOD_BOT_UAS) {
    if (re.test(ua)) {
      flags.push('ua_known_crawler');
      score += 50;     // not a "bad bot" but still not a human click - score it medium
      break;
    }
  }

  // --- Accept-Language ---
  const acceptLang = headers['accept-language'];
  if (!acceptLang) {
    flags.push('no_accept_language');
    score += 25;
  } else if (acceptLang === '*' || acceptLang === '*/*') {
    flags.push('accept_language_wildcard');
    score += 20;
  }

  // --- Accept ---
  const accept = headers['accept'];
  if (!accept) {
    flags.push('no_accept');
    score += 25;
  } else if (accept === '*/*' && !ua.toLowerCase().includes('mozilla')) {
    // */* is fine when sent by a browser, not when sent without Mozilla in the UA
    flags.push('accept_wildcard_no_mozilla');
    score += 15;
  } else if (!accept.includes('text/html') && !accept.includes('*/*')) {
    flags.push('accept_no_html');
    score += 30;
  }

  // --- Accept-Encoding ---
  const acceptEncoding = headers['accept-encoding'];
  if (!acceptEncoding) {
    flags.push('no_accept_encoding');
    score += 20;
  } else if (!/(gzip|br|deflate)/.test(acceptEncoding)) {
    flags.push('accept_encoding_unusual');
    score += 10;
  }

  // --- Connection ---
  const connection = headers['connection'];
  if (connection && connection.toLowerCase() === 'close' && /mozilla/i.test(ua)) {
    // Real browsers prefer keep-alive. "close" + Mozilla is suspicious.
    flags.push('connection_close_with_browser_ua');
    score += 15;
  }

  // --- DNT / sec-fetch consistency ---
  // Modern Chrome/Firefox/Safari send sec-fetch-* headers. Their absence on a Mozilla UA
  // suggests an automation library that's just setting the UA string.
  const hasSecFetch = Object.keys(headers).some((h) => h.startsWith('sec-fetch-'));
  const looksModernBrowser = /chrome\/[1-9]\d{2}/i.test(ua) || /firefox\/[1-9]\d{2}/i.test(ua);
  if (looksModernBrowser && !hasSecFetch) {
    flags.push('modern_ua_no_sec_fetch');
    score += 25;
  }

  // Cap at 100
  score = Math.min(100, score);

  return { score, flags };
}

module.exports = { headersFilter };
