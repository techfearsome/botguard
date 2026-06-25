/**
 * fakeUaDetect.js — Enhanced fake/spoofed User-Agent detection.
 *
 * Goes beyond simple regex matching of impossible versions. Combines:
 *   1. Impossible version numbers (iOS 19+, Android 15+)
 *   2. Automation/headless signatures (Selenium, Puppeteer, HeadlessChrome)
 *   3. Impossible browser/OS combinations (Safari on Android, Edge on iOS)
 *   4. Client-hint mismatches (UA says iPhone, Sec-CH-UA says Windows)
 *   5. Frozen UA correlation (Chrome's reduced UA with suspicious patterns)
 *
 * These compound signals are very hard for bot operators to fake
 * consistently — spoofing a UA string is easy, but keeping the UA, client
 * hints, and behavioral signals all internally consistent is much harder.
 */

'use strict';

// ── Layer 1: Impossible versions + automation (the original regex) ───
const IMPOSSIBLE_VERSION_RE = /iPhone OS (1[9]|[2-9]\d)_|Android (1[5-9]|[2-9]\d)\.|CrOS x86_64 1[5-9]\d{3}/i;
const AUTOMATION_RE = /HeadlessChrome|PhantomJS|Selenium|puppeteer|playwright|webdriver|python-requests|python-urllib|curl\/|wget\/|go-http-client|okhttp|java\/|node-fetch|axios\//i;

// ── Layer 3: Impossible browser/OS combinations ──────────────────────
// These combinations literally cannot occur on real devices.
const IMPOSSIBLE_COMBOS = [
  // Safari only exists on Apple platforms (iOS, macOS).
  // b = parsed browser name (e.g. "Safari", "Mobile Safari"), o = OS name.
  { test: (b, o) => /safari/i.test(b) && /android|windows|linux|chrome os/i.test(o), flag: 'safari_on_nonapple' },
  // Edge (modern) on iOS would be reported as "Edge iOS", not plain "Edge"
  { test: (b, o) => /^edge$/i.test(b) && /ios/i.test(o), flag: 'edge_on_ios' },
  // Internet Explorer on anything non-Windows
  { test: (b, o) => /(internet explorer|\bie\b|msie|trident)/i.test(b) && !/windows/i.test(o), flag: 'ie_on_nonwindows' },
  // Samsung Internet on non-Android
  { test: (b, o) => /samsung/i.test(b) && !/android/i.test(o), flag: 'samsung_on_nonandroid' },
];

// ── Layer: Outdated browser versions that are suspicious for ad traffic ─
// Very old Chrome/Firefox versions are almost always bots spoofing old UAs.
function isAncientBrowser(browserName, browserMajor) {
  if (!browserName || !browserMajor) return false;
  const major = parseInt(browserMajor, 10);
  if (isNaN(major)) return false;
  const name = browserName.toLowerCase();
  // These thresholds are well below any browser a real 2026 user would have
  if (name.includes('chrome') && major < 90 && major > 0) return true;
  if (name.includes('firefox') && major < 90 && major > 0) return true;
  if (name.includes('edge') && major < 90 && major > 0) return true;
  return false;
}

/**
 * Analyze a single click's UA data for fake/spoof signals.
 *
 * @param {object} opts
 * @param {string} opts.ua — raw User-Agent string
 * @param {object} opts.uaParsed — the ua_parsed subdoc from the Click
 * @returns {{ isFake: boolean, flags: string[], severity: number }}
 *   severity: 0 (clean), 1 (mild), 2 (moderate), 3 (strong)
 */
function analyzeFakeUA({ ua = '', uaParsed = {} }) {
  const flags = [];
  let severity = 0;

  if (!ua) {
    return { isFake: true, flags: ['empty_ua'], severity: 2 };
  }

  // Layer 1: impossible versions
  if (IMPOSSIBLE_VERSION_RE.test(ua)) {
    flags.push('impossible_version');
    severity = Math.max(severity, 3);
  }

  // Layer 2: automation tools
  if (AUTOMATION_RE.test(ua)) {
    flags.push('automation_tool');
    severity = Math.max(severity, 3);
  }

  // Layer 3: impossible browser/OS combos
  const browserName = uaParsed.browser || '';
  const osName = uaParsed.os || '';
  for (const combo of IMPOSSIBLE_COMBOS) {
    try {
      if (combo.test(browserName, osName)) {
        flags.push(combo.flag);
        severity = Math.max(severity, 3);
      }
    } catch (e) {}
  }

  // Layer 4: client-hint mismatches (from v2 parser)
  if (Array.isArray(uaParsed.hints_mismatch) && uaParsed.hints_mismatch.length > 0) {
    for (const m of uaParsed.hints_mismatch) {
      flags.push(m);  // e.g. 'ch_platform_mismatch'
    }
    severity = Math.max(severity, 3);  // hint mismatch is very strong — hard to fake
  }

  // Layer 5: frozen UA — not fake by itself, but worth noting
  // (Chrome 100+ all share the same frozen UA, making fingerprinting harder)
  if (uaParsed.is_frozen_ua === true) {
    flags.push('frozen_ua');
    // Frozen UA alone is normal; only escalate if combined with other signals
    if (severity > 0) severity = Math.max(severity, 2);
  }

  // Layer 6: browser.type from v2 parser
  if (uaParsed.browser_type === 'bot') {
    flags.push('browser_type_bot');
    severity = Math.max(severity, 3);
  }

  // Layer 7: ancient browser versions
  if (isAncientBrowser(uaParsed.browser, uaParsed.browser_version?.split('.')[0])) {
    flags.push('ancient_browser');
    severity = Math.max(severity, 2);
  }

  return {
    isFake: severity >= 2,
    flags,
    severity,
  };
}

// Backward-compatible simple check (used where only the boolean matters)
function isFakeUA(ua) {
  if (!ua) return true;
  return IMPOSSIBLE_VERSION_RE.test(ua) || AUTOMATION_RE.test(ua);
}

module.exports = { analyzeFakeUA, isFakeUA, IMPOSSIBLE_VERSION_RE, AUTOMATION_RE };
