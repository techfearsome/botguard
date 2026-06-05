/**
 * uaParser/botDetect.js — Bot and crawler detection.
 *
 * Three layers:
 *   1. Pro helpers (isBot, isAICrawler) when available — most comprehensive
 *   2. v2 browser.type === 'bot' — good coverage
 *   3. Manual regex fallback — always runs as baseline
 *
 * Returns: {
 *   is_bot: boolean,
 *   is_known_crawler: boolean,   // Googlebot, Bingbot, etc. (not adversarial)
 *   is_ai_crawler: boolean|null, // GPTBot, ClaudeBot, etc.
 *   bot_category: string|null,   // 'crawler'|'fetcher'|'cli'|'scraper'|'monitor'|null
 *   bot_name: string|null,       // 'Googlebot'|'AhrefsBot'|null (Pro only)
 * }
 */

'use strict';

// ── Manual detection lists (always available, any tier) ──────────────

const OBVIOUS_BOT_UAS = [
  /^curl\//i, /^wget\//i, /^python-requests/i, /^python-urllib/i,
  /^go-http-client/i, /^java\//i, /^okhttp/i, /^apache-httpclient/i,
  /^httpclient/i, /^lwp/i, /^node-fetch/i, /^axios\//i,
  /headless/i, /phantomjs/i, /electron/i, /puppeteer/i, /playwright/i,
  /selenium/i, /webdriver/i,
];

const KNOWN_GOOD_CRAWLERS = [
  { re: /googlebot/i, name: 'Googlebot' },
  { re: /adsbot-google/i, name: 'AdsBot-Google' },
  { re: /mediapartners-google/i, name: 'Mediapartners-Google' },
  { re: /feedfetcher-google/i, name: 'FeedFetcher-Google' },
  { re: /google-inspectiontool/i, name: 'Google-InspectionTool' },
  { re: /bingbot/i, name: 'Bingbot' },
  { re: /slurp/i, name: 'Yahoo Slurp' },
  { re: /yandexbot/i, name: 'YandexBot' },
  { re: /duckduckbot/i, name: 'DuckDuckBot' },
  { re: /baiduspider/i, name: 'Baiduspider' },
  { re: /applebot/i, name: 'Applebot' },
  { re: /facebookexternalhit/i, name: 'FacebookBot' },
  { re: /twitterbot/i, name: 'Twitterbot' },
  { re: /linkedinbot/i, name: 'LinkedInBot' },
  { re: /pinterestbot/i, name: 'Pinterestbot' },
];

const SUSPICIOUS_BOT_PATTERNS = [
  /\bbot\b/i, /\bcrawler\b/i, /\bspider\b/i,
  /\bscraper\b/i, /\bscanner\b/i,
];

const AI_CRAWLER_UAS = [
  /gptbot/i, /chatgpt/i, /claudebot/i, /anthropic/i,
  /cohere-ai/i, /perplexitybot/i, /bytespider/i,
  /meta-externalagent/i, /diffbot/i,
];

/**
 * Detect bots using all available methods.
 *
 * @param {string} ua - User-Agent string
 * @param {object} parsedResult - Parsed result from UAParser (v1 or v2)
 * @param {object} helpers - Pro helper functions { isBot, isAICrawler } or empty
 * @returns {object}
 */
function detectBot(ua, parsedResult, helpers = {}) {
  const result = {
    is_bot: false,
    is_known_crawler: false,
    is_ai_crawler: null,
    bot_category: null,
    bot_name: null,
  };

  const uaStr = String(ua || '');
  if (!uaStr) {
    result.is_bot = true;
    result.bot_category = 'empty_ua';
    return result;
  }

  // ── Layer 1: Pro helpers (most accurate, maintained database) ───────
  if (helpers.isBot && parsedResult) {
    try {
      if (helpers.isBot(parsedResult)) {
        result.is_bot = true;
        result.bot_category = 'pro_detected';
      }
    } catch (e) {}
  }

  if (helpers.isAICrawler && parsedResult) {
    try {
      result.is_ai_crawler = !!helpers.isAICrawler(parsedResult);
    } catch (e) {}
  }

  // ── Layer 2: v2 browser.type (available in v2 free + Pro) ──────────
  if (parsedResult?.browser?.type === 'bot') {
    result.is_bot = true;
    if (!result.bot_category) result.bot_category = 'browser_type_bot';
  }

  // v2 browser name for bots includes the bot name (e.g. "Googlebot")
  if (parsedResult?.browser?.type === 'bot' && parsedResult?.browser?.name) {
    result.bot_name = parsedResult.browser.name;
  }

  // ── Layer 3: Manual regex (always runs as baseline) ────────────────

  // Known good crawlers (not adversarial — Googlebot, Bingbot, etc.)
  for (const { re, name } of KNOWN_GOOD_CRAWLERS) {
    if (re.test(uaStr)) {
      result.is_bot = true;
      result.is_known_crawler = true;
      if (!result.bot_name) result.bot_name = name;
      if (!result.bot_category) result.bot_category = 'known_crawler';
      break;
    }
  }

  // Obvious bot libraries (curl, python-requests, etc.)
  if (!result.is_bot) {
    for (const re of OBVIOUS_BOT_UAS) {
      if (re.test(uaStr)) {
        result.is_bot = true;
        if (!result.bot_category) result.bot_category = 'obvious_bot';
        break;
      }
    }
  }

  // Suspicious patterns ("bot", "crawler", "spider" in UA)
  if (!result.is_bot) {
    for (const re of SUSPICIOUS_BOT_PATTERNS) {
      if (re.test(uaStr)) {
        // Only flag if NOT a known good crawler (already handled above)
        result.is_bot = true;
        if (!result.bot_category) result.bot_category = 'suspicious_pattern';
        break;
      }
    }
  }

  // AI crawlers (manual check if Pro helper didn't run)
  if (result.is_ai_crawler === null) {
    result.is_ai_crawler = AI_CRAWLER_UAS.some(re => re.test(uaStr));
  }

  return result;
}

module.exports = {
  detectBot,
  OBVIOUS_BOT_UAS,
  KNOWN_GOOD_CRAWLERS,
  SUSPICIOUS_BOT_PATTERNS,
  AI_CRAWLER_UAS,
};
