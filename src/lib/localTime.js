/**
 * Format a Date (or anything `new Date()` accepts) as a `<time>` element
 * with an ISO datetime attribute. The browser-side script in
 * `public/js/local-time.js` finds these elements and rewrites their text
 * content to the visitor's local timezone.
 *
 * This lets every admin see timestamps in their own timezone regardless of
 * where the server runs (typically UTC on Coolify VPS). Without this, a
 * server in UTC would show "5/1/2026 5:38 AM" to an admin in IST whose
 * local time is actually 11:08 AM.
 *
 * Format options:
 *   'datetime' (default) — full date + time, e.g. "May 1, 2026, 11:08 AM"
 *   'date'               — date only, e.g. "May 1, 2026"
 *   'time'               — time only, e.g. "11:08 AM"
 *   'relative'           — "5m ago", "2h ago", "Just now"
 *
 * The fallback text (shown if JS is disabled) is the raw ISO string, which
 * is at least unambiguous to any technical user.
 *
 * Usage in EJS:
 *   <%- localTime(c.ts) %>
 *   <%- localTime(c.ts, 'date') %>
 *   <%- localTime(c.ts, 'relative') %>
 *
 * The function returns raw HTML so use <%- (unescaped) not <%=. The values
 * we interpolate are entirely server-controlled (an ISO timestamp string
 * from new Date().toISOString()) so there's no XSS risk.
 */

const VALID_FORMATS = new Set(['datetime', 'date', 'time', 'relative']);

function localTime(value, format = 'datetime') {
  if (!value) return '<span class="muted">–</span>';
  if (!VALID_FORMATS.has(format)) format = 'datetime';

  let d;
  try {
    d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return '<span class="muted">–</span>';
  } catch (e) {
    return '<span class="muted">–</span>';
  }

  const iso = d.toISOString();
  // Fallback text shown before the client script runs (or if JS is disabled).
  // We emit a compact ISO-ish form so admins can read it even without JS.
  // YYYY-MM-DD HH:MM UTC
  const fallback = iso.slice(0, 10) + ' ' + iso.slice(11, 16) + ' UTC';
  return `<time datetime="${iso}" data-format="${format}">${fallback}</time>`;
}

module.exports = { localTime };
