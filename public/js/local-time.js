/**
 * Local time renderer for BotGuard admin pages.
 *
 * Every server-rendered timestamp in the admin UI is emitted as:
 *   <time datetime="2026-05-01T05:38:57.000Z" data-format="datetime">2026-05-01 05:38 UTC</time>
 *
 * The fallback text (visible during initial paint or if JS is disabled) is in
 * UTC. This script replaces it with the visitor's local-timezone, locale-aware
 * formatted version. Without this, an admin in IST would see the server's UTC
 * timestamps and have to mentally add 5h30m to every value.
 *
 * Why client-side rather than server-side:
 *   - The server has one timezone (UTC on Coolify). The browser knows the
 *     visitor's actual timezone. Letting the browser format means the same
 *     server can show correct local times to admins anywhere.
 *   - Locale-aware: a US admin sees "5/1/2026" while a UK admin sees "01/05/2026"
 *     for the same instant - browser uses navigator.languages.
 *   - Auto-updates: relative formats ("5m ago") refresh on a timer.
 *
 * Why a global script rather than per-page:
 *   - One file, one cache entry, applied uniformly across all admin pages.
 *   - Re-runs on dynamic content too (live dashboard inserts cards via JS;
 *     we expose window.formatLocalTimes() for it to call after insertion).
 */

(function () {
  'use strict';

  // Caches Intl formatters - constructing them is expensive, the same one
  // gets called on dozens of cells per page render.
  var formatters = {};

  function getDateFormatter() {
    if (formatters.date) return formatters.date;
    formatters.date = new Intl.DateTimeFormat(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
    });
    return formatters.date;
  }

  function getTimeFormatter() {
    if (formatters.time) return formatters.time;
    formatters.time = new Intl.DateTimeFormat(undefined, {
      hour: 'numeric', minute: '2-digit',
    });
    return formatters.time;
  }

  function getDateTimeFormatter() {
    if (formatters.datetime) return formatters.datetime;
    formatters.datetime = new Intl.DateTimeFormat(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
    return formatters.datetime;
  }

  /**
   * Format milliseconds-difference as a relative phrase: "Just now", "5m ago",
   * "3h ago", "2d ago", or fall back to absolute date for >=7d.
   */
  function formatRelative(d) {
    var diff = Date.now() - d.getTime();
    if (diff < 0) {
      // Future timestamp - rare but possible (clock skew). Show absolute.
      return getDateTimeFormatter().format(d);
    }
    var sec = Math.floor(diff / 1000);
    if (sec < 30) return 'Just now';
    if (sec < 60) return sec + 's ago';
    var min = Math.floor(sec / 60);
    if (min < 60) return min + 'm ago';
    var hr = Math.floor(min / 60);
    if (hr < 24) return hr + 'h ago';
    var day = Math.floor(hr / 24);
    if (day < 7) return day + 'd ago';
    return getDateTimeFormatter().format(d);
  }

  function formatTime(el) {
    var iso = el.getAttribute('datetime');
    if (!iso) return;
    var d = new Date(iso);
    if (isNaN(d.getTime())) return;

    var format = el.getAttribute('data-format') || 'datetime';
    var formatted;
    switch (format) {
      case 'date':     formatted = getDateFormatter().format(d); break;
      case 'time':     formatted = getTimeFormatter().format(d); break;
      case 'relative': formatted = formatRelative(d); break;
      case 'datetime':
      default:         formatted = getDateTimeFormatter().format(d); break;
    }
    el.textContent = formatted;

    // Tooltip: full ISO + locale-formatted absolute. Useful when displaying
    // relative times — admins can hover to see the exact instant.
    if (!el.hasAttribute('title')) {
      el.setAttribute('title', d.toLocaleString() + '  (' + iso + ')');
    }
  }

  /**
   * Process all <time data-format> elements currently in the DOM. Exposed
   * globally so dynamic UIs (the live dashboard, infinite-scroll lists) can
   * call it after inserting new content.
   */
  window.formatLocalTimes = function () {
    var nodes = document.querySelectorAll('time[data-format]');
    for (var i = 0; i < nodes.length; i++) {
      formatTime(nodes[i]);
    }
  };

  /**
   * Refresh relative timestamps on a 60s tick so "5m ago" doesn't grow stale
   * while the admin keeps the page open. Absolute formats are stable; we
   * only re-process those marked data-format="relative".
   */
  function tickRelative() {
    var nodes = document.querySelectorAll('time[data-format="relative"]');
    for (var i = 0; i < nodes.length; i++) {
      formatTime(nodes[i]);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', window.formatLocalTimes);
  } else {
    window.formatLocalTimes();
  }
  setInterval(tickRelative, 60 * 1000);
})();
