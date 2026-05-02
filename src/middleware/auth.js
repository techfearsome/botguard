const crypto = require('crypto');
const logger = require('../lib/logger');

/**
 * Authentication middleware.
 *
 * Two auth modes supported:
 *
 * 1. Cookie session for the admin panel UI.
 *    - User logs in at /admin/login with username + password
 *    - Successful login sets a signed cookie (HMAC of username+timestamp+secret)
 *    - All /admin routes require this cookie
 *
 * 2. Basic Auth or API key for programmatic access (postbacks, future API).
 *    - Basic Auth: same admin credentials
 *    - X-API-Key header: matches one of the workspace's stored api_keys
 *
 * Credentials come from env vars (ADMIN_USERNAME, ADMIN_PASSWORD).
 * Password is hashed with scrypt at startup so we never compare plaintext.
 *
 * The session cookie is HMAC-signed. Tampering invalidates it. No DB lookup needed
 * to validate a session - just verify the signature.
 */

const COOKIE_NAME = 'bg_admin';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;  // 7 days

let cachedPasswordHash = null;

function hashPassword(plaintext) {
  // scrypt with random salt, stored as `salt:hash`
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(plaintext, salt, 64);
  return salt.toString('hex') + ':' + hash.toString('hex');
}

function verifyPassword(plaintext, stored) {
  if (!stored || !plaintext) return false;
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  let actual;
  try {
    actual = crypto.scryptSync(plaintext, salt, 64);
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function getSessionSecret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) {
    throw new Error('SESSION_SECRET must be set to a string of at least 16 characters');
  }
  return s;
}

function signSession(username) {
  const ts = Date.now();
  const payload = `${username}.${ts}`;
  const sig = crypto
    .createHmac('sha256', getSessionSecret())
    .update(payload)
    .digest('hex');
  return `${payload}.${sig}`;
}

function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [username, tsStr, sig] = parts;
  const ts = Number(tsStr);
  if (!username || !ts || !sig) return null;
  if (Date.now() - ts > SESSION_TTL_MS) return null;

  const expected = crypto
    .createHmac('sha256', getSessionSecret())
    .update(`${username}.${tsStr}`)
    .digest('hex');

  // Constant-time compare
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

  return { username, ts };
}

function getStoredCredentials() {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  const passwordHash = process.env.ADMIN_PASSWORD_HASH;

  if (!username) return null;

  // Prefer hash if provided, otherwise hash the plaintext password once and cache
  if (passwordHash) {
    return { username, passwordHash };
  }
  if (password) {
    if (!cachedPasswordHash) cachedPasswordHash = hashPassword(password);
    return { username, passwordHash: cachedPasswordHash };
  }
  return null;
}

/**
 * Try to authenticate via Basic Auth header.
 * Returns true if header present and valid, false if invalid, null if no header (caller decides).
 */
function tryBasicAuth(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return null;

  const creds = getStoredCredentials();
  if (!creds) return false;

  let decoded;
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    return false;
  }
  const idx = decoded.indexOf(':');
  if (idx < 0) return false;
  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);
  if (user !== creds.username) return false;
  return verifyPassword(pass, creds.passwordHash);
}

/**
 * Express middleware: gate the admin panel.
 * - Skip /admin/login and /admin/logout
 * - Accept valid session cookie OR valid Basic Auth header
 * - Otherwise redirect to /admin/login (HTML) or 401 (API/JSON)
 */
function requireAdmin(req, res, next) {
  // Allow login/logout pages through
  if (req.path === '/login' || req.path === '/logout') return next();

  // Cookie session
  const cookieToken = req.cookies?.[COOKIE_NAME];
  const session = verifySession(cookieToken);
  if (session) {
    req.adminUser = session.username;
    return next();
  }

  // Basic Auth (useful for curl/API)
  const basic = tryBasicAuth(req);
  if (basic === true) {
    req.adminUser = 'basic-auth';
    return next();
  }

  // Not authenticated
  const acceptsHtml = (req.get('accept') || '').includes('text/html');
  if (acceptsHtml) {
    const next_url = encodeURIComponent(req.originalUrl);
    return res.redirect(`/admin/login?next=${next_url}`);
  }
  res.set('WWW-Authenticate', 'Basic realm="BotGuard Admin"');
  return res.status(401).json({ error: 'unauthorized' });
}

/**
 * Express middleware: gate API endpoints by X-API-Key header.
 * Looks up the key against Workspace.api_keys.
 */
async function requireApiKey(req, res, next) {
  const key = req.get('x-api-key') || req.query.api_key;
  if (!key) {
    return res.status(401).json({ error: 'missing_api_key' });
  }
  const { Workspace } = require('../models');
  const ws = await Workspace.findOne({ 'api_keys.key': key });
  if (!ws) {
    return res.status(403).json({ error: 'invalid_api_key' });
  }

  // Update last_used (fire and forget)
  Workspace.updateOne(
    { _id: ws._id, 'api_keys.key': key },
    { $set: { 'api_keys.$.last_used_at': new Date() } }
  ).catch(() => {});

  req.workspace = ws;
  req.apiKey = key;
  next();
}

// Login route handlers
function loginPage(req, res) {
  res.set('Cache-Control', 'private, no-store');
  res.set('CDN-Cache-Control', 'no-store');
  const error = req.query.error || null;
  const nextUrlRaw = typeof req.query.next === 'string' ? req.query.next : '/admin';
  // Only allow internal redirects (must start with /); otherwise send to /admin.
  const next_url = nextUrlRaw.startsWith('/') ? nextUrlRaw : '/admin';
  res.render('login', { error, next_url });
}

function loginSubmit(req, res) {
  const { username, password, next: nextUrl } = req.body || {};
  const creds = getStoredCredentials();

  if (!creds) {
    logger.error('login_no_credentials_configured');
    return res.redirect('/admin/login?error=invalid');
  }

  if (username !== creds.username || !verifyPassword(password, creds.passwordHash)) {
    logger.warn('login_failed', { username, ip: req.ip });
    return res.redirect('/admin/login?error=invalid');
  }

  const token = signSession(username);
  res.cookie(COOKIE_NAME, token, {
    maxAge: SESSION_TTL_MS,
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure || process.env.NODE_ENV === 'production',
  });

  logger.info('login_ok', { username, ip: req.ip });
  res.redirect(typeof nextUrl === 'string' && nextUrl.startsWith('/') ? nextUrl : '/admin');
}

function logout(req, res) {
  res.clearCookie(COOKIE_NAME);
  res.redirect('/admin/login');
}

function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

module.exports = {
  requireAdmin,
  requireApiKey,
  loginPage,
  loginSubmit,
  logout,
  // exported for tests / scripts
  hashPassword,
  verifyPassword,
  signSession,
  verifySession,
};
