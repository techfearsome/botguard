/**
 * clickIdValidate.js — Format validation for ad-platform click identifiers.
 *
 * IMPORTANT: This validates the STRUCTURE of a click ID, not its authenticity.
 * Only the ad platform (via their API) can confirm a click ID is genuinely
 * theirs. This layer catches lazy fakes — bots that append gclid=123 or
 * gclid=test — by checking the value matches the known shape of a real ID.
 *
 * A determined bot can copy a real click ID or craft a structurally-valid
 * fake, so treat this as a heuristic that raises the bar, not a guarantee.
 *
 * Two levels:
 *   'loose'  — length + charset sanity only (very few false positives)
 *   'strict' — platform-specific patterns (catches more, small FP risk)
 */

'use strict';

// Base64url charset (what most click IDs use)
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Per-platform format rules.
 *   charset:  regex the whole value must match
 *   minLen / maxLen: length bounds
 *   prefix:   optional array of known prefixes (strict mode only)
 */
const FORMATS = {
  gclid: {
    charset: BASE64URL, minLen: 20, maxLen: 200,
    // gclid values are base64url, no reliable fixed prefix
  },
  wbraid: {
    charset: BASE64URL, minLen: 20, maxLen: 200,
    prefix: ['Cl'],  // wbraid consistently starts with "Cl"
  },
  gbraid: {
    charset: BASE64URL, minLen: 20, maxLen: 200,
  },
  msclkid: {
    charset: /^[a-f0-9]+$/i, minLen: 30, maxLen: 40,
    // Microsoft click IDs are 32-char hex
  },
  fbclid: {
    charset: /^[A-Za-z0-9_.-]+$/, minLen: 20, maxLen: 255,
    // Facebook click IDs are long, often start IwAR / IwZXh / IwY
  },
  ttclid: {
    charset: /^[A-Za-z0-9_.-]+$/, minLen: 15, maxLen: 255,
  },
  li_fat_id: {
    charset: /^[A-Za-z0-9_.-]+$/, minLen: 10, maxLen: 100,
  },
  twclid: {
    charset: /^[A-Za-z0-9_-]+$/, minLen: 10, maxLen: 100,
  },
  rdt_cid: {
    charset: /^[A-Za-z0-9_.-]+$/, minLen: 10, maxLen: 255,
  },
};

/**
 * Validate a single click ID's format.
 *
 * @param {string} idName — e.g. 'gclid'
 * @param {string} value — the click ID value
 * @param {string} level — 'loose' | 'strict'
 * @returns {{ valid: boolean, reason: string|null }}
 */
function validateClickId(idName, value, level = 'loose') {
  const fmt = FORMATS[idName];
  if (!fmt) return { valid: true, reason: null }; // unknown ID type — don't judge

  if (!value || typeof value !== 'string') {
    return { valid: false, reason: 'empty' };
  }

  const v = value.trim();

  // Length bounds (both levels)
  if (v.length < fmt.minLen) return { valid: false, reason: 'too_short' };
  if (v.length > fmt.maxLen) return { valid: false, reason: 'too_long' };

  // Charset (both levels)
  if (fmt.charset && !fmt.charset.test(v)) {
    return { valid: false, reason: 'bad_charset' };
  }

  // Obvious-fake heuristics (both levels): reject common placeholder values
  const lower = v.toLowerCase();
  const OBVIOUS_FAKES = ['test', 'null', 'undefined', 'none', 'true', 'false', '12345', '123456', 'abc123', 'xxxxx', 'sample', 'placeholder', 'value', 'clickid'];
  if (OBVIOUS_FAKES.includes(lower)) {
    return { valid: false, reason: 'placeholder_value' };
  }

  // Repeated single char (e.g. "aaaaaaaa" or "00000000")
  if (/^(.)\1+$/.test(v)) {
    return { valid: false, reason: 'repeated_char' };
  }

  // Strict mode: check known prefixes
  if (level === 'strict' && fmt.prefix) {
    const hasPrefix = fmt.prefix.some(p => v.startsWith(p));
    if (!hasPrefix) return { valid: false, reason: 'bad_prefix' };
  }

  // Strict mode: require some entropy (a real ID isn't a short dictionary word).
  // Count distinct characters — real click IDs have high variety.
  if (level === 'strict') {
    const distinct = new Set(v).size;
    if (distinct < 8) return { valid: false, reason: 'low_entropy' };
  }

  return { valid: true, reason: null };
}

module.exports = { validateClickId, FORMATS };
