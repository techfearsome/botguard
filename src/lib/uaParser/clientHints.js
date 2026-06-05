/**
 * uaParser/clientHints.js — Client Hints parsing.
 *
 * Chrome 100+ sends Sec-CH-UA-* headers with real browser/OS/device info
 * even when the User-Agent string is frozen/reduced. This module extracts
 * that data when available.
 *
 * v2 only — UAParser v2 can parse headers directly via `new UAParser(headers)`.
 * v1 fallback: manual parsing of the raw headers.
 */

'use strict';

// Headers that Chrome sends by default (low-entropy hints):
//   Sec-CH-UA: "Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="99"
//   Sec-CH-UA-Mobile: ?0
//   Sec-CH-UA-Platform: "Windows"
//
// High-entropy hints (require Permissions-Policy or JS API):
//   Sec-CH-UA-Platform-Version: "15.0.0"
//   Sec-CH-UA-Full-Version-List: ...
//   Sec-CH-UA-Model: "Pixel 7"
//   Sec-CH-UA-Arch: "arm"

/**
 * Extract client hints from request headers (manual parsing).
 * Used as fallback when v2 withClientHints() isn't available.
 *
 * @param {object} headers — Express req.headers (lowercase keys)
 * @returns {object|null}
 */
function parseClientHintsManual(headers) {
  if (!headers) return null;

  const chUA = headers['sec-ch-ua'];
  const chMobile = headers['sec-ch-ua-mobile'];
  const chPlatform = headers['sec-ch-ua-platform'];
  const chModel = headers['sec-ch-ua-model'];
  const chPlatformVersion = headers['sec-ch-ua-platform-version'];
  const chFullVersion = headers['sec-ch-ua-full-version-list'];
  const chArch = headers['sec-ch-ua-arch'];

  // If no client hints headers at all, this browser doesn't send them
  if (!chUA && !chPlatform) return null;

  const result = {
    has_client_hints: true,
    brands: [],
    mobile: null,
    platform: null,
    platform_version: null,
    model: null,
    architecture: null,
  };

  // Parse Sec-CH-UA brand list: "Chromium";v="136", "Google Chrome";v="136"
  if (chUA) {
    const brandRe = /"([^"]+)"\s*;\s*v="([^"]+)"/g;
    let m;
    while ((m = brandRe.exec(chUA)) !== null) {
      const name = m[1];
      // Skip the dummy "Not_A Brand" / "Not.A/Brand" entries
      if (/not[._\s]?a[/\\]?brand/i.test(name)) continue;
      result.brands.push({ name: m[1], version: m[2] });
    }
  }

  // Parse mobile flag: ?0 = not mobile, ?1 = mobile
  if (chMobile != null) {
    result.mobile = chMobile === '?1';
  }

  // Platform (OS)
  if (chPlatform) {
    result.platform = chPlatform.replace(/"/g, '');
  }

  if (chPlatformVersion) {
    result.platform_version = chPlatformVersion.replace(/"/g, '');
  }

  if (chModel) {
    result.model = chModel.replace(/"/g, '');
  }

  if (chArch) {
    result.architecture = chArch.replace(/"/g, '');
  }

  return result;
}

/**
 * Check for UA / Client Hints inconsistency.
 *
 * If the UA says "iPhone" but client hints say platform="Windows",
 * the UA is spoofed. This is a strong fraud signal.
 *
 * @param {object} uaResult — parsed UA result
 * @param {object} hints — parsed client hints
 * @returns {string[]} — array of mismatch flags
 */
function detectHintsMismatch(uaResult, hints) {
  if (!hints || !hints.has_client_hints || !uaResult) return [];
  const flags = [];

  // Platform mismatch: UA says iOS but hints say Windows
  const uaOS = String(uaResult.os?.name || '').toLowerCase();
  const hintPlatform = String(hints.platform || '').toLowerCase();

  if (hintPlatform && uaOS) {
    const platformMap = {
      'windows': ['windows'],
      'macos': ['mac', 'macos'],
      'linux': ['linux', 'ubuntu', 'fedora', 'debian'],
      'android': ['android'],
      'chrome os': ['chrome os', 'chromium os'],
    };
    for (const [hintKey, uaKeys] of Object.entries(platformMap)) {
      if (hintPlatform.includes(hintKey) && !uaKeys.some(k => uaOS.includes(k))) {
        flags.push('ch_platform_mismatch');
        break;
      }
    }
  }

  // Mobile mismatch: hints say mobile but UA says desktop (or vice versa)
  if (hints.mobile !== null && uaResult.device?.type) {
    const uaIsMobile = uaResult.device.type === 'mobile' || uaResult.device.type === 'tablet';
    if (hints.mobile && !uaIsMobile) flags.push('ch_mobile_mismatch_desktop_ua');
    if (!hints.mobile && uaIsMobile) flags.push('ch_mobile_mismatch_mobile_ua');
  }

  return flags;
}

module.exports = { parseClientHintsManual, detectHintsMismatch };
