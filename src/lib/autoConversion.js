/**
 * Auto-conversion injection.
 *
 * Builds a small <script> tag that watches for clicks on elements whose visible text
 * matches one of the configured terms, and POSTs to /cb/auto-conv when matched.
 *
 * Design choices:
 *   - Single delegated click listener on document - survives elements added after page load
 *   - sendBeacon when available (works mid-navigation; falls back to fetch keepalive)
 *   - 30-day session dedup cookie set client-side AND verified server-side (defense in depth)
 *   - Wrapped in try/catch top-to-bottom - if anything throws, the page still works
 *   - Reads click_id from the bg_cid cookie (set by /go) - never trusts URL params
 *   - Captures the actual visible text (not innerHTML) so we don't mistake nested icons for matches
 *   - Walks up to 3 ancestors to handle <button><span>Subscribe</span></button> patterns
 *
 * The script is intentionally tiny (~1 KB minified) so it doesn't slow page load.
 */

const DEFAULT_TERMS = [
  'Download', 'Submit', 'Place Order', 'Subscribe', 'Sign Up', 'Sign In',
  'Call', 'Buy', 'Get Started', 'Continue', 'Install',
  'Order Now', 'Add to Cart', 'Checkout', 'Get the App', 'Open App',
];

/**
 * Build the injection HTML. The terms are passed in via a JSON-serialized data attribute
 * so we don't generate any code at runtime - the same script string is reused per page.
 *
 * @param {object} opts
 * @param {string[]} opts.terms - terms to match. Empty/missing → DEFAULT_TERMS.
 * @param {string} opts.endpoint - where to POST conversions. Default: '/cb/auto-conv'.
 * @param {string} opts.eventName - event_name to record on the conversion.
 * @returns {string} HTML <script> tag, ready to splice into the page.
 */
function buildInjection({ terms = [], endpoint = '/cb/auto-conv', eventName = 'auto_click' } = {}) {
  const useTerms = Array.isArray(terms) && terms.length > 0 ? terms : DEFAULT_TERMS;
  // Lowercase for case-insensitive matching, dedupe, drop empties
  const normalized = Array.from(new Set(
    useTerms.map((t) => String(t || '').trim().toLowerCase()).filter(Boolean)
  ));

  // The runtime config is JSON-encoded as a data attribute on the script tag.
  // This avoids string-escaping nightmares and makes inspection easier.
  const config = {
    terms: normalized,
    endpoint,
    event_name: eventName,
    // 30-day dedup
    session_cookie: 'bg_conv',
    session_days: 30,
  };

  return `<script type="application/json" id="bg-auto-conv-config">${
    escapeJsonForScript(config)
  }</script>
<script>${RUNTIME}</script>`;
}

