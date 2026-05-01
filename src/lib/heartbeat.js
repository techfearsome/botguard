/**
 * Live heartbeat injection.
 *
 * Builds a tiny <script> that pings /lv/heartbeat every 10s while the visitor
 * is on the page, and /lv/leave when they navigate away. This lets the admin
 * dashboard show who's currently active.
 *
 * Design notes:
 *   - Only fires when a bg_cid cookie is present (no orphan heartbeats)
 *   - Pauses when tab is hidden (visibilitychange) - saves battery on mobile
 *   - Uses sendBeacon for the unload event so it actually reaches the server
 *     (fetch() is killed mid-flight when the page unloads)
 *   - All wrapped in try/catch - tracker must NEVER break the page
 *   - Tiny: ~700 bytes minified
 */

const HEARTBEAT_INTERVAL_MS = 10 * 1000;     // every 10s while visible

function buildHeartbeatInjection() {
  return `<script>${HEARTBEAT_RUNTIME}</script>`;
}

const HEARTBEAT_RUNTIME = `
(function(){
  try {
    function getCookie(name) {
      var m = ('; ' + document.cookie).split('; ' + name + '=');
      return m.length === 2 ? decodeURIComponent(m.pop().split(';').shift()) : null;
    }
    var clickId = getCookie('bg_cid');
    if (!clickId) return;          // no attribution, no point heartbeating

    var HEARTBEAT_URL = '/lv/heartbeat';
    var LEAVE_URL = '/lv/leave';
    var INTERVAL = ${HEARTBEAT_INTERVAL_MS};
    var timer = null;

    function ping(url) {
      var body = JSON.stringify({ click_id: clickId });
      try {
        if (navigator.sendBeacon) {
          var blob = new Blob([body], { type: 'application/json' });
          if (navigator.sendBeacon(url, blob)) return;
        }
      } catch (e) {}
      try {
        fetch(url, {
          method: 'POST',
          keepalive: true,
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: body,
        }).catch(function(){});
      } catch (e) {}
    }

    function start() {
      if (timer) return;
      ping(HEARTBEAT_URL);
      timer = setInterval(function() { ping(HEARTBEAT_URL); }, INTERVAL);
    }
    function stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    }

    // Pause when tab is hidden, resume when visible (saves battery on mobile)
    document.addEventListener('visibilitychange', function() {
      if (document.visibilityState === 'visible') start();
      else stop();
    });

    // Send "left" beacon on page unload
    window.addEventListener('pagehide', function() {
      stop();
      ping(LEAVE_URL);
    });
    // Fallback for older browsers that don't fire pagehide reliably
    window.addEventListener('beforeunload', function() {
      stop();
      ping(LEAVE_URL);
    });

    // Start immediately
    start();
  } catch (e) {}
})();`;

module.exports = { buildHeartbeatInjection, HEARTBEAT_INTERVAL_MS };
