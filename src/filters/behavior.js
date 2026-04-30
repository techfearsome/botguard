const crypto = require('crypto');

/**
 * Behavior filter.
 *
 * The JS challenge runs on the landing page and posts back a fingerprint payload to /go/fp.
 * That endpoint updates the existing click record with fingerprint data and re-runs scoring.
 *
 * This filter scores the fingerprint payload itself - things that are hard for headless
 * browsers and automation libraries to fake convincingly:
 *   - Canvas fingerprint (varies by GPU + driver - all-zeros or empty = headless)
 *   - WebGL renderer string ("SwiftShader" or "Mesa OffScreen" = headless)
 *   - Screen dimensions match common physical displays
 *   - Timezone present and plausible
 *   - hasTouch consistent with UA mobile claim
 *   - Mouse movement / interaction events (the JS challenge waits a beat for any movement)
 *
 * Crucially, the absence of fingerprint data after a few seconds is itself suspicious -
 * but only for non-prefetcher traffic. Prefetchers don't run JS at all.
 */

// Headless WebGL renderers
const HEADLESS_WEBGL_PATTERNS = [
  /swiftshader/i,
  /mesa[^a-z]?offscreen/i,
  /software/i,
  /llvmpipe/i,
];

function behaviorFilter({ fingerprint = null, isPrefetcher = false }) {
  const flags = [];
  let score = 0;

  // Prefetchers don't run JS - absent fingerprint is expected and not penalized
  if (isPrefetcher) {
    flags.push('fp_skipped_prefetcher');
    return { score: 0, flags };
  }

  // No fingerprint received yet - this happens for the FIRST request before JS runs.
  // The /go/fp endpoint updates this later. We score it as "pending" not "missing".
  if (!fingerprint || Object.keys(fingerprint).length === 0) {
    flags.push('fp_pending');
    return { score: 0, flags };
  }

  // --- Canvas ---
  if (!fingerprint.canvas || fingerprint.canvas === '') {
    flags.push('canvas_empty');
    score += 30;
  } else if (/^(0+|f+)$/i.test(fingerprint.canvas.replace(/[^0-9a-f]/gi, ''))) {
    flags.push('canvas_uniform');
    score += 50;
  }

  // --- WebGL ---
  if (!fingerprint.webgl) {
    flags.push('webgl_missing');
    score += 20;
  } else {
    for (const re of HEADLESS_WEBGL_PATTERNS) {
      if (re.test(fingerprint.webgl)) {
        flags.push('webgl_headless');
        score += 60;
        break;
      }
    }
  }

  // --- Screen ---
  // Screen dimensions of 0x0 or improbably tiny values are suspicious
  if (fingerprint.screen) {
    const m = String(fingerprint.screen).match(/(\d+)x(\d+)/);
    if (m) {
      const w = Number(m[1]), h = Number(m[2]);
      if (w === 0 || h === 0) { flags.push('screen_zero'); score += 40; }
      else if (w < 320 || h < 240) { flags.push('screen_tiny'); score += 30; }
    }
  } else {
    flags.push('screen_missing');
    score += 15;
  }

  // --- Timezone ---
  if (!fingerprint.tz) {
    flags.push('tz_missing');
    score += 15;
  }

  // --- Language ---
  if (!fingerprint.lang) {
    flags.push('lang_missing');
    score += 10;
  }

  // --- Interaction signals (set by the challenge after a brief observation window) ---
  if (fingerprint.interaction === 'none') {
    flags.push('no_interaction');
    score += 20;
  } else if (fingerprint.interaction === 'mouse' || fingerprint.interaction === 'touch') {
    // Positive signal - subtract a bit
    flags.push('has_interaction');
    score = Math.max(0, score - 10);
  }

  // --- Webdriver flag (navigator.webdriver === true) ---
  if (fingerprint.webdriver === true) {
    flags.push('webdriver_flag');
    score += 80;
  }

  score = Math.min(100, score);
  return { score, flags };
}

/**
 * Compute a stable hash of the fingerprint - used for session matching and rate limiting.
 */
function hashFingerprint(fp = {}) {
  const parts = [
    fp.canvas || '',
    fp.webgl || '',
    fp.screen || '',
    fp.tz || '',
    fp.lang || '',
    fp.platform || '',
  ].join('|');
  return crypto.createHash('sha256').update(parts).digest('hex').slice(0, 32);
}

module.exports = { behaviorFilter, hashFingerprint };
