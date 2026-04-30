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
 *   - Reads click_id from the bg_click cookie (set by /go) - never trusts URL params
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

    // Read click_id from the bg_click cookie set by /go.
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

    // Once-per-session dedup
    if (getCookie(cfg.session_cookie)) return;

    // Build the matcher once. We use lowercase substring matching against the visible
    // text content of the clicked element (or up to 3 ancestors).
    var terms = cfg.terms;
    function matchTerm(text) {
      if (!text) return null;
      var lower = String(text).toLowerCase().trim();
      // Cap text length to avoid pathological matching on giant blocks
      if (lower.length > 200) lower = lower.slice(0, 200);
      for (var i = 0; i < terms.length; i++) {
        if (lower.indexOf(terms[i]) !== -1) return terms[i];
      }
      return null;
    }

    // Walk up looking for a button-like ancestor with matching text.
    // Stops at 3 levels because real buttons rarely nest deeper than that.
    function findMatch(target) {
      var node = target;
      for (var i = 0; i < 4 && node && node.nodeType === 1; i++) {
        // Limit to plausibly-clickable elements
        var tag = node.tagName.toLowerCase();
        var isClickable = (
          tag === 'button' || tag === 'a' ||
          (tag === 'input' && (node.type === 'submit' || node.type === 'button')) ||
          node.getAttribute('role') === 'button' ||
          node.onclick !== null
        );
        if (isClickable || i === 0) {
          var text = node.innerText || node.textContent || node.value || '';
          var matched = matchTerm(text);
          if (matched) {
            return {
              term: matched,
              text: text.replace(/\\s+/g, ' ').trim().slice(0, 100),
              tag: tag,
              id: node.id || '',
              cls: (node.className || '').toString().slice(0, 100),
            };
          }
        }
        node = node.parentNode;
      }
      return null;
    }

    function send(payload) {
      var url = cfg.endpoint;
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

    document.addEventListener('click', function(ev) {
      try {
        if (getCookie(cfg.session_cookie)) return;     // race-safe re-check
        var match = findMatch(ev.target);
        if (!match) return;

        var clickId = getCookie('bg_click');
        if (!clickId) return;       // no click_id - we have no attribution to record

        // Set dedup cookie immediately so any subsequent click (form re-submit, etc) is ignored
        setCookie(cfg.session_cookie, '1', cfg.session_days);

        send({
          click_id: clickId,
          event_name: cfg.event_name,
          term: match.term,
          text: match.text,
          element: match.tag + (match.id ? '#' + match.id : '') + (match.cls ? '.' + match.cls.split(' ')[0] : ''),
          page_url: location.href.slice(0, 500),
          ts: Date.now(),
        });
      } catch (e) {
        // never let a tracker break the page
      }
    }, true);  // capture phase - runs before any stopPropagation handlers
  } catch (e) {}
})();`;

module.exports = { buildInjection, DEFAULT_TERMS };