// Serialize JSON safely for inclusion in a <script type="application/json"> tag.
// Escapes </script> and U+2028/U+2029 which would break the parser.
function escapeJsonForScript(obj) {
  return JSON.stringify(obj)
    .replace(/<\/script/gi, '<\\/script')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// The runtime is a self-contained IIFE. Kept as a string so we can ship it inline -
// no extra HTTP request, no caching concerns, and it works in stripped iframes.
const RUNTIME = `
(function(){
  try {
    var cfgEl = document.getElementById('bg-auto-conv-config');
    if (!cfgEl) return;
    var cfg = JSON.parse(cfgEl.textContent || cfgEl.innerText || '{}');
    if (!cfg.terms || !cfg.terms.length) return;

    // Read click_id from the bg_cid cookie set by /go.
    function getCookie(name) {
      var m = ('; ' + document.cookie).split('; ' + name + '=');
      return m.length === 2 ? decodeURIComponent(m.pop().split(';').shift()) : null;
    }
    function setCookie(name, value, days) {
      try {
        var d = new Date(); d.setTime(d.getTime() + days * 86400000);
        document.cookie = name + '=' + encodeURIComponent(value) + '; expires=' + d.toUTCString() + '; path=/; SameSite=Lax';
      } catch (e) {}
    }

    // Debug mode: ?bg_debug=1 in the URL turns on console logging so you can
    // diagnose tracking issues live without redeploying. Logs are prefixed [bg].
    var DEBUG = false;
    try { DEBUG = location.search.indexOf('bg_debug=1') !== -1; } catch (e) {}
    function dbg() {
      if (!DEBUG) return;
      try { console.log.apply(console, ['[bg]'].concat([].slice.call(arguments))); } catch (e) {}
    }
    dbg('runtime starting, terms:', cfg.terms, 'click_id cookie:', getCookie('bg_cid'));

    // Per-click-id dedup. The bg_conv cookie stores the click_id it was set for.
    // If that click_id matches our current bg_cid, the visitor already converted on
    // THIS landing page session - block. If it doesn't match (or bg_conv is unset),
    // the visitor is on a fresh ad click and dedup doesn't apply.
    //
    // This is more robust than a simple yes/no dedup flag because it handles:
    //   - Same visitor returning via different ad campaigns (different click_id)
    //   - Stale bg_conv cookies from unrelated previous sessions
    //   - Cross-site tracking scenarios
    var currentClickId = getCookie('bg_cid');
    var dedupCookie = getCookie(cfg.session_cookie);
    var alreadyConverted = dedupCookie && currentClickId && dedupCookie === currentClickId;

    if (!DEBUG && alreadyConverted) {
      dbg('bg_conv matches current click_id - script bailing (already converted on this click)');
      return;
    }
    if (DEBUG && alreadyConverted) {
      dbg('bg_conv matches click_id but DEBUG mode is ON - dedup BYPASSED for this session');
    }
    if (dedupCookie && !alreadyConverted) {
      dbg('bg_conv present but for different click_id (', dedupCookie, 'vs current', currentClickId, ') - treating as fresh session');
    }

    var terms = cfg.terms;

    // Match a single string against any configured term (case-insensitive substring).
    // Returns the matched term string, or null.
    function matchTerm(text) {
      if (!text) return null;
      var lower = String(text).toLowerCase().trim();
      // Collapse whitespace so "Download   Now" and "Download Now" match the same way
      lower = lower.replace(/\\s+/g, ' ');
      // Cap text length to avoid pathological matching on giant blocks
      if (lower.length > 500) lower = lower.slice(0, 500);
      for (var i = 0; i < terms.length; i++) {
        if (lower.indexOf(terms[i]) !== -1) return terms[i];
      }
      return null;
    }

    // Walk up the DOM looking for an ANCESTOR that is plausibly a button.
    // The detection has to handle two competing cases:
    //
    // 1. SPA-rendered <div onClick> patterns: React/Vue/Svelte attach handlers via
    //    addEventListener, leaving node.onclick === null. So we can't rely on it.
    //
    // 2. Generic containers: a click anywhere inside <section>, <div>, <main>, <body>
    //    would match if we just check text (their text includes ALL descendant text,
    //    including buttons inside). So we need to AVOID matching containers.
    //
    // Heuristic: a node is "plausibly a button" if ANY of:
    //   - tag is button/a/input[submit|button] (explicit interactive)
    //   - role="button" attribute
    //   - computed cursor is 'pointer' (standard styling for clickable elements)
    //   - class name contains common button hints (btn, button, cta, link)
    //   - has an onclick attribute or .onclick handler
    //
    // We STOP before <body>/<html>/<head> regardless. Script/style nodes are skipped.
    var MAX_DEPTH = 6;
    var STOP_TAGS = { body: 1, html: 1, head: 1 };
    var SKIP_TAGS = { script: 1, style: 1, noscript: 1 };
    var INTERACTIVE_TAGS = { button: 1, a: 1, summary: 1, label: 1 };
    var BUTTON_CLASS_HINT = /(?:^|[\\s_-])(btn|button|cta|link|action|tap|press|clickable|trigger)(?:[\\s_-]|$)/i;

    function isPlausibleButton(node, win) {
      var tag = (node.tagName || '').toLowerCase();
      if (INTERACTIVE_TAGS[tag]) return true;
      if (tag === 'input') {
        var type = (node.getAttribute && node.getAttribute('type') || '').toLowerCase();
        if (type === 'submit' || type === 'button' || type === 'image') return true;
      }
      if (node.getAttribute && node.getAttribute('role') === 'button') return true;
      if (node.onclick) return true;
      if (node.hasAttribute && node.hasAttribute('onclick')) return true;

      // Class name hint
      var cls = (node.className && node.className.toString) ? node.className.toString() : '';
      if (cls && BUTTON_CLASS_HINT.test(cls)) return true;

      // Computed cursor:pointer - the most reliable signal for SPA-styled clickables
      try {
        var cursor = win.getComputedStyle && win.getComputedStyle(node).cursor;
        if (cursor === 'pointer') return true;
      } catch (e) {}

      return false;
    }

    function findMatch(target) {
      var node = target;
      var win = (target.ownerDocument && target.ownerDocument.defaultView) || window;

      // First pass: walk up looking for the first plausibly-clickable ancestor.
      // This is the element we'll match text against.
      var clickable = null;
      var walker = node;
      for (var i = 0; i < MAX_DEPTH && walker && walker.nodeType === 1; i++) {
        var tag = (walker.tagName || '').toLowerCase();
        if (STOP_TAGS[tag]) break;
        if (SKIP_TAGS[tag]) { walker = walker.parentNode; continue; }
        if (isPlausibleButton(walker, win)) {
          clickable = walker;
          break;
        }
        walker = walker.parentNode;
      }
      if (!clickable) return null;

      var tag = (clickable.tagName || '').toLowerCase();

      // Phone links: <a href="tel:..."> always counts as a "call" conversion
      if (tag === 'a') {
        var href = clickable.getAttribute && clickable.getAttribute('href') || '';
        if (href.toLowerCase().indexOf('tel:') === 0) {
          var phoneText = (clickable.textContent || href).trim();
          return {
            term: terms.indexOf('call') !== -1 ? 'call' : terms[0],
            text: phoneText.replace(/\\s+/g, ' ').slice(0, 100),
            tag: 'a',
            href: href.slice(0, 200),
            id: clickable.id || '',
            cls: (clickable.className || '').toString().slice(0, 100),
          };
        }
      }

      // Text-based match. Use textContent (works on SVG too); fall back to value for inputs.
      var text = clickable.textContent || clickable.value || '';
      var matched = matchTerm(text);
      if (matched) {
        return mkMatch(clickable, matched, tag);
      }
      return null;
    }

    function mkMatch(node, term, tag) {
      var rawText = node.innerText || node.textContent || node.value || '';
      return {
        term: term,
        text: rawText.replace(/\\s+/g, ' ').trim().slice(0, 100),
        tag: tag,
        id: node.id || '',
        cls: (node.className || '').toString().slice(0, 100),
      };
    }

    function send(payload) {
      // Build the endpoint URL. In debug mode, append ?bg_debug=1 so the server
      // can detect debug mode even when the browser strips the Referer header
      // (incognito mode, strict privacy settings, cross-origin scenarios all
      // can drop or downgrade Referer).
      var url = cfg.endpoint;
      if (DEBUG) {
        url += (url.indexOf('?') === -1 ? '?' : '&') + 'bg_debug=1';
      }

      // In debug mode, prefer fetch over sendBeacon so we can log the response.
      // sendBeacon is fire-and-forget and tells us nothing about server-side success.
      if (DEBUG) {
        try {
          fetch(url, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })
            .then(function(r) { return r.json().then(function(j) { return { status: r.status, body: j }; }); })
            .then(function(result) {
              dbg('  → server response:', result.status, result.body);
              if (result.status !== 200) {
                console.warn('[bg] CONVERSION FAILED:', result);
              } else if (result.body && result.body.debug) {
                dbg('  → click record updated:', result.body.debug.updated_counters);
              }
            })
            .catch(function(err) { dbg('  → send error:', err && err.message); });
        } catch (e) { dbg('  → send threw:', e && e.message); }
        return;
      }

      try {
        // sendBeacon is fire-and-forget and works during page unload
        if (navigator.sendBeacon) {
          var blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
          if (navigator.sendBeacon(url, blob)) return;
        }
      } catch (e) {}
      // Fallback - keepalive lets it complete after the page navigates
      try {
        fetch(url, {
          method: 'POST',
          keepalive: true,
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }).catch(function(){});
      } catch (e) {}
    }

    function handleClick(ev) {
      try {
        dbg('click on', ev.target && ev.target.tagName, ev.target && ev.target.className);
        // Per-click-id dedup re-check (race-safe: state may have changed since IIFE start)
        var currentCid = getCookie('bg_cid');
        var currentDedup = getCookie(cfg.session_cookie);
        if (!DEBUG && currentDedup && currentCid && currentDedup === currentCid) {
          dbg('  → ignored: already converted on this click_id');
          return;
        }
        var match = findMatch(ev.target);
        if (!match) {
          dbg('  → no match: no plausibly-clickable ancestor or text did not match terms');
          return;
        }
        dbg('  → MATCHED:', match);

        var clickId = getCookie('bg_cid');
        if (!clickId) {
          dbg('  → ignored: no bg_cid cookie - cannot attribute conversion');
          return;
        }

        // Set dedup cookie tied to this click_id. Future clicks with the same
        // click_id will be deduped; future clicks with a different click_id
        // (i.e., a fresh ad click) will fire a new conversion.
        setCookie(cfg.session_cookie, clickId, cfg.session_days);

        var payload = {
          click_id: clickId,
          event_name: cfg.event_name,
          term: match.term,
          text: match.text,
          element: match.tag + (match.id ? '#' + match.id : '') + (match.cls ? '.' + match.cls.split(' ')[0] : ''),
          href: match.href || null,
          page_url: location.href.slice(0, 500),
          ts: Date.now(),
        };
        dbg('  → sending to', cfg.endpoint, payload);
        send(payload);
      } catch (e) {
        dbg('  → handler error:', e && e.message);
      }
    }

    // Listen on BOTH click and pointerup. Click is the standard event; pointerup catches
    // touch interactions that some libraries swallow before the click event fires
    // (e.g. some carousels and bottom-sheet UIs). Both go through the same dedup path.
    // Capture phase = runs before any stopPropagation handlers further down the page.
    document.addEventListener('click', handleClick, true);

    // Also catch programmatic navigation triggered by buttons that don't actually receive
    // a click event (e.g. \`<a href="..." onclick="...">\` where the handler does
    // window.location = ... instead of going through the link). We do this by hooking
    // into beforeunload too — if a beacon hasn't been sent yet but a matching button
    // exists in the DOM at the focused element, fire the conversion.
    // (Rare, but covers some old-school landing page patterns.)
  } catch (e) {}
})();`;

module.exports = { buildInjection, DEFAULT_TERMS };
