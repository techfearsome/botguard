/**
 * uaParser/normalize.js — Normalize UAParser output across versions.
 *
 * v1 and v2 have subtle differences in output:
 *   - v1: browser.name = "Chrome" on mobile
 *   - v2: browser.name = "Mobile Chrome" on mobile
 *   - v1: os.name = "Mac OS"
 *   - v2: os.name = "macOS"
 *
 * This module provides a consistent output format regardless of version.
 */

'use strict';

/**
 * Normalize the raw UAParser getResult() output.
 * Returns a consistent object shape for both v1 and v2.
 *
 * @param {object} raw — getResult() output from UAParser
 * @param {number} version — 1 or 2
 * @returns {object}
 */
function normalizeResult(raw, version) {
  if (!raw) return defaultResult();

  // Browser — normalize mobile prefix in v2
  const browserName = raw.browser?.name || null;
  const browserVersion = raw.browser?.version || null;
  const browserMajor = raw.browser?.major ||
    (browserVersion ? browserVersion.split('.')[0] : null);
  const browserType = raw.browser?.type || null; // v2 only: 'bot', 'inapp', 'email', etc.

  // OS — normalize naming differences
  let osName = raw.os?.name || null;
  if (osName) {
    // Normalize v1→v2 naming for consistency
    if (osName === 'Mac OS') osName = 'macOS';
    if (osName === 'Chromium OS') osName = 'Chrome OS';
  }
  const osVersion = raw.os?.version || null;

  // Device
  const deviceType = raw.device?.type || null; // 'mobile', 'tablet', 'smarttv', 'wearable', etc.
  const deviceVendor = raw.device?.vendor || null;
  const deviceModel = raw.device?.model || null;

  // Engine
  const engineName = raw.engine?.name || null;
  const engineVersion = raw.engine?.version || null;

  // CPU
  const cpuArch = raw.cpu?.architecture || null;

  return {
    browser: {
      name: browserName,
      version: browserVersion,
      major: browserMajor,
      type: browserType,
    },
    os: {
      name: osName,
      version: osVersion,
    },
    device: {
      type: deviceType,
      vendor: deviceVendor,
      model: deviceModel,
    },
    engine: {
      name: engineName,
      version: engineVersion,
    },
    cpu: {
      architecture: cpuArch,
    },
    _raw: raw,
    _version: version,
  };
}

function defaultResult() {
  return {
    browser: { name: null, version: null, major: null, type: null },
    os: { name: null, version: null },
    device: { type: null, vendor: null, model: null },
    engine: { name: null, version: null },
    cpu: { architecture: null },
    _raw: null,
    _version: 0,
  };
}

module.exports = { normalizeResult, defaultResult };
