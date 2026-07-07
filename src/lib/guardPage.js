/**
 * guardPage.js — Bot Guard interstitial page (Level 2).
 *
 * Served to visitors who passed Level 1 when the target offer page has
 * bot_guard enabled. Looks like a normal "preparing your content" loading
 * screen. Runs client-side checks silently, then POSTs results to
 * /go/guard-verify which decides: serve offer page or redirect to safe page.
 *
 * Checks performed (configurable per page):
 *   - timezone: browser Intl timezone vs ProxyCheck IP timezone
 *   - interaction: mouse/touch/scroll movement detected
 *   - dwell: minimum time on page before proceeding
 *   - webgl: canvas/WebGL fingerprint presence (optional)
 *
 * The page is deliberately minimal and generic — nothing signals to a bot
 * operator that they're being screened.
 */

'use strict';

/**
 * Build the guard interstitial HTML.
 *
 * @param {object} opts
 * @param {string} opts.token — signed guard token (identifies this click)
 * @param {string} opts.verifyUrl — endpoint to POST results to
 * @param {object} opts.config — bot_guard config from the landing page
 * @param {number} opts.minDwellMs — minimum dwell before verify
 * @returns {string} full HTML document
 */
function buildGuardPage({ token, verifyUrl = '/go/guard-verify', config = {}, minDwellMs = 2000 }) {
  const checks = {
    timezone: config.check_timezone !== false,
    interaction: config.check_interaction !== false,
    dwell: config.check_dwell !== false,
    webgl: config.check_webgl === true,
    minDwellMs: minDwellMs || 2000,
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Loading…</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { height:100%; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #f7f8fa;
    display: flex; align-items: center; justify-content: center;
    min-height: 100vh; color: #444;
  }
  .loader-wrap { text-align: center; }
  .spinner {
    width: 44px; height: 44px; margin: 0 auto 20px;
    border: 4px solid #e3e6ea; border-top-color: #3b82f6;
    border-radius: 50%; animation: spin 0.9s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .msg { font-size: 15px; color: #6b7280; }
  noscript { display:block; margin-top:16px; color:#9ca3af; font-size:13px; }
</style>
</head>
<body>
  <div class="loader-wrap">
    <div class="spinner"></div>
    <div class="msg">Preparing your content…</div>
    <noscript>JavaScript is required to continue.</noscript>
  </div>

<script>
(function () {
  "use strict";
  var TOKEN = ${JSON.stringify(token)};
  var VERIFY_URL = ${JSON.stringify(verifyUrl)};
  var CHECKS = ${JSON.stringify(checks)};
  var startTime = Date.now();

  // ── Interaction detection ──────────────────────────────────────────
  var interacted = false;
  var moveCount = 0;
  var scrolled = false;

  function onMove() { moveCount++; if (moveCount >= 2) interacted = true; }
  function onScroll() { scrolled = true; interacted = true; }
  function onTouch() { interacted = true; }
  function onKey() { interacted = true; }

  window.addEventListener("mousemove", onMove, { passive: true });
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("touchstart", onTouch, { passive: true });
  window.addEventListener("keydown", onKey, { passive: true });
  window.addEventListener("click", onTouch, { passive: true });

  // ── Collect signals ─────────────────────────────────────────────────
  function collectSignals() {
    var signals = {
      token: TOKEN,
      timezone: null,
      timezone_offset: null,
      interacted: interacted,
      move_count: moveCount,
      scrolled: scrolled,
      dwell_ms: Date.now() - startTime,
      screen: null,
      webgl_vendor: null,
      webgl_renderer: null,
      hardware_concurrency: null,
      touch_support: false,
      language: null,
      platform: null,
    };

    // Timezone (IANA format — matches ProxyCheck)
    try {
      signals.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      signals.timezone_offset = new Date().getTimezoneOffset();
    } catch (e) {}

    // Screen resolution
    try {
      signals.screen = {
        w: window.screen.width, h: window.screen.height,
        avail_w: window.screen.availWidth, avail_h: window.screen.availHeight,
        pixel_ratio: window.devicePixelRatio || 1,
        inner_w: window.innerWidth, inner_h: window.innerHeight,
      };
    } catch (e) {}

    // Hardware / platform
    try {
      signals.hardware_concurrency = navigator.hardwareConcurrency || null;
      signals.touch_support = ("ontouchstart" in window) || navigator.maxTouchPoints > 0;
      signals.language = navigator.language || null;
      signals.platform = navigator.platform || null;
    } catch (e) {}

    // WebGL fingerprint (optional)
    if (CHECKS.webgl) {
      try {
        var canvas = document.createElement("canvas");
        var gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
        if (gl) {
          var dbgInfo = gl.getExtension("WEBGL_debug_renderer_info");
          if (dbgInfo) {
            signals.webgl_vendor = gl.getParameter(dbgInfo.UNMASKED_VENDOR_WEBGL);
            signals.webgl_renderer = gl.getParameter(dbgInfo.UNMASKED_RENDERER_WEBGL);
          }
        }
      } catch (e) {}
    }

    return signals;
  }

  // ── Submit and redirect ─────────────────────────────────────────────
  function submit() {
    var signals = collectSignals();
    var xhr = new XMLHttpRequest();
    xhr.open("POST", VERIFY_URL, true);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.onreadystatechange = function () {
      if (xhr.readyState === 4) {
        var redirectUrl = null;
        try {
          var res = JSON.parse(xhr.responseText);
          redirectUrl = res.redirect;
        } catch (e) {}
        if (redirectUrl) {
          window.location.replace(redirectUrl);
        } else {
          // Fallback — reload to let server decide again
          window.location.reload();
        }
      }
    };
    xhr.send(JSON.stringify(signals));
  }

  // Wait for the minimum dwell time, then submit.
  // Real users spend time; headless bots that don't execute JS never reach here.
  var wait = Math.max(CHECKS.minDwellMs || 2000, 1200);
  setTimeout(submit, wait);
})();
</script>
</body>
</html>`;
}

module.exports = { buildGuardPage };
