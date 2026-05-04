/**
 * Reserved root paths.
 *
 * Campaigns can be reached at custom root paths like /promo or /black-friday
 * in addition to the default /go/<slug>. To prevent campaigns from shadowing
 * system routes (admin, healthz, etc.) we keep this central allow/deny list.
 *
 * Categories:
 *   - "live" routes that exist today and are mounted in server.js
 *   - "future" reserved names we want to claim now so v2/v3 features don't
 *     silently break campaigns assigned those slugs
 *   - "obvious" bad picks (homepage, robots.txt, favicon)
 *
 * IMPORTANT: When you add a new top-level route to server.js, add its
 * first segment here so a malicious or misinformed admin can't create a
 * campaign at that path.
 */

// Currently mounted in server.js
const LIVE_PATHS = [
  'admin',           // /admin/* - admin UI
  'cb',              // /cb/* - postbacks, auto-conv
  'go',              // /go/* - default campaign route
  'healthz',         // /healthz - container healthcheck
  'lv',              // /lv/* - heartbeat, leave
  'p',               // /p/* - custom site pages
  'privacy',         // /privacy - site page
  'px',              // /px/* - tracking pixel
  'static',          // /static/* - public assets
  'terms',           // /terms - site page
];

// Reserved for future expansion - not used today, but admins must not be
// allowed to claim these as campaign paths because we may add system routes
// here in subsequent releases.
const RESERVED_FOR_FUTURE = [
  'api',             // future REST API
  'app',             // future SPA shell
  'auth',            // future SSO
  'capi',            // future FB CAPI / Google forwarding endpoint
  'config',
  'dashboard',
  'docs',
  'health',          // alias for healthz
  'login',
  'logout',
  'public',
  'register',
  'settings',
  'signup',
  'sso',
  'webhook',
  'webhooks',
  'ws',              // websocket
  'www',
];

// Common file requests that hit the root - we want these to 404 cleanly,
// not be hijacked as campaign slugs.
const COMMON_FILES = [
  'favicon.ico',
  'robots.txt',
  'sitemap.xml',
  'sitemap',
  'humans.txt',
  '.well-known',
  'manifest.json',
  'service-worker.js',
  'sw.js',
  'apple-touch-icon.png',
  'apple-touch-icon',
];

const RESERVED_PATHS = new Set([
  ...LIVE_PATHS,
  ...RESERVED_FOR_FUTURE,
  ...COMMON_FILES,
].map((s) => s.toLowerCase()));

/**
 * Validate a candidate root path slug.
 *
 * Rules:
 *   - 2-64 chars
 *   - starts with [a-z0-9]
 *   - contains only [a-z0-9_-] (lowercase letters, digits, hyphens, underscores)
 *   - is not in the reserved set (case-insensitive)
 *   - is a single segment (no slashes)
 *
 * Returns { valid: boolean, error: string | null, normalized: string | null }
 *
 * The "normalized" return is the slug stripped of leading/trailing slashes
 * and lowercased so what's stored is canonical.
 */
function validateRootPath(input) {
  if (input === null || input === undefined || input === '') {
    // Empty is allowed - means "no custom path, only /go/<slug> works"
    return { valid: true, error: null, normalized: '' };
  }
  if (typeof input !== 'string') {
    return { valid: false, error: 'root_path must be a string', normalized: null };
  }

  // Strip a single leading slash if the user pasted "/promo" by mistake.
  // Anything more aggressive (multiple slashes, query params) is rejected.
  let s = input.trim();
  if (s.startsWith('/')) s = s.slice(1);
  s = s.toLowerCase();

  if (s.length === 0) {
    return { valid: true, error: null, normalized: '' };
  }
  if (s.length < 2) {
    return { valid: false, error: 'Path must be at least 2 characters', normalized: null };
  }
  if (s.length > 64) {
    return { valid: false, error: 'Path must be 64 characters or fewer', normalized: null };
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(s)) {
    return {
      valid: false,
      error: 'Path may only contain lowercase letters, digits, hyphens, and underscores, and must start with a letter or digit',
      normalized: null,
    };
  }
  if (RESERVED_PATHS.has(s)) {
    return {
      valid: false,
      error: `"${s}" is a reserved path and cannot be used. Try a more specific name like "${s}-promo" or "${s}-2026".`,
      normalized: null,
    };
  }

  return { valid: true, error: null, normalized: s };
}

/**
 * Quick membership check. Used by the route handler as defense-in-depth -
 * if an attacker somehow slips a reserved path past validation (e.g., race
 * condition + stale cache), the runtime still refuses to serve it.
 */
function isReservedPath(s) {
  if (!s || typeof s !== 'string') return false;
  return RESERVED_PATHS.has(s.toLowerCase());
}

module.exports = {
  RESERVED_PATHS,
  validateRootPath,
  isReservedPath,
};
