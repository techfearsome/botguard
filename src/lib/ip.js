const crypto = require('crypto');

/**
 * Get the real client IP, respecting trust proxy settings.
 * Express's req.ip already handles X-Forwarded-For when trust proxy is set.
 * We add Cloudflare's CF-Connecting-IP as the highest-priority override.
 */
function getClientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (cf && typeof cf === 'string') return cf.trim();

  const real = req.headers['x-real-ip'];
  if (real && typeof real === 'string') return real.trim();

  return req.ip || req.connection?.remoteAddress || null;
}

function hashIp(ip) {
  if (!ip) return null;
  return crypto.createHash('sha256').update(ip).digest('hex').slice(0, 32);
}

module.exports = { getClientIp, hashIp };
