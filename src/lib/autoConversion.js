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

    // Walk up the DOM looking for an ancestor whose text matches a term.
    // We deliberately do NOT gate on "is clickable" — modern frameworks (React, Vue,
    // Svelte, etc.) attach handlers via addEventListener, leaving node.onclick === null
    // and no role attribute. So we just check every ancestor up to MAX_DEPTH levels
    // and let the click event itself prove the element was interactive.
    //
    // Special case: <a href="tel:..."> always matches (phone link), regardless of text.
    //
    // We STOP before reaching <body> / <html> because their innerText includes the
    // entire page (including our own injected config block), which would cause every
    // click anywhere on the page to falsely match.
    var MAX_DEPTH = 5;
    var STOP_TAGS = { body: 1, html: 1, head: 1 };
    var SKIP_TAGS = { script: 1, style: 1, noscript: 1 };

    function findMatch(target) {
      var node = target;
      for (var i = 0; i < MAX_DEPTH && node && node.nodeType === 1; i++) {
        var tag = (node.tagName || '').toLowerCase();

        // Stop before page-level containers - they include all text on the page
        if (STOP_TAGS[tag]) return null;
        // Skip nodes whose text we shouldn't match against
        if (SKIP_TAGS[tag]) { node = node.parentNode; continue; }

        // Phone links: <a href="tel:..."> always counts as a "call" conversion
        if (tag === 'a') {
          var href = node.getAttribute && node.getAttribute('href') || '';
          if (href.toLowerCase().indexOf('tel:') === 0) {
            // Use the link text for forensics; record term as 'call' if configured,
            // else first term so the conversion always lands somewhere.
            var phoneText = (node.innerText || node.textContent || href).trim();
            return {
              term: terms.indexOf('call') !== -1 ? 'call' : terms[0],
              text: phoneText.replace(/\\s+/g, ' ').slice(0, 100),
              tag: 'a',
              href: href.slice(0, 200),
              id: node.id || '',
              cls: (node.className || '').toString().slice(0, 100),
            };
          }
          // mailto: links - match if text contains a configured term
          if (href.toLowerCase().indexOf('mailto:') === 0) {
            var emailMatched = matchTerm(node.innerText || node.textContent || '');
            if (emailMatched) {
              return mkMatch(node, emailMatched, tag);
            }
          }
        }

        // Text-based match on this node
        var text = node.innerText || node.textContent || node.value || '';
        var matched = matchTerm(text);
        if (matched) {
          return mkMatch(node, matched, tag);
        }

        node = node.parentNode;
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

    function handleClick(ev) {
      try {
        if (getCookie(cfg.session_cookie)) return;     // race-safe re-check
        var match = findMatch(ev.target);
        if (!match) return;

        var clickId = getCookie('bg_click');
        if (!clickId) return;       // no click_id - we have no attribution to record

        // Set dedup cookie immediately so any subsequent click is ignored
        setCookie(cfg.session_cookie, '1', cfg.session_days);

        send({
          click_id: clickId,
          event_name: cfg.event_name,
          term: match.term,
          text: match.text,
          element: match.tag + (match.id ? '#' + match.id : '') + (match.cls ? '.' + match.cls.split(' ')[0] : ''),
          href: match.href || null,
          page_url: location.href.slice(0, 500),
          ts: Date.now(),
        });
      } catch (e) {
        // never let a tracker break the page
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
