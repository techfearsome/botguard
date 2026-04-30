/**
 * Third-party analytics injection.
 *
 * Builds <script> tags for tracking services configured at the workspace level.
 * Currently supports:
 *   - Microsoft Clarity (session replay + heatmaps)
 *
 * Injected into all offer AND safe pages so the client gets recordings of
 * both successful conversions and blocked traffic. Blocked traffic recordings
 * are particularly useful for debugging false positives in the filter chain.
 */

/**
 * Validate a Clarity project ID. Clarity uses short alphanumeric strings,
 * typically 10 characters, e.g. "wjsr5hjt53". We allow [a-z0-9-] up to 32 chars
 * to be safe against future format changes, while preventing arbitrary JS injection.
 */
function isValidClarityId(id) {
  return typeof id === 'string' && /^[a-z0-9-]{1,32}$/i.test(id);
}

/**
 * Build the script tags to inject. Order matters:
 *   1. Clarity loads first so it captures everything that follows
 *   2. Other trackers (FB Pixel, GA4, etc.) would go here in the future
 *
 * @param {object} opts
 * @param {string} opts.clarityProjectId - Microsoft Clarity project ID
 * @returns {string} HTML to inject (may be empty string)
 */
function buildTrackingInjection({ clarityProjectId } = {}) {
  const tags = [];

  if (clarityProjectId && isValidClarityId(clarityProjectId)) {
    // Standard Clarity snippet from https://clarity.microsoft.com/
    // The project ID is interpolated as a JS string literal, with the validator
    // above guaranteeing it's safe ([a-z0-9-]). No HTML escape needed inside JS.
    tags.push(`<script type="text/javascript">
(function(c,l,a,r,i,t,y){
c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
})(window, document, "clarity", "script", "${clarityProjectId}");
</script>`);
  }

  return tags.join('\n');
}

module.exports = { buildTrackingInjection, isValidClarityId };
