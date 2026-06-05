/**
 * uaParser/detect.js — Version detection and extension loader.
 *
 * Detects which version of ua-parser-js is installed (v1 or v2) and
 * loads Pro extensions when UAPARSER_PRO=true in .env.
 *
 * Tier 1: v1 (^1.0.x)  — basic parsing, manual bot/inapp detection
 * Tier 2: v2 (^2.0.x)  — browser.type, client hints, isFrozenUA
 * Tier 3: v2 + Pro      — Crawlers, InApps, Fetchers, CLIs extensions + isBot/isAICrawler helpers
 */

'use strict';

const UAParser = require('ua-parser-js');

// Detect version
let majorVersion = 1;
try {
  const pkg = require('ua-parser-js/package.json');
  majorVersion = parseInt(pkg.version, 10) || 1;
} catch (e) {
  // v1 might not expose package.json via require — check API shape instead
  try {
    const p = new UAParser('test');
    const r = p.getResult();
    // v2 result has browser.type; v1 does not
    if ('type' in (r.browser || {})) majorVersion = 2;
  } catch (_) {}
}

// Load Pro extensions (v2 only)
let extensions = [];
let helpers = {};
const proEnabled = process.env.UAPARSER_PRO === 'true';

if (majorVersion >= 2 && proEnabled) {
  // Try loading each extension — they may not all be available
  const extNames = [
    { path: 'ua-parser-js/extensions/ua-parser-extensions-crawlers', name: 'Crawlers' },
    { path: 'ua-parser-js/extensions/ua-parser-extensions-inapps', name: 'InApps' },
    { path: 'ua-parser-js/extensions/ua-parser-extensions-fetchers', name: 'Fetchers' },
    { path: 'ua-parser-js/extensions/ua-parser-extensions-clis', name: 'CLIs' },
    { path: 'ua-parser-js/extensions/ua-parser-extensions-emails', name: 'Emails' },
    { path: 'ua-parser-js/extensions/ua-parser-extensions-media-players', name: 'MediaPlayers' },
  ];

  for (const ext of extNames) {
    try {
      const mod = require(ext.path);
      if (mod) extensions.push(mod);
    } catch (e) {
      // Extension not available in this build — skip silently
    }
  }

  // Load helper functions
  const helperPaths = [
    { path: 'ua-parser-js/helpers/ua-parser-helpers-is-bot', names: ['isBot'] },
    { path: 'ua-parser-js/helpers/ua-parser-helpers-is-ai-crawler', names: ['isAICrawler'] },
    { path: 'ua-parser-js/helpers/ua-parser-helpers-is-ai-assistant', names: ['isAIAssistant'] },
    { path: 'ua-parser-js/helpers/ua-parser-helpers-is-frozen-ua', names: ['isFrozenUA'] },
  ];

  for (const h of helperPaths) {
    try {
      const mod = require(h.path);
      if (mod) {
        for (const name of h.names) {
          if (typeof mod[name] === 'function') helpers[name] = mod[name];
          else if (typeof mod === 'function') helpers[name] = mod;
        }
      }
    } catch (e) {}
  }
}

// Also try loading isFrozenUA for v2 free (it's in the base package)
if (majorVersion >= 2 && !helpers.isFrozenUA) {
  try {
    const mod = require('ua-parser-js/helpers/ua-parser-helpers-is-frozen-ua');
    if (typeof mod === 'function') helpers.isFrozenUA = mod;
    else if (mod?.isFrozenUA) helpers.isFrozenUA = mod.isFrozenUA;
  } catch (e) {}
}

const tier = majorVersion >= 2 ? (proEnabled && extensions.length > 0 ? 3 : 2) : 1;

module.exports = {
  UAParser,
  majorVersion,
  tier,
  proEnabled,
  extensions,
  helpers,
};
