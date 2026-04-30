/**
 * BotGuard JS challenge.
 * Injected into every landing page. Collects a lightweight fingerprint and POSTs it
 * to /go/fp so the server can update the click record's behavior score.
 *
 * Self-contained, no dependencies, ~3KB minified.
 * Designed to be silent - never throws, never blocks page render.
 */
(function () {
  try {
    var cid = (function () {
      var m = document.cookie.match(/(?:^|; )bg_cid=([^;]+)/);
      return m ? decodeURIComponent(m[1]) : null;
    })();
    if (!cid) return;

    var fp = {
      tz: null, lang: null, platform: null, screen: null,
      canvas: null, webgl: null, webdriver: false,
      hasTouch: false, interaction: 'none',
    };

    // Easy stuff
    try { fp.tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) {}
    try { fp.lang = navigator.language || (navigator.languages && navigator.languages[0]); } catch (e) {}
    try { fp.platform = navigator.platform; } catch (e) {}
    try { fp.screen = (screen.width || 0) + 'x' + (screen.height || 0); } catch (e) {}
    try { fp.webdriver = navigator.webdriver === true; } catch (e) {}
    try { fp.hasTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0; } catch (e) {}

    // Canvas fingerprint
    try {
      var c = document.createElement('canvas');
      c.width = 200; c.height = 50;
      var ctx = c.getContext('2d');
      ctx.textBaseline = 'top';
      ctx.font = "14px 'Arial'";
      ctx.fillStyle = '#f60';
      ctx.fillRect(0, 0, 200, 50);
      ctx.fillStyle = '#069';
      ctx.fillText('BotGuard,fp_v1', 2, 15);
      ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
      ctx.fillText('BotGuard,fp_v1', 4, 17);
      var data = c.toDataURL();
      // Hash it down to 16 chars - we don't need the full data URL
      var h = 0;
      for (var i = 0; i < data.length; i++) {
        h = ((h << 5) - h + data.charCodeAt(i)) | 0;
      }
      fp.canvas = (h >>> 0).toString(16);
    } catch (e) {}

    // WebGL renderer
    try {
      var glc = document.createElement('canvas');
      var gl = glc.getContext('webgl') || glc.getContext('experimental-webgl');
      if (gl) {
        var dbg = gl.getExtension('WEBGL_debug_renderer_info');
        if (dbg) {
          fp.webgl = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '');
        } else {
          fp.webgl = String(gl.getParameter(gl.RENDERER) || '');
        }
      }
    } catch (e) {}

    // Interaction observation - watch for any mouse / touch / keyboard within 1.5s
    var onMove = function () { fp.interaction = 'mouse'; cleanup(); };
    var onTouch = function () { fp.interaction = 'touch'; cleanup(); };
    var onKey = function () { fp.interaction = 'key'; cleanup(); };
    function cleanup() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('touchstart', onTouch);
      window.removeEventListener('keydown', onKey);
    }
    window.addEventListener('mousemove', onMove, { passive: true });
    window.addEventListener('touchstart', onTouch, { passive: true });
    window.addEventListener('keydown', onKey, { passive: true });

    // Send the payload after a short observation window
    setTimeout(function () {
      cleanup();
      try {
        var payload = JSON.stringify({ cid: cid, fp: fp });
        if (navigator.sendBeacon) {
          var blob = new Blob([payload], { type: 'application/json' });
          navigator.sendBeacon('/go/fp', blob);
        } else {
          var xhr = new XMLHttpRequest();
          xhr.open('POST', '/go/fp', true);
          xhr.setRequestHeader('Content-Type', 'application/json');
          xhr.send(payload);
        }
      } catch (e) {}
    }, 1500);
  } catch (e) { /* silent */ }
})();
