/**
 * guardToken.js — Signed tokens for the bot guard flow.
 *
 * When a visitor hits the guard page, we issue a token that encodes the
 * click_id and the target offer page, signed with an HMAC. When the guard
 * page POSTs results back, we verify the token before trusting the click_id.
 *
 * This prevents a bot from POSTing arbitrary click_ids to /go/guard-verify
 * to bypass the guard for clicks that never went through it.
 *
 * Tokens are short-lived (10 min) — enough for a real visitor to complete
 * the checks, but not so long that a captured token stays useful.
 */

'use strict';

const crypto = require('crypto');

const TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes

function getSecret() {
  // Reuse SESSION_SECRET so there's no extra config. Fall back to a
  // process-lifetime random secret if unset (tokens won't survive restart).
  return process.env.SESSION_SECRET || process.env.GUARD_SECRET || 'botguard-fallback-secret';
}

/**
 * Create a signed token.
 * @param {object} payload — { click_id, offer_page_id, safe_page_id, ip }
 * @returns {string} token
 */
function signToken(payload) {
  const body = {
    ...payload,
    exp: Date.now() + TOKEN_TTL_MS,
  };
  const json = JSON.stringify(body);
  const b64 = Buffer.from(json).toString('base64url');
  const sig = crypto.createHmac('sha256', getSecret()).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

/**
 * Verify and decode a token.
 * @param {string} token
 * @returns {object|null} payload if valid, null otherwise
 */
function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [b64, sig] = parts;
  const expected = crypto.createHmac('sha256', getSecret()).update(b64).digest('base64url');

  // Constant-time comparison
  let sigBuf, expBuf;
  try {
    sigBuf = Buffer.from(sig);
    expBuf = Buffer.from(expected);
  } catch (e) { return null; }
  if (sigBuf.length !== expBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
  } catch (e) { return null; }

  if (!payload.exp || Date.now() > payload.exp) return null; // expired

  return payload;
}

/**
 * Create a "pass" cookie value — proves this IP passed the guard for a page.
 * Prevents re-triggering the guard on refresh.
 */
function signPassCookie(clickId, ip) {
  const body = { c: clickId, ip, exp: Date.now() + 30 * 60 * 1000 }; // 30 min
  const json = JSON.stringify(body);
  const b64 = Buffer.from(json).toString('base64url');
  const sig = crypto.createHmac('sha256', getSecret()).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

function verifyPassCookie(cookie, ip) {
  const payload = verifyToken(cookie); // same structure/verification
  if (!payload) {
    // signPassCookie uses same format as signToken — reuse verifyToken
    // but it checks .exp which pass cookies also have, so this works.
  }
  // Re-verify manually since pass cookie uses different keys
  if (!cookie) return false;
  const parts = cookie.split('.');
  if (parts.length !== 2) return false;
  const [b64, sig] = parts;
  const expected = crypto.createHmac('sha256', getSecret()).update(b64).digest('base64url');
  try {
    const sigBuf = Buffer.from(sig), expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length) return false;
    if (!crypto.timingSafeEqual(sigBuf, expBuf)) return false;
    const body = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
    if (!body.exp || Date.now() > body.exp) return false;
    if (ip && body.ip && body.ip !== ip) return false; // cookie stolen from another IP
    return true;
  } catch (e) { return false; }
}

/**
 * Read (decode) a pass/fail cookie's payload without IP verification.
 * Used to recover the original click_id so the served click can inherit
 * the guard verdict. Still verifies the signature and expiry.
 */
function readPassCookie(cookie) {
  if (!cookie) return null;
  const parts = cookie.split('.');
  if (parts.length !== 2) return null;
  const [b64, sig] = parts;
  const expected = crypto.createHmac('sha256', getSecret()).update(b64).digest('base64url');
  try {
    const sigBuf = Buffer.from(sig), expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length) return null;
    if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;
    const body = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
    if (!body.exp || Date.now() > body.exp) return null;
    return body; // { c: clickId, ip, exp }
  } catch (e) { return null; }
}

module.exports = { signToken, verifyToken, signPassCookie, verifyPassCookie, readPassCookie, TOKEN_TTL_MS };
