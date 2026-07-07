/**
 * guardVerify.js — Level 2 bot guard verification logic.
 *
 * Takes the client-collected signals from the guard page and the click's
 * stored ProxyCheck data, runs the configured checks, and returns a verdict.
 *
 * The killer check is timezone: ProxyCheck's IP timezone vs the browser's
 * reported timezone. Both are IANA format ("Asia/Kolkata"), so it's a direct
 * comparison. A bot using a US proxy from a European server fails instantly.
 */

'use strict';

// Timezone aliases — some zones have multiple valid names for the same offset.
// We treat these as equivalent to avoid false positives.
const TZ_ALIASES = {
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'Asia/Rangoon': 'Asia/Yangon',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
  'Europe/Kiev': 'Europe/Kyiv',
  'US/Eastern': 'America/New_York',
  'US/Central': 'America/Chicago',
  'US/Mountain': 'America/Denver',
  'US/Pacific': 'America/Los_Angeles',
};

function normalizeTz(tz) {
  if (!tz) return null;
  return TZ_ALIASES[tz] || tz;
}

/**
 * Compare two IANA timezones for equivalence.
 * Falls back to comparing the region (continent) when the exact zone differs
 * but both are in the same broad area — reduces false positives from users
 * near timezone boundaries while still catching cross-continent mismatches.
 */
function timezonesMatch(ipTz, browserTz) {
  if (!ipTz || !browserTz) return null; // can't determine → don't penalize
  const a = normalizeTz(ipTz);
  const b = normalizeTz(browserTz);
  if (a === b) return true;

  // Same continent prefix (e.g. both "America/...") is a soft match —
  // catches the strong signal (US IP + Europe browser) but forgives
  // intra-continent differences (America/New_York vs America/Chicago).
  const contA = a.split('/')[0];
  const contB = b.split('/')[0];
  if (contA !== contB) return false; // different continents = strong mismatch

  return true; // same continent, treat as acceptable
}

/**
 * Run Level 2 verification.
 *
 * @param {object} opts
 * @param {object} opts.signals — client-collected signals from the guard page
 * @param {object} opts.click — the Click document (has ProxyCheck timezone)
 * @param {object} opts.config — bot_guard config from the landing page
 * @returns {{ pass: boolean, flags: string[], detail: object }}
 */
function verifyGuard({ signals = {}, click = {}, config = {} }) {
  const flags = [];
  const detail = {
    ip_timezone: click.timezone || null,
    browser_timezone: signals.timezone || null,
    dwell_ms: signals.dwell_ms || 0,
    interacted: !!signals.interacted,
  };

  let hardFail = false;

  // ── Check 1: Timezone comparison (the killer signal) ────────────────
  if (config.check_timezone !== false) {
    const match = timezonesMatch(click.timezone, signals.timezone);
    if (match === false) {
      flags.push('timezone_mismatch');
      detail.timezone_verdict = 'mismatch';
      hardFail = true; // cross-continent mismatch is a definitive bot signal
    } else if (match === null) {
      detail.timezone_verdict = 'unknown';
      // Missing data — don't penalize, but note it
      if (!signals.timezone) flags.push('no_browser_timezone');
    } else {
      detail.timezone_verdict = 'match';
    }
  }

  // ── Check 2: Interaction (mouse/touch/scroll) ───────────────────────
  if (config.check_interaction !== false) {
    if (!signals.interacted) {
      flags.push('no_interaction');
      // Not a hard fail on its own — some real users don't move before redirect.
      // But combined with other signals it pushes toward fail.
    }
  }

  // ── Check 3: Dwell time ─────────────────────────────────────────────
  if (config.check_dwell !== false) {
    const minDwell = config.min_dwell_ms || 2000;
    if ((signals.dwell_ms || 0) < minDwell * 0.5) {
      // Way too fast — the page barely rendered before submit
      flags.push('insufficient_dwell');
    }
  }

  // ── Check 4: Headless/automation heuristics ─────────────────────────
  // Missing screen data, zero hardware concurrency, or impossible dimensions
  if (signals.screen) {
    if (signals.screen.w === 0 || signals.screen.h === 0) {
      flags.push('zero_screen');
      hardFail = true; // headless browsers often report 0x0
    }
  } else {
    flags.push('no_screen_data');
  }

  if (signals.hardware_concurrency === 0) {
    flags.push('zero_cpu_cores');
  }

  // ── Check 5: WebGL (optional) ───────────────────────────────────────
  if (config.check_webgl === true) {
    if (!signals.webgl_vendor && !signals.webgl_renderer) {
      flags.push('no_webgl');
      // Many headless setups have no WebGL — moderate signal
    }
    // SwiftShader / llvmpipe = software rendering = likely headless
    const renderer = (signals.webgl_renderer || '').toLowerCase();
    if (renderer.includes('swiftshader') || renderer.includes('llvmpipe')) {
      flags.push('software_webgl');
      hardFail = true;
    }
  }

  // ── Verdict ─────────────────────────────────────────────────────────
  // Fail if: any hard-fail flag, OR 2+ soft flags accumulated
  const softFlags = flags.filter(f =>
    f === 'no_interaction' || f === 'insufficient_dwell' ||
    f === 'no_webgl' || f === 'no_screen_data' || f === 'zero_cpu_cores'
  );

  const pass = !hardFail && softFlags.length < 2;

  detail.hard_fail = hardFail;
  detail.soft_flag_count = softFlags.length;

  return { pass, flags, detail };
}

module.exports = { verifyGuard, timezonesMatch, normalizeTz };
