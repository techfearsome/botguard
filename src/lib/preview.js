/**
 * Preview rendering for admin "view this page as a visitor would" without
 * triggering any of the side effects of a real visit.
 *
 * What real /go visits do that previews must NOT:
 *   - Write a Click row to Mongo
 *   - Set bg_cid cookie
 *   - Run the filter chain (gates, scoring, ProxyCheck)
 *   - Inject heartbeat (would show admin in /admin/live)
 *   - Inject Clarity (would record admin testing as session replay)
 *   - Inject auto-conversion JS (would generate fake auto_click conversions)
 *   - Inject challenge JS (asks for a fingerprint that we'd ignore anyway)
 *
 * What previews STILL do:
 *   - Substitute {{click_id}}, {{utm_source}}, etc. with placeholder values
 *     so the rendered HTML is structurally identical to what visitors see
 *   - Inject the WordPress fingerprint meta tags (so admins can verify the
 *     fingerprint is working without proxy/network sniffing)
 *   - Pick a variant if multiple are configured (uses the same logic as live
 *     traffic, but the random selection is fine since previews are one-off)
 *
 * Result: a string of HTML safe to send as the body of an admin preview
 * response. Caller controls headers (typically: text/html, no-store).
 */

const { injectWpMeta } = require('./wpFingerprint');

// Distinctive placeholder values so admins know "this is preview state".
// click_id intentionally readable: "preview-..." rather than a real-looking
// random string, so an admin who accidentally posts a screenshot of a preview
// page doesn't expose a click ID that looks like a real visitor's.
const PREVIEW_PLACEHOLDERS = {
  click_id:     'preview-click-id',
  utm_source:   'preview',
  utm_medium:   'preview',
  utm_campaign: 'preview',
};

/**
 * Substitute the four {{placeholder}} forms with admin-preview-friendly
 * values. Centralized here so /go and preview share the same logic and we
 * can't drift (e.g., adding a fifth placeholder in /go but not preview).
 */
function substitutePlaceholders(html, values = PREVIEW_PLACEHOLDERS) {
  if (!html) return html;
  return html
    .replace(/\{\{click_id\}\}/g, values.click_id ?? '')
    .replace(/\{\{utm_source\}\}/g, values.utm_source ?? '')
    .replace(/\{\{utm_medium\}\}/g, values.utm_medium ?? '')
    .replace(/\{\{utm_campaign\}\}/g, values.utm_campaign ?? '');
}

/**
 * Pick the HTML body to render from a LandingPage or SitePage document.
 *   - If a `variants` array exists and is non-empty, choose the highest-
 *     weight variant. (For preview we don't need traffic-split randomness;
 *     deterministic max-weight is more useful for "show me what I designed".)
 *   - Otherwise fall back to html_template (LandingPage) or html (SitePage).
 */
function pickPreviewBody(page) {
  if (!page) return '';
  // SitePage shape
  if (typeof page.html === 'string' && page.html) return page.html;
  // LandingPage shape with variants
  if (Array.isArray(page.variants) && page.variants.length > 0) {
    const sorted = [...page.variants].sort((a, b) => (b.weight || 0) - (a.weight || 0));
    return sorted[0].html || page.html_template || '';
  }
  // LandingPage shape, no variants
  return page.html_template || '';
}

/**
 * Build the preview HTML for a LandingPage or SitePage document.
 *
 * @param {object} page - LandingPage or SitePage document
 * @param {object} [opts]
 * @param {object} [opts.placeholders] - override placeholder values (used by
 *   admins who want to test specific UTM combinations via query string)
 * @param {boolean} [opts.skipWpFingerprint] - skip the WP meta injection.
 *   Default false. Set true only if you specifically want to see the raw
 *   page without our fingerprint additions.
 * @returns {string} HTML body
 */
function renderPreview(page, opts = {}) {
  const { placeholders = PREVIEW_PLACEHOLDERS, skipWpFingerprint = false } = opts;

  let html = pickPreviewBody(page);
  if (!html) return '<!DOCTYPE html><html><body><p>This page has no HTML configured yet.</p></body></html>';

  html = substitutePlaceholders(html, placeholders);
  if (!skipWpFingerprint) html = injectWpMeta(html);

  return html;
}

/**
 * Set HTTP headers appropriate for a preview response.
 *
 * - text/html, no-store (don't cache previews; they change as admins edit)
 * - X-Robots-Tag noindex (admin URLs should never be indexed even if leaked)
 * - DOES NOT set X-Pingback (preview pages aren't real WP frontend pages;
 *   the WP fingerprint is in the BODY for testing purposes only)
 */
function setPreviewHeaders(res) {
  res.set('Cache-Control', 'private, no-store, no-cache, must-revalidate, max-age=0');
  res.set('CDN-Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
  // Keep the response form-shaped to the visitor view: X-Frame-Options
  // SAMEORIGIN is more permissive than DENY so the preview can be embedded
  // back into the admin via iframe in a future enhancement, but not by
  // external sites.
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.type('html');
}

module.exports = {
  renderPreview,
  pickPreviewBody,
  substitutePlaceholders,
  setPreviewHeaders,
  PREVIEW_PLACEHOLDERS,
};
