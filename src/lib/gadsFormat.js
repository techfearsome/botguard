/**
 * gadsFormat.js — Format CIDR ranges into the exact syntax Google Ads accepts
 * for IP exclusions. Single source of truth shared by the Google Ads sync
 * endpoint and the admin Custom Export.
 *
 * Google Ads IP-exclusion rules this encodes:
 *   - IPv4: only /24 and /32 masks are accepted (plus bare addresses). Other
 *     masks are rejected by Google Ads, so we drop them (return null).
 *   - IPv6: the `::` zero-compression shorthand is REJECTED by Google Ads.
 *     It must be expanded into explicit :0 segments (8 groups total).
 */

'use strict';

/**
 * @param {string} cidr e.g. "1.2.3.0/24", "2003:d8::/32"
 * @returns {string|null} Google-Ads-safe form, or null if unsupported.
 */
function expandForGoogleAds(cidr) {
  if (!cidr) return null;

  // IPv4 — pass through, but filter unsupported masks
  if (!cidr.includes(':')) {
    if (cidr.includes('/')) {
      const bits = parseInt(cidr.split('/')[1], 10);
      if (bits !== 24 && bits !== 32) return null;
    }
    return cidr;
  }

  // IPv6 — expand :: compression
  let addr = cidr;
  let mask = '';

  if (addr.includes('/')) {
    const parts = addr.split('/');
    addr = parts[0];
    mask = '/' + parts[1];
  }

  if (addr.includes('::')) {
    const sides = addr.split('::');
    const left = sides[0] ? sides[0].split(':') : [];
    const right = sides[1] ? sides[1].split(':').filter((s) => s !== '') : [];
    const missing = 8 - left.length - right.length;
    const middle = [];
    for (let i = 0; i < missing; i++) middle.push('0');
    addr = [...left, ...middle, ...right].join(':');
  }

  const segments = addr.split(':');
  while (segments.length < 8) segments.push('0');

  return segments.slice(0, 8).join(':') + mask;
}

module.exports = { expandForGoogleAds };
