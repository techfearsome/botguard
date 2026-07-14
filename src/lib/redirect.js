/**
 * redirect.js — helpers for REDIRECT campaigns: build the short "redirecting…"
 * interstitial, and write the dedicated RedirectLog entry.
 */

'use strict';

const logger = require('./logger');

// Escape a URL for safe embedding in an HTML attribute / JS string.
function escapeForHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Only allow http(s) destinations — never javascript:, data:, etc.
function isSafeRedirectUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

/**
 * Build the interstitial shown to clean traffic before the client-side
 * redirect. Keeps it minimal and no-JS-fallback friendly (meta refresh + link).
 */
function buildRedirectPage({ url, delayMs }) {
  const safeUrl = escapeForHtml(url);
  const delay = Math.max(0, parseInt(delayMs, 10) || 0);
  const secs = Math.ceil(delay / 1000);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta http-equiv="refresh" content="${secs};url=${safeUrl}">
<title>Redirecting…</title>
<style>
  html,body{height:100%;margin:0}
  body{display:flex;align-items:center;justify-content:center;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#0f1720;color:#e6edf3}
  .box{text-align:center}
  .spinner{width:34px;height:34px;border:3px solid #2a3949;border-top-color:#3b82f6;border-radius:50%;margin:0 auto 14px;animation:spin .8s linear infinite}
  @keyframes spin{to{transform:rotate(360deg)}}
  a{color:#3b82f6}
</style>
</head>
<body>
  <div class="box">
    <div class="spinner"></div>
    <div>Redirecting…</div>
    <noscript><p>If you are not redirected, <a href="${safeUrl}">click here</a>.</p></noscript>
  </div>
  <script>
    setTimeout(function(){ window.location.replace(${JSON.stringify(url)}); }, ${delay});
  </script>
</body>
</html>`;
}

/**
 * Write a RedirectLog entry from the click doc. Fire-and-forget; never throws.
 */
async function writeRedirectLog(doc, campaign, workspace, destinationUrl) {
  try {
    const { RedirectLog } = require('../models');
    await RedirectLog.create({
      workspace_id: workspace._id,
      campaign_id: campaign._id,
      click_id: doc.click_id,
      ts: doc.ts || new Date(),
      ip: doc.ip || '',
      ip_hash: doc.ip_hash || '',
      asn: typeof doc.asn === 'number' ? doc.asn : null,
      asn_org: doc.asn_org || '',
      country: doc.country || '',
      device_class: doc.ua_parsed?.device_class || '',
      user_agent: doc.user_agent || '',
      external_ids: doc.external_ids || {},
      destination_url: destinationUrl,
      delay_ms: campaign.redirect_delay_ms ?? 1500,
      decision: doc.decision || 'allow',
      decision_reason: doc.decision_reason || '',
      score_total: doc.scores?.total ?? 0,
    });
  } catch (err) {
    logger.error('redirect_log_failed', { err: err.message, click_id: doc.click_id });
  }
}

module.exports = { buildRedirectPage, writeRedirectLog, isSafeRedirectUrl };
