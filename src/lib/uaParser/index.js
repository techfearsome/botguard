/**
 * uaParser/index.js — Unified User-Agent parsing module.
 *
 * Single entry point for all UA parsing in BotGuard. Abstracts away the
 * difference between ua-parser-js v1, v2, and v2 Pro.
 *
 * Usage:
 *   const { parseUA, getParserInfo } = require('./lib/uaParser');
 *   const result = parseUA(req.get('user-agent'), req.headers);
 *
 * .env config:
 *   UAPARSER_PRO=true  — enables Pro extensions (Crawlers, InApps, etc.)
 *   (omit or false)     — uses whatever version is installed with manual fallbacks
 *
 * Returns a unified result object regardless of tier.
 */

'use strict';

const { UAParser, majorVersion, tier, proEnabled, extensions, helpers } = require('./detect');
const { normalizeResult } = require('./normalize');
const { detectBot } = require('./botDetect');
const { detectInApp } = require('./inapp');
const { parseClientHintsManual, detectHintsMismatch } = require('./clientHints');
const { classifyDeviceClass, classifyDevice, deviceLabel } = require('./deviceClass');

// Log tier at startup
const tierNames = { 1: 'v1 (basic)', 2: 'v2 (enhanced)', 3: 'v2 Pro (full)' };
console.log(`[uaParser] Tier ${tier}: ua-parser-js ${majorVersion >= 2 ? 'v2' : 'v1'}${proEnabled ? ' + Pro extensions' : ''} (${tierNames[tier]})`);

/**
 * Parse a User-Agent string with all available detection methods.
 *
 * @param {string} ua — User-Agent string
 * @param {object} [headers] — Express req.headers (for client hints, v2+)
 * @returns {object} — unified result
 */
function parseUA(ua, headers) {
  const uaStr = String(ua || '');

  // ── Step 1: Parse with UAParser ────────────────────────────────────
  let parser;
  let raw;

  if (majorVersion >= 2) {
    // v2: pass headers for automatic client hints parsing
    parser = new UAParser(headers || uaStr);
    if (headers && uaStr) parser.setUA(uaStr);

    // Apply Pro extensions if available
    if (extensions.length > 0) {
      for (const ext of extensions) {
        try { parser.useExtension(ext); } catch (e) {}
      }
    }

    raw = parser.getResult();
  } else {
    // v1: UA string only
    parser = new UAParser(uaStr);
    raw = parser.getResult();
  }

  // ── Step 2: Normalize output ───────────────────────────────────────
  const normalized = normalizeResult(raw, majorVersion);

  // ── Step 3: Device classification ──────────────────────────────────
  const device_class = classifyDeviceClass(normalized);
  const device_type = classifyDevice(normalized);
  const device_label_str = deviceLabel(normalized);

  // ── Step 4: Bot detection ──────────────────────────────────────────
  const botResult = detectBot(uaStr, raw, helpers);

  // ── Step 5: In-app browser detection ───────────────────────────────
  const inappResult = detectInApp(uaStr, raw);

  // ── Step 6: Client hints ───────────────────────────────────────────
  let clientHints = null;
  let hintsMismatch = [];
  let isFrozenUA = null;

  if (majorVersion >= 2 && helpers.isFrozenUA) {
    try { isFrozenUA = helpers.isFrozenUA(uaStr); } catch (e) {}
  }

  // Manual client hints parsing (works on any tier when headers available)
  if (headers) {
    clientHints = parseClientHintsManual(headers);
    if (clientHints) {
      hintsMismatch = detectHintsMismatch(normalized, clientHints);
    }
  }

  // ── Build unified result ───────────────────────────────────────────
  return {
    // Core parsing (all tiers)
    browser: normalized.browser,
    os: normalized.os,
    device: normalized.device,
    engine: normalized.engine,
    cpu: normalized.cpu,

    // Device classification (all tiers)
    device_class,
    device_type,
    device_label: device_label_str,

    // Bot detection (all tiers, enhanced with Pro)
    is_bot: botResult.is_bot,
    is_known_crawler: botResult.is_known_crawler,
    is_ai_crawler: botResult.is_ai_crawler,
    bot_category: botResult.bot_category,
    bot_name: botResult.bot_name,

    // In-app browser (all tiers, enhanced with Pro)
    in_app_browser: inappResult.name,
    browser_type: inappResult.browser_type || normalized.browser.type,

    // Client hints (v2+ native, manual fallback on v1)
    client_hints: clientHints,
    hints_mismatch: hintsMismatch,

    // Frozen UA detection (v2+ only)
    is_frozen_ua: isFrozenUA,

    // Meta
    _tier: tier,
    _parser_version: majorVersion,
  };
}

/**
 * Get info about the current parser configuration.
 * Useful for admin/settings display.
 */
function getParserInfo() {
  return {
    tier,
    version: majorVersion,
    pro_enabled: proEnabled,
    extensions_loaded: extensions.length,
    helpers_available: Object.keys(helpers),
    tier_name: tierNames[tier],
  };
}

// Re-export device class utilities for modules that only need those
module.exports = {
  parseUA,
  getParserInfo,
  classifyDeviceClass,
  classifyDevice,
  deviceLabel,
  ALL_DEVICE_CLASSES: require('./deviceClass').ALL_DEVICE_CLASSES,
};
